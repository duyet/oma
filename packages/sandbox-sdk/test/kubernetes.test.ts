// Unit tests for KubernetesSandboxExecutor with `@kubernetes/client-node`
// fully mocked — no real cluster involved. Exercises:
//   - Sandbox object creation + naming
//   - Ready-condition polling -> pod resolution -> pods/exec exit codes
//   - env/secret shell-prefixing
//   - readFile/writeFileBytes via the base64-over-exec channel
//   - destroy() independent of whether the pod ever became ready
//   - mountMemoryStore's clear error when no S3 bucket config is present
//
// The mock mirrors the real @kubernetes/client-node v1.x shapes the
// adapter depends on: object-parameter CustomObjectsApi/CoreV1Api methods,
// and Exec.exec()'s positional-args + statusCallback(V1Status) contract.

import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeExecStatus {
  status?: string;
  details?: { causes?: Array<{ reason?: string; message?: string }> };
}
type StatusCallback = (status: FakeExecStatus) => void;

interface FakeSandboxObject {
  metadata: { name: string; namespace: string; annotations?: Record<string, string> };
  status: { conditions: Array<{ type: string; status: string }>; selector?: string };
}

// Shared mutable test state the mocked module + assertions both reach into.
const world = {
  sandboxObjects: new Map<string, FakeSandboxObject>(),
  /** Controls what the next exec() call returns. Overridable per-test. */
  execResult: { stdout: "", stderr: "", exitCode: 0 } as {
    stdout: string;
    stderr: string;
    exitCode: number;
  },
  /** Captures every argv passed to Exec.exec, in call order. */
  execCalls: [] as string[][],
  createCalls: [] as Array<{ namespace: string; name: string; body: unknown }>,
  deleteCalls: [] as Array<{ namespace: string; name: string }>,
  /** When true, newly created Sandbox objects report Ready=False so
   *  waitForReady's poll loop never matches — used to exercise the
   *  ready-timeout error path. Reset in beforeEach. */
  forceNotReady: false,
  /** Names that deleteNamespacedCustomObject should reject with an error —
   *  used to exercise sweepOrphanedSandboxes' per-item error handling. */
  failDeleteNames: new Set<string>(),
};

vi.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromCluster(): void {}
    loadFromDefault(): void {}
    makeApiClient<T>(Ctor: new () => T): T {
      return new Ctor();
    }
  }

  class CustomObjectsApi {
    async createNamespacedCustomObject(args: {
      namespace: string;
      body: { metadata: { name: string; namespace: string } };
    }) {
      const { namespace, body } = args;
      world.createCalls.push({ namespace, name: body.metadata.name, body });
      world.sandboxObjects.set(`${namespace}/${body.metadata.name}`, {
        metadata: body.metadata,
        status: {
          conditions: [{ type: "Ready", status: world.forceNotReady ? "False" : "True" }],
          selector: "",
        },
      });
      return {};
    }
    async getNamespacedCustomObject(args: { namespace: string; name: string }) {
      const obj = world.sandboxObjects.get(`${args.namespace}/${args.name}`);
      if (!obj) throw new Error(`Sandbox ${args.namespace}/${args.name} not found`);
      return obj;
    }
    async deleteNamespacedCustomObject(args: { namespace: string; name: string }) {
      if (world.failDeleteNames.has(args.name)) {
        throw new Error("delete failed");
      }
      world.deleteCalls.push({ namespace: args.namespace, name: args.name });
      world.sandboxObjects.delete(`${args.namespace}/${args.name}`);
      return {};
    }
    async listNamespacedCustomObject(args: { namespace: string }) {
      const items = [...world.sandboxObjects.entries()]
        .filter(([key]) => key.startsWith(`${args.namespace}/`))
        .map(([, obj]) => obj);
      return { items };
    }
  }

  class CoreV1Api {
    async listNamespacedPod() {
      return { items: [] };
    }
  }

  class Exec {
    async exec(
      _namespace: string,
      _podName: string,
      _containerName: string,
      argv: string[],
      stdout: NodeJS.WritableStream | null,
      stderr: NodeJS.WritableStream | null,
      _stdin: unknown,
      _tty: boolean,
      statusCallback?: StatusCallback,
    ) {
      world.execCalls.push(argv);
      const { stdout: out, stderr: err, exitCode } = world.execResult;
      await new Promise<void>((resolve) => {
        if (out && stdout) stdout.write(Buffer.from(out), () => resolve());
        else resolve();
      });
      await new Promise<void>((resolve) => {
        if (err && stderr) stderr.write(Buffer.from(err), () => resolve());
        else resolve();
      });
      if (exitCode === 0) {
        statusCallback?.({ status: "Success" });
      } else {
        statusCallback?.({
          status: "Failure",
          details: { causes: [{ reason: "ExitCode", message: String(exitCode) }] },
        });
      }
      return {};
    }
  }

  return { KubeConfig, CustomObjectsApi, CoreV1Api, Exec };
});

import { KubernetesSandboxExecutor, sweepOrphanedSandboxes } from "../src/adapters/kubernetes";

