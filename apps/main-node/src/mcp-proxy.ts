/**
 * Node MCP proxy — self-host counterpart to apps/main/src/routes/mcp-proxy.ts
 * (`resolveProxyTargetByTenant` + `forwardToUpstream`). Credential
 * resolution runs in-process here instead of over a Cloudflare service
 * binding / WorkerEntrypoint RPC, but the wiring contract with
 * `apps/agent/src/harness/tools.ts` is identical: buildTools is handed an
 * `env.mcpBinding` object with a single `fetch(request)` method, and the AI
 * SDK's MCP HTTP transport calls it with `x-oma-tenant` / `x-oma-session` /
 * `x-oma-mcp-server` headers stamped on every request. This module resolves
 * those headers into an upstream URL + bearer token and forwards the
 * request — the sandbox/harness never sees the plaintext credential.
 *
 * Resolution rules mirror the CF proxy exactly:
 *   - inline `mcp_servers[].url` wins over `registry_id`
 *   - a registry entry's `credential_id`, if set, pins the vault credential;
 *     otherwise fall back to matching a credential by `auth.mcp_server_url`
 *   - `mcp_servers[].authorization_token`, if set, is used as the literal
 *     bearer and skips vault lookup entirely
 *
 * Deferred (documented, not implemented): CF's `forwardWithRefresh` retries
 * once on a 401/403 by rotating an `mcp_oauth` credential's refresh_token.
 * This Node path forwards with whatever token is currently on the
 * credential row and does not auto-refresh — a stale mcp_oauth token
 * surfaces as a 401 to the model instead of self-healing. Vault-issued
 * `static_bearer` / `cap_cli` credentials (the common case for self-hosted
 * MCP servers) are unaffected since they don't expire the same way.
 */

import type { AgentConfig } from "@duyet/oma-shared";
import {
  overlayFromMetadata,
  pickMcpServer,
} from "@duyet/oma-api-types";
import type { KvStore } from "@duyet/oma-kv-store";
import type { SessionService } from "@duyet/oma-sessions-store";
import type { CredentialService } from "@duyet/oma-credentials-store";
import { resolveRegisteredMcpServer } from "@duyet/oma-http-routes";
import { getLogger } from "@duyet/oma-observability";

const log = getLogger("mcp-proxy-node");

export interface NodeMcpProxyDeps {
  sessions: SessionService;
  credentials: CredentialService;
  kv: KvStore;
}

interface ProxyTarget {
  upstreamUrl: string;
  upstreamToken: string;
}

/**
 * Validate the (tenantId, sessionId, serverName) triple and resolve the
 * upstream URL + injection token. Returns null if anything fails — the
 * caller turns that into a 403.
 */
async function resolveProxyTarget(
  deps: NodeMcpProxyDeps,
  tenantId: string,
  sessionId: string,
  serverName: string,
): Promise<ProxyTarget | null> {
  const session = await deps.sessions.get({ tenantId, sessionId }).catch(() => null);
  if (!session) return null;
  if (session.archived_at) return null;

  const agent = session.agent_snapshot as AgentConfig | null;
  if (!agent) return null;
  const overlay = overlayFromMetadata(session.metadata);
  const server = pickMcpServer(agent.mcp_servers, overlay, serverName);
  if (!server) return null;

  // Inline url wins over registry_id; overlay or registry credential_id
  // pins the vault credential to inject.
  let upstreamUrl = server.url;
  let pinnedCredentialId: string | undefined = server.credential_id;
  const registryId = server.registry_id;
  if (!upstreamUrl && registryId) {
    const registered = await resolveRegisteredMcpServer(deps.kv, tenantId, registryId);
    if (registered) {
      upstreamUrl = registered.url;
      if (!pinnedCredentialId) pinnedCredentialId = registered.credential_id;
    }
  }
  if (!upstreamUrl) return null;

  if (server.authorization_token) {
    return { upstreamUrl, upstreamToken: server.authorization_token };
  }

  const vaultIds = session.vault_ids ?? [];
  if (vaultIds.length === 0) return null;
  const grouped = await deps.credentials.listByVaults({ tenantId, vaultIds }).catch(() => []);
  for (const g of grouped) {
    for (const c of g.credentials) {
      if (c.archived_at) continue;
      const auth = c.auth;
      if (!auth) continue;
      if (pinnedCredentialId) {
        if (c.id !== pinnedCredentialId) continue;
      } else if (auth.mcp_server_url !== upstreamUrl) {
        continue;
      }
      const token =
        (auth as { bearer_token?: string; token?: string }).bearer_token ??
        (auth as { token?: string }).token ??
        auth.access_token;
      if (!token) continue;
      return { upstreamUrl, upstreamToken: token };
    }
  }
  return null;
}

/**
 * Forward a request to the upstream MCP server, swapping in the resolved
 * bearer token. Strips hop-specific headers so the upstream sees the same
 * shape it would if the agent had called it directly.
 */
async function forwardToUpstream(
  target: ProxyTarget,
  method: string,
  inboundHeaders: Headers,
  body: BodyInit | null,
): Promise<Response> {
  const upstreamHeaders = new Headers(inboundHeaders);
  upstreamHeaders.set("authorization", `Bearer ${target.upstreamToken}`);
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("x-oma-tenant");
  upstreamHeaders.delete("x-oma-session");
  upstreamHeaders.delete("x-oma-mcp-server");
  upstreamHeaders.delete("x-forwarded-for");
  upstreamHeaders.delete("x-forwarded-proto");

  const upstreamReq = new Request(target.upstreamUrl, {
    method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
  });

  return fetch(upstreamReq);
}

/**
 * Build the `{ fetch }` binding threaded into `buildTools`' `env.mcpBinding`
 * — see the module doc above for the full contract. One instance is shared
 * across every session on this process; all per-request context comes from
 * the stamped headers.
 */
export function buildNodeMcpBinding(deps: NodeMcpProxyDeps): {
  fetch: (request: Request) => Promise<Response>;
} {
  return {
    async fetch(request: Request): Promise<Response> {
      const tenantId = request.headers.get("x-oma-tenant");
      const sessionId = request.headers.get("x-oma-session");
      const serverName = request.headers.get("x-oma-mcp-server");
      if (!tenantId || !sessionId || !serverName) {
        return new Response(JSON.stringify({ error: "missing mcp routing headers" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const target = await resolveProxyTarget(deps, tenantId, sessionId, serverName).catch(
        (err) => {
          log.warn(
            { err, op: "mcp_proxy_node.resolve_failed", tenant_id: tenantId, session_id: sessionId, server: serverName },
            "mcp proxy target resolution threw",
          );
          return null;
        },
      );
      if (!target) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      const method = request.method;
      const body = ["GET", "HEAD"].includes(method) ? null : await request.text();
      return forwardToUpstream(target, method, request.headers, body);
    },
  };
}
