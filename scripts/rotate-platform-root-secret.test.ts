import { beforeEach, describe, expect, it, vi } from "vitest";

import { WebCryptoAesGcm } from "../packages/integrations-adapters-cf/src/crypto";
import {
  FEDERATION_LABEL,
  INTEGRATIONS_DB_COLUMNS,
  INTEGRATIONS_LABEL,
  rekeyFederationKv,
  rotateColumn,
} from "./rotate-platform-root-secret";

const OLD_SECRET = "old-secret-padded-to-thirty-two-bytes!!";
const NEW_SECRET = "new-secret-padded-to-thirty-two-bytes!!";
const LABEL = "credentials.auth";

/**
 * In-memory fake of the D1 HTTP API surface this script talks to. Backs a
 * single table `{ id, auth }`; supports exactly the four query shapes
 * `rotateColumn`/`rotateRow` issue (keyset-paginated SELECT, follow-on
 * WHERE id > ? SELECT, CAS UPDATE, single-row re-SELECT).
 */
class FakeD1 {
  /** id -> cipher. A `null` models a NULL cipher column (optional secret). */
  rows = new Map<string, string | null>();

  /** Table/column this fake answers for — matches whatever the test rotates. */
  constructor(
    readonly table = "credentials",
    readonly column = "auth",
  ) {}

  async handle(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    const s = sql.replace(/\s+/g, " ").trim();
    const { table: t, column: c } = this;

    if (s.startsWith(`SELECT ${c} AS value FROM ${t} WHERE id = ?`)) {
      const [id] = params as [string];
      return this.rows.has(id) ? [{ value: this.rows.get(id) }] : [];
    }
    // Keyset page 2+. The `IS NOT NULL` predicate is part of the real query;
    // matching it here is what keeps this fake honest about NULL filtering.
    if (
      s.startsWith(
        `SELECT id AS id, ${c} AS value FROM ${t} WHERE ${c} IS NOT NULL AND id > ?`,
      )
    ) {
      const [afterId, limit] = params as [string, number];
      return this.pageAfter(afterId, limit);
    }
    if (
      s.startsWith(
        `SELECT id AS id, ${c} AS value FROM ${t} WHERE ${c} IS NOT NULL ORDER BY id LIMIT ?`,
      )
    ) {
      const [limit] = params as [number];
      return this.pageAfter(null, limit);
    }
    if (s.startsWith(`UPDATE ${t} SET ${c} = ? WHERE id = ? AND ${c} = ?`)) {
      const [newValue, id, expectedOld] = params as [string, string, string];
      if (this.rows.get(id) === expectedOld) {
        this.rows.set(id, newValue);
      }
      // D1's real API doesn't return affected-row info on this path; the
      // script re-selects afterward, so this handler intentionally mirrors
      // that (no info returned here).
      return [];
    }
    throw new Error(`FakeD1: unhandled SQL: ${s}`);
  }

  private pageAfter(afterId: string | null, limit: number): Array<Record<string, unknown>> {
    // Mirror `WHERE <col> IS NOT NULL`: NULL rows are never returned at all.
    const ids = [...this.rows.keys()].filter((id) => this.rows.get(id) !== null).sort();
    const start = afterId === null ? 0 : ids.findIndex((id) => id > afterId);
    return ids
      .slice(start === -1 ? ids.length : start, (start === -1 ? ids.length : start) + limit)
      .map((id) => ({ id, value: this.rows.get(id) }));
  }
}

let fakeDb: FakeD1;

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { sql: string; params: unknown[] };
      const results = await fakeDb.handle(body.sql, body.params);
      return new Response(
        JSON.stringify({ success: true, result: [{ results }] }),
      );
    }),
  );
}

async function seedRow(id: string, plaintext: string, crypto: WebCryptoAesGcm) {
  fakeDb.rows.set(id, await crypto.encrypt(plaintext));
}

function baseOpts(overrides: Partial<Parameters<typeof rotateColumn>[0]> = {}) {
  return {
    accountId: "acct",
    token: "tok",
    dbId: "db",
    table: "credentials",
    idColumn: "id",
    cipherColumn: "auth",
    oldCrypto: new WebCryptoAesGcm(OLD_SECRET, LABEL),
    newCrypto: new WebCryptoAesGcm(NEW_SECRET, LABEL),
    pageSize: 200,
    dryRun: false,
    continueOnError: false,
    ...overrides,
  };
}