/** Seeds a fake Sandbox object directly into `world` (bypassing the
 *  executor) so gc tests can set arbitrary Ready/Finished condition
 *  combinations the executor itself never produces mid-flight. */
function seedSandbox(
  namespace: string,
  name: string,
  conditions: Array<{ type: string; status: string }>,
): void {
  world.sandboxObjects.set(`${namespace}/${name}`, {
    metadata: { name, namespace },
    status: { conditions },
  });
}

beforeEach(() => {
  world.sandboxObjects.clear();
  world.execCalls = [];
  world.createCalls = [];
  world.deleteCalls = [];
  world.execResult = { stdout: "", stderr: "", exitCode: 0 };
  world.forceNotReady = false;
  world.failDeleteNames.clear();
});

describe("KubernetesSandboxExecutor", () => {
  it("creates a Sandbox object with a valid DNS-1123 name derived from the session id", async () => {
    const sandbox = new KubernetesSandboxExecutor({
      sessionId: "Sess_ABC!!123",
      namespace: "oma-tenants",
    });
    world.execResult = { stdout: "ok\n", stderr: "", exitCode: 0 };

    await sandbox.exec("echo ok");

    expect(world.createCalls).toHaveLength(1);
    const { namespace, name } = world.createCalls[0];
    expect(namespace).toBe("oma-tenants");
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith("oma-")).toBe(true);
  });

  it("exec() returns combined stdout+stderr with no exit suffix on success", async () => {
    const sandbox = new KubernetesSandboxExecutor({ sessionId: "s1" });
    world.execResult = { stdout: "hello\n", stderr: "", exitCode: 0 };

    const result = await sandbox.exec("echo hello");

    expect(result).toBe("hello");
    expect(result).not.toContain("[exit");
  });

  it("exec() appends an [exit N] suffix on non-zero exit", async () => {
    const sandbox = new KubernetesSandboxExecutor({ sessionId: "s2" });
    world.execResult = { stdout: "", stderr: "boom", exitCode: 3 };

    const result = await sandbox.exec("false");

    expect(result).toContain("boom");
    expect(result).toContain("[exit 3]");
  });

  it("exec() surfaces transport errors as [error: ...] instead of throwing", async () => {
    const sandbox = new KubernetesSandboxExecutor({
      sessionId: "s3",
      readyTimeoutMs: 50,
    });
    // Force the created Sandbox to report Ready=False forever, so
    // waitForReady's poll loop exhausts its (short) timeout budget and
    // exec() converts the thrown error into the "[error: ...]" shape
    // instead of rejecting — matching the other adapters' exec() contract.
    world.forceNotReady = true;

    const result = await sandbox.exec("echo hi");

    expect(result).toContain("[error:");
    expect(result.toLowerCase()).toContain("ready");
  });

  it("prefixes exported env vars and command-scoped secrets onto the command", async () => {
    const sandbox = new KubernetesSandboxExecutor({ sessionId: "s4" });
    await sandbox.setEnvVars({ FOO: "bar" });
    sandbox.registerCommandSecrets("git", { GIT_TOKEN: "secret-token" });
    world.execResult = { stdout: "", stderr: "", exitCode: 0 };

    await sandbox.exec("git push");

    const argv = world.execCalls.at(-1)!;
    const shellCommand = argv[argv.length - 1];
    expect(shellCommand).toContain("export FOO='bar';");
    expect(shellCommand).toContain("export GIT_TOKEN='secret-token';");
    expect(shellCommand).toContain("git push");
  });

  it("readFile/writeFileBytes round-trip through the base64-over-exec channel", async () => {
    const sandbox = new KubernetesSandboxExecutor({ sessionId: "s5" });
    const payload = new TextEncoder().encode("hello world");
    const b64 = Buffer.from(payload).toString("base64");

    // writeFileBytes: the mock just needs to succeed (exit 0); it doesn't
    // persist a real filesystem, so we assert the exec'd command shape.
    world.execResult = { stdout: "", stderr: "", exitCode: 0 };
    await sandbox.writeFileBytes("/workspace/out.txt", payload);
    const writeArgv = world.execCalls.at(-1)!;
    expect(writeArgv[writeArgv.length - 1]).toContain(`base64 -d > '/workspace/out.txt'`);

    // readFile: mock returns the base64 payload as stdout.
    world.execResult = { stdout: `${b64}\n`, stderr: "", exitCode: 0 };
    const text = await sandbox.readFile("/workspace/out.txt");
    expect(text).toBe("hello world");
  });

  it("destroy() deletes the Sandbox object even if the pod was never exec'd", async () => {
    const sandbox = new KubernetesSandboxExecutor({ sessionId: "s6", namespace: "ns-x" });

    await sandbox.destroy();

    expect(world.deleteCalls).toHaveLength(1);
    expect(world.deleteCalls[0].namespace).toBe("ns-x");
  });

  it("mountMemoryStore throws a clear, actionable error without S3 bucket config", async () => {
    const sandbox = new KubernetesSandboxExecutor({ sessionId: "s7" });

    await expect(
      sandbox.mountMemoryStore({ storeName: "notes", storeId: "store-1", readOnly: false }),
    ).rejects.toThrow(/MEMORY_S3_/);
  });

  it("startProcess returns null (no detach primitive over pods/exec)", async () => {
    const sandbox = new KubernetesSandboxExecutor({ sessionId: "s8" });
    await expect(sandbox.startProcess("sleep 100")).resolves.toBeNull();
  });

  it("does not deadlock when setOutboundContext armed a CA upload (regression)", async () => {
    // Regression for the k8s exec hang: setOutboundContext queues a
    // pendingCaUpload, whose file write runs *inside* createAndWaitForPod
    // (the in-flight podPromise). Routing that write back through
    // ensurePod() re-awaited the same unresolved promise → permanent
    // deadlock: the first bash exec never returned, no timer ever armed,
    // and the session turn wedged forever. The upload must instead use the
    // pod just resolved. A real temp CA file backs the fs.readFile.
    const { promises: fs } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const caPath = path.join(os.tmpdir(), `oma-vault-ca-${Date.now()}.crt`);
    await fs.writeFile(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");

    const prevProxy = process.env.OMA_VAULT_PROXY_URL;
    const prevCa = process.env.OMA_VAULT_CA_CERT;
    process.env.OMA_VAULT_PROXY_URL = "http://oma.oma.svc.cluster.local:14322";
    process.env.OMA_VAULT_CA_CERT = caPath;
    try {
      const sandbox = new KubernetesSandboxExecutor({ sessionId: "s9", readyTimeoutMs: 2_000 });
      await sandbox.setOutboundContext({ tenantId: "t", sessionId: "s9" });
      world.execResult = { stdout: "ok\n", stderr: "", exitCode: 0 };

      // Before the fix this never resolves. Fail loud if it regresses
      // instead of hanging the whole test run.
      const result = await Promise.race([
        sandbox.exec("echo ok"),
        new Promise<string>((_r, reject) =>
          setTimeout(() => reject(new Error("exec() deadlocked (CA-upload re-entrancy)")), 5_000),
        ),
      ]);

      expect(result).toBe("ok");
      // The CA cert was uploaded via the base64-over-exec channel, then the
      // user's command ran — both on the same pod, no second provisioning.
      expect(world.createCalls).toHaveLength(1);
      const uploadedCa = world.execCalls.some((argv) =>
        argv[argv.length - 1].includes("/etc/ssl/oma-vault-ca.crt"),
      );
      expect(uploadedCa).toBe(true);
    } finally {
      if (prevProxy === undefined) delete process.env.OMA_VAULT_PROXY_URL;
      else process.env.OMA_VAULT_PROXY_URL = prevProxy;
      if (prevCa === undefined) delete process.env.OMA_VAULT_CA_CERT;
      else process.env.OMA_VAULT_CA_CERT = prevCa;
      await fs.unlink(caPath).catch(() => {});
    }
  });
});

