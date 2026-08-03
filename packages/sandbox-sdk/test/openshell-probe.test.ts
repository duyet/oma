// Real (non-mocked) reachability tests for probeOpenShellGateway. Spins up
// an actual gRPC server (no OpenShell service registered — the probe only
// needs the channel to reach READY, not a real RPC) to verify the probe
// against real TCP/HTTP2 behavior rather than a mocked grpc.Client.
//
// See resolveOpenShellTlsFromEnv / probeOpenShellGateway in
// ../src/adapters/openshell.ts and the pure decision logic that consumes
// this probe in provider-config.test.ts.

import { describe, it, expect, afterEach } from "vitest";
import * as grpc from "@grpc/grpc-js";
import { probeOpenShellGateway, resolveOpenShellTlsFromEnv } from "../src/adapters/openshell";

// Short timeout for the "unreachable" cases below — waitForReady doesn't
// surface ECONNREFUSED immediately, it retries internally until the
// deadline, so keep this small to avoid slow tests without flaking on
// legitimately reachable ports.
const SHORT_TIMEOUT_MS = 300;

function startServer(): Promise<{ port: number; server: grpc.Server }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ port, server });
    });
  });
}

describe("probeOpenShellGateway", () => {
  let server: grpc.Server | null = null;

  afterEach(() => {
    if (server) {
      server.forceShutdown();
      server = null;
    }
  });

  it("resolves true when a gRPC server is actually listening at the endpoint", async () => {
    const started = await startServer();
    server = started.server;
    const reachable = await probeOpenShellGateway(`127.0.0.1:${started.port}`, undefined, 1500);
    expect(reachable).toBe(true);
  });

  it("resolves false when nothing is listening at the endpoint", async () => {
    // Bind-then-immediately-shutdown to get a real closed port instead of
    // guessing at an unused one.
    const started = await startServer();
    const { port } = started;
    started.server.forceShutdown();
    const reachable = await probeOpenShellGateway(`127.0.0.1:${port}`, undefined, SHORT_TIMEOUT_MS);
    expect(reachable).toBe(false);
  });

  it("resolves false for an empty endpoint without attempting a connection", async () => {
    const start = Date.now();
    const reachable = await probeOpenShellGateway("", undefined, 1500);
    expect(reachable).toBe(false);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("never throws — resolves false for a malformed endpoint", async () => {
    await expect(
      probeOpenShellGateway("not a valid grpc target :::", undefined, SHORT_TIMEOUT_MS),
    ).resolves.toBe(false);
  });
});

describe("resolveOpenShellTlsFromEnv", () => {
  it("returns undefined when TLS is not enabled", () => {
    expect(resolveOpenShellTlsFromEnv({})).toBeUndefined();
    expect(resolveOpenShellTlsFromEnv({ OPENSHELL_GATEWAY_TLS: "0" })).toBeUndefined();
  });

  it("enables TLS via OPENSHELL_GATEWAY_TLS=1", () => {
    const tls = resolveOpenShellTlsFromEnv({ OPENSHELL_GATEWAY_TLS: "1" });
    expect(tls).toEqual({ caPath: undefined, certPath: undefined, keyPath: undefined });
  });

  it("enables TLS implicitly when a CA or cert path is set", () => {
    expect(resolveOpenShellTlsFromEnv({ OPENSHELL_GATEWAY_CA_PATH: "/etc/ca.pem" })).toEqual({
      caPath: "/etc/ca.pem",
      certPath: undefined,
      keyPath: undefined,
    });
    expect(resolveOpenShellTlsFromEnv({ OPENSHELL_GATEWAY_CERT_PATH: "/etc/cert.pem" })).toEqual({
      caPath: undefined,
      certPath: "/etc/cert.pem",
      keyPath: undefined,
    });
  });

  it("carries mTLS key path through when TLS is enabled", () => {
    const tls = resolveOpenShellTlsFromEnv({
      OPENSHELL_GATEWAY_TLS: "1",
      OPENSHELL_GATEWAY_CA_PATH: "/etc/ca.pem",
      OPENSHELL_GATEWAY_CERT_PATH: "/etc/cert.pem",
      OPENSHELL_GATEWAY_KEY_PATH: "/etc/key.pem",
    });
    expect(tls).toEqual({ caPath: "/etc/ca.pem", certPath: "/etc/cert.pem", keyPath: "/etc/key.pem" });
  });
});
