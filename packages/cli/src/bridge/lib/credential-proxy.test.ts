/**
 * Tests for the bridge daemon's local credential proxy (issue #318).
 *
 * The load-bearing assertions here are the SECURITY ones — that a resolved
 * token reaches the upstream request and nowhere else. Every test uses an
 * obviously-fake token; never put a real credential in this file.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalCredentialProxy,
  buildGitConfig,
  parseTarget,
  prepareGitConfig,
} from "./credential-proxy.js";

const FAKE_TOKEN = "fake-token-not-a-real-credential";

/** Upstream that echoes back what it received, so we can assert injection. */
function startUpstream(): Promise<{ url: string; host: string; seen: IncomingMessage[]; close: () => Promise<void> }> {
  const seen: IncomingMessage[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(req);
    if (req.url === "/redirect") {
      const addr = server.address() as AddressInfo;
      res.writeHead(302, { location: `http://127.0.0.1:${addr.port}/after` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startProxy(resolve: (host: string) => Promise<string | null>, log?: (m: string) => void) {
  const proxy = new LocalCredentialProxy({ resolve, log });
  await proxy.start();
  cleanups.push(() => proxy.stop());
  return proxy;
}

describe("parseTarget", () => {
  it("accepts the forward-proxy absolute form", () => {
    const t = parseTarget("http://api.github.com/user?a=1");
    expect(t).toMatchObject({ protocol: "http:", hostname: "api.github.com", path: "/user?a=1", reverse: false });
  });

  it("accepts the reverse form used by the git insteadOf rewrite", () => {
    const t = parseTarget("/__oma_outbound/https/github.com/acme/widgets.git/info/refs?service=git-upload-pack");
    expect(t).toMatchObject({
      protocol: "https:",
      hostname: "github.com",
      path: "/acme/widgets.git/info/refs?service=git-upload-pack",
      reverse: true,
    });
  });

  it("rejects an origin-form path and a bogus scheme", () => {
    expect(parseTarget("/user")).toBeNull();
    expect(parseTarget("/__oma_outbound/ftp/example.com/x")).toBeNull();
  });
});

describe("URL → credential matching", () => {
  it("injects the resolved bearer on a matching host", async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);
    const proxy = await startProxy(async (host) => (host === "127.0.0.1" ? FAKE_TOKEN : null));

    const res = await fetch(`${proxy.baseUrl}/__oma_outbound/http/${upstream.host}/thing`);
    expect(res.status).toBe(200);
    expect(upstream.seen.at(-1)?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("passes a non-matching host through with no auth header", async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);
    // Resolver matches only github.com, so the upstream host misses.
    const proxy = await startProxy(async (host) => (host === "github.com" ? FAKE_TOKEN : null));

    const res = await fetch(`${proxy.baseUrl}/__oma_outbound/http/${upstream.host}/thing`);
    expect(res.status).toBe(200);
    expect(upstream.seen.at(-1)?.headers.authorization).toBeUndefined();
  });

  it("keeps a redirect on the proxy so injection survives it", async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);
    const proxy = await startProxy(async () => FAKE_TOKEN);

    const res = await fetch(`${proxy.baseUrl}/__oma_outbound/http/${upstream.host}/redirect`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${proxy.baseUrl}/__oma_outbound/http/${upstream.host}/after`,
    );
  });

  it("caches a lookup instead of asking the platform per request", async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);
    let calls = 0;
    const proxy = await startProxy(async () => {
      calls += 1;
      return FAKE_TOKEN;
    });

    await fetch(`${proxy.baseUrl}/__oma_outbound/http/${upstream.host}/a`);
    await fetch(`${proxy.baseUrl}/__oma_outbound/http/${upstream.host}/b`);
    expect(calls).toBe(1);
  });
});

describe("unresolvable credential (documented fail-open policy)", () => {
  it("forwards the request un-injected and logs the failure without the token", async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);
    const logs: string[] = [];
    const proxy = await startProxy(async () => {
      throw new Error("platform unreachable");
    }, (m) => logs.push(m));

    const res = await fetch(`${proxy.baseUrl}/__oma_outbound/http/${upstream.host}/thing`);
    // Fail OPEN: the request still reaches upstream, just without injection.
    expect(res.status).toBe(200);
    expect(upstream.seen.at(-1)?.headers.authorization).toBeUndefined();
    expect(logs.join("\n")).toContain("WITHOUT injection");
    expect(logs.join("\n")).toContain("platform unreachable");
  });
});

describe("the token never leaves the proxy's memory", () => {
  it("is absent from every log line, including successful injections", async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);
    const logs: string[] = [];
    const proxy = await startProxy(async () => FAKE_TOKEN, (m) => logs.push(m));

    await fetch(`${proxy.baseUrl}/__oma_outbound/http/${upstream.host}/thing`);
    // Force an upstream error path too — error logging is where secrets leak.
    await upstream.close();
    cleanups.pop();
    await fetch(`${proxy.baseUrl}/__oma_outbound/http/${upstream.host}/gone`).catch(() => {});

    expect(logs.join("\n")).not.toContain(FAKE_TOKEN);
  });

  it("is absent from the env vars handed to a relayed subprocess", async () => {
    const proxy = await startProxy(async () => FAKE_TOKEN);
    const env = proxy.envVars();
    expect(env.HTTP_PROXY).toBe(proxy.baseUrl);
    expect(Object.values(env).join("\n")).not.toContain(FAKE_TOKEN);
  });

  it("is absent from the generated git config written to disk", async () => {
    const proxy = await startProxy(async () => FAKE_TOKEN);
    const dir = mkdtempSync(join(tmpdir(), "oma-credproxy-"));

    const env = await prepareGitConfig(proxy, dir, ["github.com"]);
    expect(env.GIT_CONFIG_GLOBAL).toBe(join(dir, ".oma-gitconfig"));
    const contents = readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8");
    expect(contents).toContain(`insteadOf = https://github.com/`);
    expect(contents).toContain(proxy.reverseBase("https", "github.com"));
    expect(contents).not.toContain(FAKE_TOKEN);
  });
});

describe("git config generation", () => {
  it("leaves git untouched when no host has a credential", async () => {
    const proxy = await startProxy(async () => null);
    const dir = mkdtempSync(join(tmpdir(), "oma-credproxy-"));

    // No rewrite => the machine's own credential helper keeps working, which
    // is exactly the pre-#318 behavior for users with no vault credential.
    expect(await prepareGitConfig(proxy, dir, ["github.com"])).toEqual({});
    expect(buildGitConfig(proxy, [])).toBeNull();
  });

  it("includes the user's real ~/.gitconfig so identity/helpers survive", async () => {
    const proxy = await startProxy(async () => FAKE_TOKEN);
    const contents = buildGitConfig(proxy, ["github.com"])!;
    expect(contents).toContain("[include]");
    expect(contents).toContain(".gitconfig");
  });
});