describe("sweepOrphanedSandboxes", () => {
  it("deletes only Sandboxes that are Ready=False and Finished=True", async () => {
    seedSandbox("oma", "orphan-1", [
      { type: "Ready", status: "False" },
      { type: "Finished", status: "True" },
    ]);
    seedSandbox("oma", "still-running", [{ type: "Ready", status: "True" }]);
    seedSandbox("oma", "still-starting", [{ type: "Ready", status: "False" }]);

    const result = await sweepOrphanedSandboxes({ namespace: "oma" });

    expect(result.checked).toBe(3);
    expect(result.deleted).toEqual(["orphan-1"]);
    expect(world.deleteCalls).toEqual([{ namespace: "oma", name: "orphan-1" }]);
    expect(world.sandboxObjects.has("oma/still-running")).toBe(true);
    expect(world.sandboxObjects.has("oma/still-starting")).toBe(true);
  });

  it("only sweeps the requested namespace", async () => {
    seedSandbox("oma", "orphan-in-scope", [
      { type: "Ready", status: "False" },
      { type: "Finished", status: "True" },
    ]);
    seedSandbox("other-ns", "orphan-out-of-scope", [
      { type: "Ready", status: "False" },
      { type: "Finished", status: "True" },
    ]);

    const result = await sweepOrphanedSandboxes({ namespace: "oma" });

    expect(result.checked).toBe(1);
    expect(result.deleted).toEqual(["orphan-in-scope"]);
  });

  it("collects per-item errors and keeps sweeping the rest", async () => {
    seedSandbox("oma", "orphan-a", [
      { type: "Ready", status: "False" },
      { type: "Finished", status: "True" },
    ]);
    seedSandbox("oma", "orphan-b", [
      { type: "Ready", status: "False" },
      { type: "Finished", status: "True" },
    ]);

    world.failDeleteNames.add("orphan-a");

    const result = await sweepOrphanedSandboxes({ namespace: "oma" });

    expect(result.deleted).toEqual(["orphan-b"]);
    expect(result.errors).toEqual([{ name: "orphan-a", error: "delete failed" }]);
  });

  it("returns checked=0, deleted=[] when nothing is oma-managed in the namespace", async () => {
    const result = await sweepOrphanedSandboxes({ namespace: "empty-ns" });
    expect(result).toEqual({ checked: 0, deleted: [], errors: [] });
  });
});
