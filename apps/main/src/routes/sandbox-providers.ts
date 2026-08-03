import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";
import type { SandboxProviderConfig } from "@getoma/sandbox-sdk";
import {
  SandboxProviderRegistry,
  SYSTEM_PROVIDERS,
} from "@getoma/sandbox-sdk";
import type { ProviderHealth } from "@getoma/sandbox-sdk/registry";

// In-memory registry — on the Cloudflare deployment this is a singleton
// per worker instance; on Node it mirrors the main-node registry.
let globalRegistry: SandboxProviderRegistry | null = null;

function getRegistry(env: Env): SandboxProviderRegistry {
  if (!globalRegistry) {
    globalRegistry = new SandboxProviderRegistry();
    globalRegistry.seedFromEnv(env as unknown as Record<string, string | undefined>);
  }
  return globalRegistry;
}

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string };
}>();

// POST /v1/sandbox_providers — Register a BYOK provider
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = (await c.req.json()) as {
    name: string;
    type: string;
    config?: {
      base_url?: string;
      token?: string;
      health_endpoint?: string;
      capabilities?: Record<string, boolean>;
    };
  };

  if (!body.name || !body.type) {
    return c.json({ error: "name and type are required" }, 400);
  }

  const descriptor = SYSTEM_PROVIDERS.find((p) => p.type === body.type);
  if (!descriptor) {
    return c.json({ error: `Unknown provider type: ${body.type}` }, 400);
  }

  const id = `byok_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const config: SandboxProviderConfig = {
    id,
    type: body.type,
    label: body.name,
    isSystem: false,
    tenantId: t,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (body.config?.base_url) config.baseURL = body.config.base_url;
  if (body.config?.token) config.apiKey = body.config.token;
  if (body.config?.capabilities) config.config = Object.fromEntries(
    Object.entries(body.config.capabilities).map(([k, v]) => [k, String(v)]),
  );

  const registry = getRegistry(c.env);
  registry.register(config);

  return c.json(
    {
      id: config.id,
      name: config.label,
      type: "byok",
      provider: config.type,
      config: {
        base_url: config.baseURL ?? null,
        token_preview: config.apiKey ? `${config.apiKey.slice(0, 8)}...` : null,
        health_endpoint: body.config?.health_endpoint ?? null,
        capabilities: (() => {
          const caps = body.config?.capabilities;
          return caps ?? null;
        })(),
      },
      health: null,
      tenant_id: config.tenantId ?? null,
      created_at: config.createdAt,
    },
    201,
  );
});

// GET /v1/sandbox_providers — List all providers (system + BYOK)
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const registry = getRegistry(c.env);
  const all = registry.listForTenant(t);

  const providers = all.map((p) => ({
    id: p.id,
    name: p.label,
    type: p.isSystem ? "system" : "byok",
    provider: p.type,
    config: {
      base_url: p.baseURL ?? null,
      health_endpoint: null,
      capabilities: null,
    },
    tenant_id: p.tenantId ?? null,
    created_at: p.createdAt ?? null,
  }));

  return c.json({ data: providers });
});

// GET /v1/sandbox_providers/:id — Get provider details
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const registry = getRegistry(c.env);
  const p = registry.get(id);

  if (!p) return c.json({ error: "Provider not found" }, 404);
  if (p.tenantId && p.tenantId !== t) return c.json({ error: "Provider not found" }, 404);

  return c.json({
    id: p.id,
    name: p.label,
    type: p.isSystem ? "system" : "byok",
    provider: p.type,
    config: {
      base_url: p.baseURL ?? null,
      token_preview: p.apiKey ? `${p.apiKey.slice(0, 8)}...` : null,
    },
    tenant_id: p.tenantId ?? null,
    created_at: p.createdAt ?? null,
    updated_at: p.updatedAt ?? null,
  });
});

// PUT /v1/sandbox_providers/:id — Update provider
app.put("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const registry = getRegistry(c.env);
  const existing = registry.get(id);

  if (!existing) return c.json({ error: "Provider not found" }, 404);

  const body = (await c.req.json()) as {
    name?: string;
    config?: {
      base_url?: string;
      token?: string;
      health_endpoint?: string;
      capabilities?: Record<string, boolean>;
    };
  };

  const updated: SandboxProviderConfig = {
    ...existing,
    updatedAt: new Date().toISOString(),
  };
  if (body.name) updated.label = body.name;
  if (body.config?.base_url) updated.baseURL = body.config.base_url;
  if (body.config?.token) updated.apiKey = body.config.token;

  registry.register(updated);

  return c.json({
    id: updated.id,
    name: updated.label,
    type: updated.isSystem ? "system" : "byok",
    provider: updated.type,
    updated_at: updated.updatedAt,
  });
});

// DELETE /v1/sandbox_providers/:id — Remove BYOK provider
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const registry = getRegistry(c.env);

  if (!registry.get(id)) return c.json({ error: "Provider not found" }, 404);

  const ok = registry.unregister(id);
  if (!ok) {
    return c.json({ error: "System providers cannot be deleted" }, 403);
  }

  return c.json({ ok: true, id });
});

// POST /v1/sandbox_providers/:id/health-trigger — Trigger health check
app.post("/:id/health-trigger", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const registry = getRegistry(c.env);
  const p = registry.get(id);

  if (!p) return c.json({ error: "Provider not found" }, 404);
  if (p.tenantId && p.tenantId !== t) return c.json({ error: "Provider not found" }, 404);

  let health: ProviderHealth;
  try {
    health = await registry.checkHealth(id);
  } catch (err) {
    health = {
      id,
      status: "error",
      latencyMs: 0,
      lastChecked: new Date().toISOString(),
      details: err instanceof Error ? err.message : String(err),
    };
  }

  return c.json({
    id,
    status: health.status,
    last_checked: health.lastChecked,
    latency_ms: health.latencyMs,
    details: health.details ?? null,
  });
});

export default app;