describe("rotate-platform-root-secret", () => {
  beforeEach(() => {
    fakeDb = new FakeD1();
    installFetchMock();
  });

  it("round-trips: old-key decrypt -> new-key encrypt -> new-key decrypt == original plaintext", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, LABEL);
    await seedRow("cred_1", "super-secret-token-value", oldCrypto);

    const result = await rotateColumn(baseOpts());

    expect(result.rotated).toBe(1);
    expect(result.failures).toHaveLength(0);

    const rotatedCipher = fakeDb.rows.get("cred_1")!;
    // The rotated ciphertext is unreadable under OLD ...
    await expect(oldCrypto.decrypt(rotatedCipher)).rejects.toThrow();
    // ... and decrypts to the exact original plaintext under NEW.
    await expect(newCrypto.decrypt(rotatedCipher)).resolves.toBe(
      "super-secret-token-value",
    );
  });

  it("is idempotent: running rotation twice does not corrupt or double-encrypt", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, LABEL);
    await seedRow("cred_1", "value-one", oldCrypto);
    await seedRow("cred_2", "value-two", oldCrypto);

    const first = await rotateColumn(baseOpts());
    expect(first.rotated).toBe(2);
    expect(first.alreadyRotated).toBe(0);

    const cipherAfterFirst1 = fakeDb.rows.get("cred_1");
    const cipherAfterFirst2 = fakeDb.rows.get("cred_2");

    const second = await rotateColumn(baseOpts());
    expect(second.rotated).toBe(0);
    expect(second.alreadyRotated).toBe(2);
    expect(second.failures).toHaveLength(0);

    // Ciphertext is untouched by the second pass — no double-encryption.
    expect(fakeDb.rows.get("cred_1")).toBe(cipherAfterFirst1);
    expect(fakeDb.rows.get("cred_2")).toBe(cipherAfterFirst2);

    await expect(newCrypto.decrypt(fakeDb.rows.get("cred_1")!)).resolves.toBe("value-one");
    await expect(newCrypto.decrypt(fakeDb.rows.get("cred_2")!)).resolves.toBe("value-two");
  });

  it("resumes correctly after an interrupted run (partial rotation, then finish)", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, LABEL);
    await seedRow("cred_1", "alpha", oldCrypto);
    await seedRow("cred_2", "beta", oldCrypto);
    await seedRow("cred_3", "gamma", oldCrypto);

    // Simulate "interruption": manually rotate only the first row, as if a
    // previous run got partway through and crashed.
    fakeDb.rows.set("cred_1", await newCrypto.encrypt("alpha"));

    const resumed = await rotateColumn(baseOpts());
    expect(resumed.alreadyRotated).toBe(1); // cred_1, detected via try-NEW-first
    expect(resumed.rotated).toBe(2); // cred_2, cred_3

    for (const [id, plaintext] of [
      ["cred_1", "alpha"],
      ["cred_2", "beta"],
      ["cred_3", "gamma"],
    ] as const) {
      await expect(newCrypto.decrypt(fakeDb.rows.get(id)!)).resolves.toBe(plaintext);
    }
  });

  it("dry-run reports counts but writes nothing", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    await seedRow("cred_1", "untouched-value", oldCrypto);
    const cipherBefore = fakeDb.rows.get("cred_1");

    const result = await rotateColumn(baseOpts({ dryRun: true }));

    expect(result.wouldRotate).toBe(1);
    expect(result.rotated).toBe(0);
    // Ciphertext identical to what was seeded — no write occurred.
    expect(fakeDb.rows.get("cred_1")).toBe(cipherBefore);
    await expect(oldCrypto.decrypt(fakeDb.rows.get("cred_1")!)).resolves.toBe(
      "untouched-value",
    );
  });

  it("aborts loudly (default) on a row undecryptable under either key, without touching later rows", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const wrongKeyCrypto = new WebCryptoAesGcm("totally-different-key-not-old-or-new!!", LABEL);
    // cred_1 encrypted with neither OLD nor NEW — simulates a bad/wrong old
    // secret being supplied, or a corrupt row.
    await seedRow("cred_1", "corrupt-or-wrong-key", wrongKeyCrypto);
    await seedRow("cred_2", "would-have-rotated-fine", oldCrypto);

    const result = await rotateColumn(baseOpts());

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe("cred_1");
    // Fails loud: cred_2 (which sorts after cred_1 and would decrypt fine)
    // must NOT have been rotated — the default behavior stops the run
    // rather than silently skipping the bad row and continuing.
    expect(result.rotated).toBe(0);
    await expect(oldCrypto.decrypt(fakeDb.rows.get("cred_2")!)).resolves.toBe(
      "would-have-rotated-fine",
    );
  });

  it("--continue-on-error collects failures but still rotates the decryptable rows", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, LABEL);
    const wrongKeyCrypto = new WebCryptoAesGcm("totally-different-key-not-old-or-new!!", LABEL);
    await seedRow("cred_1", "bad-row", wrongKeyCrypto);
    await seedRow("cred_2", "good-row", oldCrypto);

    const result = await rotateColumn(baseOpts({ continueOnError: true }));

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe("cred_1");
    expect(result.rotated).toBe(1);
    await expect(newCrypto.decrypt(fakeDb.rows.get("cred_2")!)).resolves.toBe("good-row");
  });

  it("detects a concurrent write during rotation as a conflict instead of clobbering it", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    await seedRow("cred_1", "will-race", oldCrypto);

    const realFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // Simulate a live write landing on this exact row between our read and
    // our CAS write, by mutating the fake table out from under the UPDATE.
    let updateSeen = false;
    vi.mocked(realFetch).mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { sql: string; params: unknown[] };
      if (body.sql.includes("UPDATE") && !updateSeen) {
        updateSeen = true;
        // A concurrent writer changes the row to something else first.
        fakeDb.rows.set("cred_1", await oldCrypto.encrypt("raced-value"));
      }
      const results = await fakeDb.handle(body.sql, body.params);
      return new Response(JSON.stringify({ success: true, result: [{ results }] }));
    });

    const result = await rotateColumn(baseOpts());

    expect(result.conflicts).toBe(1);
    expect(result.rotated).toBe(0);
    // The racing writer's value must survive untouched.
    await expect(oldCrypto.decrypt(fakeDb.rows.get("cred_1")!)).resolves.toBe("raced-value");
  });
});

