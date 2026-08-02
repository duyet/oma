/**
 * Agent Worker — per-environment session runtime.
 *
 * Each environment gets its own agent worker with a custom container image.
 * This worker exports SessionDO + Sandbox and routes incoming requests
 * from the main worker to the appropriate SessionDO instance.
 */

import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";

// --- Register harnesses ---
import { registerHarness } from "./harness/registry";
import { DefaultHarness } from "./harness/default-loop";
import { AcpProxyHarness } from "./harness/acp-proxy-loop";
import { LongRunningHarness } from "./harness/long-running-loop";
import { PoolsideHarness } from "./harness/poolside-loop";
import { OmaRemoteHarness } from "./harness/oma-remote-loop";
registerHarness("default", () => new DefaultHarness());
registerHarness("acp-proxy", () => new AcpProxyHarness());
registerHarness("long-running", () => new LongRunningHarness());
// Plain-fetch OpenAI-compatible provider (poolside.ai) — no node builtins,
// so unlike claude-agent-sdk it registers on the CF worker too.
registerHarness("poolside", () => new PoolsideHarness());
// Cross-instance federation (issue #132 M1): the whole session is proxied to
// a session on another OMA instance. Selected by an environment with
// `sandbox_provider: "oma-remote"`, never by name.
registerHarness("oma-remote", () => new OmaRemoteHarness());

// --- Export DO classes (required by wrangler) ---
export { SessionDO } from "./runtime/session-do";
export { OmaSandbox as Sandbox } from "./oma-sandbox";

// --- Required by @cloudflare/sandbox 0.8.x outbound interception ---
export { ContainerProxy } from "@cloudflare/containers";

// --- Export outbound worker functions (legacy — see oma-sandbox.ts for the
// real handler wiring via @cloudflare/sandbox 0.8.x setOutboundHandler API). ---
export { outbound, outboundByHost } from "./outbound";

// --- HTTP app: thin router to SessionDO ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok", version: "2" }));

// /__internal/prepare-env, /__internal/prep-tick, /__internal/prep-debug,
// and the buildInstallScript helper were removed when the per-env CI build
// (image_strategy=dockerfile) became the only build path. The lazy-prepare
// branch they fed (base_snapshot) was reverted; see apps/main/src/routes/
// environments.ts pickStrategy for the rationale.

app.all("/sessions/:id/*", async (c) => {
  const sessionId = c.req.param("id");
  const doId = c.env.SESSION_DO!.idFromName(sessionId);
  const doStub = c.env.SESSION_DO!.get(doId);

  const url = new URL(c.req.url);
  const subPath = url.pathname.replace(`/sessions/${sessionId}`, "") || "/";
  const internalUrl = `http://internal${subPath}${url.search}`;

  return doStub.fetch(
    new Request(internalUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
    })
  );
});

export default app;