describe("rotate-platform-root-secret: nullable + legacy rows", () => {
  beforeEach(() => {
    fakeDb = new FakeD1();
    installFetchMock();
  });

  it("ignores NULL cipher columns instead of counting them as failures", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, LABEL);
    await seedRow("cred_1", "has-a-secret", oldCrypto);
    // Most integrations cipher columns are nullable (refresh_token_cipher,
    // signing_secret_cipher, ...). NULL means "no secret stored" — it must
    // never reach the decrypt path and must never abort the run.
    fakeDb.rows.set("cred_2", null);
    await seedRow("cred_3", "also-has-a-secret", oldCrypto);

    const result = await rotateColumn(baseOpts());

    expect(result.failures).toHaveLength(0);
    expect(result.rotated).toBe(2);
    expect(result.scanned).toBe(2); // the NULL row was filtered out in SQL
    expect(fakeDb.rows.get("cred_2")).toBeNull(); // left untouched
    await expect(newCrypto.decrypt(fakeDb.rows.get("cred_1")!)).resolves.toBe("has-a-secret");
    await expect(newCrypto.decrypt(fakeDb.rows.get("cred_3")!)).resolves.toBe(
      "also-has-a-secret",
    );
  });

  it("leaves pre-encryption legacy plaintext rows untouched rather than aborting", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, LABEL);
    // Rows written before at-rest encryption hold verbatim JSON. The runtime
    // reads these back unchanged under any root secret, so rotation must not
    // treat them as corrupt (which would block rotation on the whole shard).
    const legacy = JSON.stringify({ type: "static_bearer", token: "legacy-plain" });
    fakeDb.rows.set("cred_1", legacy);
    await seedRow("cred_2", "encrypted-value", oldCrypto);

    const result = await rotateColumn(baseOpts());

    expect(result.failures).toHaveLength(0);
    expect(result.legacyPlaintext).toBe(1);
    expect(result.rotated).toBe(1);
    // Byte-identical: not re-encrypted, not rewritten.
    expect(fakeDb.rows.get("cred_1")).toBe(legacy);
    await expect(newCrypto.decrypt(fakeDb.rows.get("cred_2")!)).resolves.toBe("encrypted-value");
  });
});

describe("rotate-platform-root-secret: integrations.tokens purpose", () => {
  it("covers all 21 integrations cipher columns across the 9 tables that have them", () => {
    // Guards against a column being added to the integrations schema without
    // being added here — a missed column is silently unreadable after a flip.
    expect(INTEGRATIONS_DB_COLUMNS).toHaveLength(21);
    expect(new Set(INTEGRATIONS_DB_COLUMNS.map((c) => c.table))).toEqual(
      new Set([
        "linear_apps",
        "linear_installations",
        "linear_publications",
        "github_apps",
        "github_installations",
        "github_publications",
        "slack_apps",
        "slack_installations",
        "slack_publications",
      ]),
    );
  });

  it("round-trips a github_installations access token under the integrations label", async () => {
    fakeDb = new FakeD1("github_installations", "access_token_cipher");
    installFetchMock();
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, INTEGRATIONS_LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, INTEGRATIONS_LABEL);
    fakeDb.rows.set("ghi_1", await oldCrypto.encrypt("ghs_installation_token"));

    const result = await rotateColumn(
      baseOpts({
        table: "github_installations",
        cipherColumn: "access_token_cipher",
        oldCrypto,
        newCrypto,
      }),
    );

    expect(result.rotated).toBe(1);
    expect(result.failures).toHaveLength(0);
    await expect(newCrypto.decrypt(fakeDb.rows.get("ghi_1")!)).resolves.toBe(
      "ghs_installation_token",
    );
    // A credentials-label key must NOT be able to read an integrations row —
    // this is the whole point of per-subsystem label derivation.
    const wrongLabel = new WebCryptoAesGcm(NEW_SECRET, "credentials.auth");
    await expect(wrongLabel.decrypt(fakeDb.rows.get("ghi_1")!)).rejects.toThrow();
  });
});

/**
 * In-memory fake of the three CF KV REST endpoints `rekeyFederationKv` uses:
 * list-keys-by-prefix (cursor-paginated), get-value, put-value.
 */
class FakeKv {
  store = new Map<string, string>();

  install() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        if (u.pathname.endsWith("/keys")) {
          const prefix = u.searchParams.get("prefix") ?? "";
          const names = [...this.store.keys()]
            .filter((k) => k.startsWith(prefix))
            .sort()
            .map((name) => ({ name }));
          return new Response(JSON.stringify({ success: true, result: names, result_info: {} }));
        }
        const key = decodeURIComponent(u.pathname.split("/values/")[1]!);
        if (init?.method === "PUT") {
          this.store.set(key, init.body as string);
          return new Response("", { status: 200 });
        }
        if (!this.store.has(key)) return new Response("", { status: 404 });
        return new Response(this.store.get(key)!, { status: 200 });
      }),
    );
  }
}

function fedOpts(kvOverrides: Partial<Parameters<typeof rekeyFederationKv>[0]> = {}) {
  return {
    accountId: "acct",
    token: "tok",
    namespaceId: "ns",
    oldCrypto: new WebCryptoAesGcm(OLD_SECRET, FEDERATION_LABEL),
    newCrypto: new WebCryptoAesGcm(NEW_SECRET, FEDERATION_LABEL),
    dryRun: false,
    continueOnError: false,
    ...kvOverrides,
  };
}

describe("rotate-platform-root-secret: federation.api_key purpose (KV)", () => {
  let kv: FakeKv;

  beforeEach(() => {
    kv = new FakeKv();
    kv.install();
  });

  async function seedFed(id: string, apiKey: string | null, crypto: WebCryptoAesGcm) {
    kv.store.set(
      `federation:tn_1:${id}`,
      JSON.stringify({
        id,
        tenant_id: "tn_1",
        name: id,
        base_url: "https://remote.example.com",
        created_at: 1,
        ...(apiKey === null ? {} : { api_key_enc: await crypto.encrypt(apiKey) }),
      }),
    );
  }

  it("round-trips a federation API key and preserves every other field", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, FEDERATION_LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, FEDERATION_LABEL);
    await seedFed("fed_1", "omak_remote_tenant_key", oldCrypto);

    const result = await rekeyFederationKv(fedOpts());

    expect(result.rotated).toBe(1);
    expect(result.failures).toHaveLength(0);

    const row = JSON.parse(kv.store.get("federation:tn_1:fed_1")!);
    await expect(newCrypto.decrypt(row.api_key_enc)).resolves.toBe("omak_remote_tenant_key");
    await expect(oldCrypto.decrypt(row.api_key_enc)).rejects.toThrow();
    // Non-secret fields must survive the rewrite verbatim.
    expect(row.base_url).toBe("https://remote.example.com");
    expect(row.tenant_id).toBe("tn_1");
    expect(row.created_at).toBe(1);
  });

  it("is idempotent: a second pass is a no-op", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, FEDERATION_LABEL);
    await seedFed("fed_1", "key-one", oldCrypto);

    const first = await rekeyFederationKv(fedOpts());
    expect(first.rotated).toBe(1);
    const afterFirst = kv.store.get("federation:tn_1:fed_1");

    const second = await rekeyFederationKv(fedOpts());
    expect(second.rotated).toBe(0);
    expect(second.alreadyRotated).toBe(1);
    expect(second.failures).toHaveLength(0);
    expect(kv.store.get("federation:tn_1:fed_1")).toBe(afterFirst);
  });

  it("dry-run writes nothing", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, FEDERATION_LABEL);
    await seedFed("fed_1", "untouched", oldCrypto);
    const before = kv.store.get("federation:tn_1:fed_1");

    const result = await rekeyFederationKv(fedOpts({ dryRun: true }));

    expect(result.wouldRotate).toBe(1);
    expect(result.rotated).toBe(0);
    expect(kv.store.get("federation:tn_1:fed_1")).toBe(before);
  });

  it("skips rows registered without an API key", async () => {
    await seedFed("fed_1", null, new WebCryptoAesGcm(OLD_SECRET, FEDERATION_LABEL));
    const result = await rekeyFederationKv(fedOpts());
    expect(result.noKey).toBe(1);
    expect(result.rotated).toBe(0);
    expect(result.failures).toHaveLength(0);
  });

  it("aborts and writes nothing when a row cannot be decrypted under the old secret", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, FEDERATION_LABEL);
    const wrongKey = new WebCryptoAesGcm("a-third-unrelated-secret-value!!", FEDERATION_LABEL);
    await seedFed("fed_1", "corrupt-row", wrongKey);
    await seedFed("fed_2", "would-be-fine", oldCrypto);
    const before1 = kv.store.get("federation:tn_1:fed_1");
    const before2 = kv.store.get("federation:tn_1:fed_2");

    const result = await rekeyFederationKv(fedOpts());

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe("federation:tn_1:fed_1");
    expect(result.rotated).toBe(0);
    // Store completely unmodified — fed_2 sorts after fed_1 and would have
    // rotated fine, but the abort must stop before touching it.
    expect(kv.store.get("federation:tn_1:fed_1")).toBe(before1);
    expect(kv.store.get("federation:tn_1:fed_2")).toBe(before2);
  });
});

describe("rotate-platform-root-secret: never logs plaintext or the root secret", () => {
  it("keeps secrets out of stdout/stderr across D1 and KV passes, success and failure", async () => {
    const PLAINTEXT = "pl4int3xt-must-never-be-logged";
    const captured: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a) => {
      captured.push(a.join(" "));
    });
    const err = vi.spyOn(console, "error").mockImplementation((...a) => {
      captured.push(a.join(" "));
    });

    try {
      // D1 pass: one good row and one undecryptable row (the failure path
      // formats an error message — that message must not leak either).
      fakeDb = new FakeD1();
      installFetchMock();
      const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
      const wrongKey = new WebCryptoAesGcm("a-third-unrelated-secret-value!!", LABEL);
      fakeDb.rows.set("cred_1", await oldCrypto.encrypt(PLAINTEXT));
      fakeDb.rows.set("cred_2", await wrongKey.encrypt(PLAINTEXT));
      await rotateColumn(baseOpts({ continueOnError: true }));

      // KV pass, same shape.
      const kv = new FakeKv();
      kv.install();
      const fedOld = new WebCryptoAesGcm(OLD_SECRET, FEDERATION_LABEL);
      kv.store.set(
        "federation:tn_1:fed_1",
        JSON.stringify({
          id: "fed_1",
          tenant_id: "tn_1",
          base_url: "https://remote.example.com",
          api_key_enc: await fedOld.encrypt(PLAINTEXT),
        }),
      );
      await rekeyFederationKv(fedOpts({ continueOnError: true }));

      const all = captured.join("\n");
      expect(all).not.toContain(PLAINTEXT);
      expect(all).not.toContain(OLD_SECRET);
      expect(all).not.toContain(NEW_SECRET);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
