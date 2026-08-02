// Agents — full CRUD with AMA-shape envelope.
//
// Sourced from apps/main/src/routes/agents.ts pre-extract: same AMA shape,
// same `_oma:` envelope, same multiagent → callable_agents transform,
// same field acceptance (no silent body field drops).
//
// Differences vs CF:
//   - validateModel + validateAgentLimits have to be plumbed in by the
//     runtime (services.modelCards isn't on the runtime-agnostic
//     RouteServices because main-node doesn't ship a model_cards-store
//     yet); we accept any model id and skip the cap check.
//   - The DELETE-on-active-sessions check uses sql directly since
//     services.sessions.hasActiveByAgent isn't on the abstract service
//     in the Node port either.

import { Hono } from "hono";
import type {
  AgentConfig,
} from "@duyet/oma-shared";
import { notificationTargetsSchema, mcpServersSchema, agentHooksSchema } from "@duyet/oma-api-types";
import {
  AgentNotFoundError,
  AgentVersionMismatchError,
} from "@duyet/oma-agents-store";
import type { SessionRow } from "@duyet/oma-sessions-store";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";
import { parseAnalyticsRange } from "../analytics";
import { redactMcpServers, reconcileMcpServerTokens } from "../mcp-server-redaction";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

function formatAgent(agent: AgentConfig) {
  const model =
    !agent.model || typeof agent.model === "string"
      ? { id: agent.model || "", speed: "standard" as const }
      : { id: agent.model.id, speed: agent.model.speed || ("standard" as const) };

  // OMA-only fields nest under `_oma:` so AMA SDK consumers ignore them
  // while OMA tooling can read the platform extensions.
  const oma: Record<string, unknown> = {};
  if (agent.aux_model) {
    oma.aux_model =
      typeof agent.aux_model === "string"
        ? { id: agent.aux_model, speed: "standard" as const }
        : { id: agent.aux_model.id, speed: agent.aux_model.speed || ("standard" as const) };
  }
  if (agent.appendable_prompts && agent.appendable_prompts.length > 0) {
    oma.appendable_prompts = agent.appendable_prompts;
  }
  if (agent.notify && agent.notify.length > 0) {
    oma.notify = agent.notify;
  }
  if (agent.hooks && agent.hooks.length > 0) {
    oma.hooks = agent.hooks;
  }

  const callable = agent.callable_agents ?? [];
  // The `multiagent` coordinator shape only represents LOCAL sub-agents;
  // federation (`type: "remote_agent"`) entries are surfaced via the stored
  // callable_agents passthrough, not this legacy field.
  const localCallable = callable.filter(
    (c): c is Extract<typeof c, { type: "agent" }> => c.type === "agent",
  );
  const multiagent =
    localCallable.length > 0
      ? {
          type: "coordinator" as const,
          agents: localCallable.map((c) => ({
            type: "agent" as const,
            id: c.id,
            version: c.version ?? 1,
          })),
        }
      : null;

  const {
    aux_model: _aux,
    appendable_prompts: _ap,
    notify: _notify,
    hooks: _hooks,
    callable_agents: _ca,
    ...rest
  } = agent;

  return {
    type: "agent" as const,
    ...rest,
    model,
    system: agent.system || null,
    description: agent.description || null,
    skills: agent.skills || [],
    mcp_servers: redactMcpServers(agent.mcp_servers) || [],
    multiagent,
    callable_agents: callable,
    metadata: agent.metadata || {},
    archived_at: agent.archived_at || null,
    ...(Object.keys(oma).length > 0 ? { _oma: oma } : {}),
  };
}

function toApiAgent(row: AgentConfig & { tenant_id?: string }) {
  const { tenant_id: _t, ...rest } = row;
  return formatAgent(rest);
}

/**
 * Summarize a session row for GET /v1/agents/:id/runs (issue #21).
 * `duration_ms` is derived at read time from already-tracked timestamps
 * (no extra column): the end boundary is `terminated_at` once the session
 * reached AMA's terminus, else `updated_at` (last known activity), else
 * `created_at` for a session with no activity yet. `stop_reason` /
 * `tool_call_count` / `message_count` are written by
 * RuntimeAdapterImpl.endTurn/terminate on every idle/destroyed/terminated
 * transition — null / 0 until the session's first turn completes.
 */
function formatRun(row: SessionRow) {
  const createdMs = Date.parse(row.created_at);
  const endMs = row.terminated_at
    ? Date.parse(row.terminated_at)
    : row.updated_at
      ? Date.parse(row.updated_at)
      : createdMs;
  return {
    type: "agent_run" as const,
    id: row.id,
    title: row.title,
    status: row.status,
    stop_reason: row.stop_reason,
    tool_call_count: row.tool_call_count,
    message_count: row.message_count,
    duration_ms: Math.max(0, endMs - createdMs),
    created_at: row.created_at,
    updated_at: row.updated_at,
    terminated_at: row.terminated_at,
  };
}

function multiagentToCallableAgents(
  multiagent: unknown,
): { list: AgentConfig["callable_agents"]; error?: string } {
  if (multiagent === null || multiagent === undefined) return { list: undefined };
  if (typeof multiagent !== "object")
    return { list: [], error: "multiagent must be an object" };
  const m = multiagent as { type?: string; agents?: unknown };
  if (m.type !== "coordinator")
    return { list: [], error: `multiagent.type must be "coordinator"` };
  if (!Array.isArray(m.agents))
    return { list: [], error: "multiagent.agents must be an array" };
  const out: NonNullable<AgentConfig["callable_agents"]> = [];
  for (const entry of m.agents) {
    if (typeof entry === "string") {
      out.push({ type: "agent", id: entry, version: 1 });
      continue;
    }
    if (entry && typeof entry === "object") {
      const e = entry as { type?: string; id?: string; version?: number };
      if (e.type === "self") {
        return { list: [], error: `multiagent.agents: {"type":"self"} is not yet supported` };
      }
      if (e.type === "agent" && typeof e.id === "string") {
        out.push({
          type: "agent",
          id: e.id,
          version: typeof e.version === "number" ? e.version : 1,
        });
        continue;
      }
    }
    return { list: [], error: `multiagent.agents: invalid roster entry ${JSON.stringify(entry)}` };
  }
  return { list: out };
}

export interface AgentRoutesDeps {
  services: RouteServicesArg;
  /** Optional model card validation. CF passes a function backed by
   *  services.modelCards; Node passes nothing → validation skipped. */
  validateModel?: (
    tenantId: string,
    model: string | { id: string; speed?: string },
  ) => Promise<{ valid: boolean; error?: string }>;
  /** Optional field-size cap check. CF passes apps/main/src/lib/limits;
   *  Node currently passes nothing. */
  validateAgentLimits?: (body: unknown) => { ok: boolean; error?: string };
  /** Active-sessions guard for DELETE — true means "refuse with 409". */
  hasActiveSessionsByAgent?: (
    tenantId: string,
    agentId: string,
  ) => Promise<boolean>;
  /** Active-evals guard for DELETE — CF blocks while runs target this
   *  agent. Node returns false (no eval runner yet). */
  hasActiveEvalsByAgent?: (
    tenantId: string,
    agentId: string,
  ) => Promise<boolean>;
}

export function buildAgentRoutes(deps: AgentRoutesDeps) {
  const app = new Hono<Vars>();

  // POST /v1/agents — create
  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const raw = await c.req.json<{
      name: string;
      model: string | { id: string; speed?: "standard" | "fast" };
      system?: string;
      tools?: AgentConfig["tools"];
      description?: string;
      mcp_servers?: AgentConfig["mcp_servers"];
      skills?: AgentConfig["skills"];
      callable_agents?: AgentConfig["callable_agents"];
      multiagent?: { type: "coordinator"; agents: unknown[] } | null;
      metadata?: Record<string, unknown>;
      _oma?: {
        aux_model?: string | { id: string; speed?: "standard" | "fast" };
        appendable_prompts?: string[];
        notify?: AgentConfig["notify"];
        hooks?: AgentConfig["hooks"];
      };
    }>();

    const ma = multiagentToCallableAgents(raw.multiagent);
    if (ma.error) return c.json({ error: ma.error }, 422);

    if (raw.mcp_servers !== undefined) {
      const parsed = mcpServersSchema.safeParse(raw.mcp_servers);
      if (!parsed.success) {
        return c.json({ error: "invalid mcp_servers config", details: parsed.error.issues }, 422);
      }
    }

    const body = {
      ...raw,
      mcp_servers: Array.isArray(raw.mcp_servers)
        ? (reconcileMcpServerTokens(
            raw.mcp_servers as Array<Record<string, unknown>>,
            undefined,
          ) as AgentConfig["mcp_servers"])
        : raw.mcp_servers,
      callable_agents: ma.list ?? raw.callable_agents,
      aux_model: raw._oma?.aux_model,
      appendable_prompts: raw._oma?.appendable_prompts,
      notify: raw._oma?.notify,
      hooks: raw._oma?.hooks,
    };

    if (raw._oma?.notify !== undefined) {
      const parsed = notificationTargetsSchema.safeParse(raw._oma.notify);
      if (!parsed.success) {
        return c.json({ error: "invalid notify config", details: parsed.error.issues }, 422);
      }
    }

    if (raw._oma?.hooks !== undefined) {
      const parsed = agentHooksSchema.safeParse(raw._oma.hooks);
      if (!parsed.success) {
        return c.json({ error: "invalid hooks config", details: parsed.error.issues }, 422);
      }
    }

    if (!body.name) return c.json({ error: "name is required" }, 400);
    if (!body.model) {
      return c.json({ error: "model is required" }, 400);
    }

    if (deps.validateAgentLimits) {
      const limitCheck = deps.validateAgentLimits(body);
      if (!limitCheck.ok) return c.json({ error: limitCheck.error }, 400);
    }

    const tenantId = c.var.tenant_id;
    if (deps.validateModel) {
      const r = await deps.validateModel(tenantId, body.model);
      if (!r.valid) return c.json({ error: r.error }, 400);
      if (body.aux_model !== undefined) {
        const aux = body.aux_model ?? body.model;
        const ar = await deps.validateModel(tenantId, aux);
        if (!ar.valid) return c.json({ error: `aux_model: ${ar.error}` }, 400);
      }
    }

    const row = await services.agents.create({
      tenantId,
      input: {
        name: body.name,
        model: body.model,
        system: body.system,
        tools: body.tools,
        description: body.description,
        mcp_servers: body.mcp_servers,
        skills: body.skills,
        callable_agents: body.callable_agents,
        metadata: body.metadata,
        aux_model: body.aux_model,
        appendable_prompts: body.appendable_prompts,
        enable_general_subagent: (body as { enable_general_subagent?: boolean })
          .enable_general_subagent,
        notify: body.notify,
        hooks: body.hooks,
        max_parallel_subagents: (body as { max_parallel_subagents?: number })
          .max_parallel_subagents,
      },
    });
    return c.json(toApiAgent(row), 201);
  });

  // GET /v1/agents — cursor-paginated list
  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(Math.max(1, Number(limitStr)), 100) : 50;
    const cursor = c.req.query("cursor") ?? undefined;
    const includeArchivedRaw = c.req.query("include_archived");
    const includeArchived = includeArchivedRaw === "true";
    const q = c.req.query("q") ?? undefined;
    const orderRaw = c.req.query("order");
    if (orderRaw !== undefined && orderRaw !== "asc" && orderRaw !== "desc") {
      return c.json({ error: "order must be asc or desc" }, 400);
    }

    // status: enum filter on archive state. Whitelist strictly — any
    // unknown value is a 400, NOT a silent fallback to "any". Allowing
    // arbitrary strings here would mask client bugs (typo'd "active "
    // returning every row looks like a feature).
    const statusRaw = c.req.query("status");
    let status: "active" | "archived" | "any" | undefined;
    if (statusRaw !== undefined) {
      if (statusRaw === "active" || statusRaw === "archived" || statusRaw === "any") {
        status = statusRaw;
      } else {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_status",
              message: `Invalid status '${statusRaw}'; expected one of active|archived|any.`,
            },
          },
          400,
        );
      }
    }

    // created_after / created_before: ISO timestamps → epoch ms. Reject
    // unparseable values explicitly so the client knows it's a malformed
    // request, not just "no results".
    const parseMs = (
      raw: string | undefined,
      field: string,
    ): { value: number | undefined; err?: Response } => {
      if (raw === undefined) return { value: undefined };
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) {
        return {
          value: undefined,
          err: c.json(
            {
              error: {
                type: "invalid_request_error",
                code: "invalid_timestamp",
                message: `Invalid ${field} '${raw}'; expected ISO-8601 timestamp.`,
              },
            },
            400,
          ),
        };
      }
      return { value: ms };
    };
    const createdAfterRes = parseMs(c.req.query("created_after"), "created_after");
    if (createdAfterRes.err) return createdAfterRes.err;
    const createdBeforeRes = parseMs(c.req.query("created_before"), "created_before");
    if (createdBeforeRes.err) return createdBeforeRes.err;

    const page = await services.agents.listPage({
      tenantId: c.var.tenant_id,
      limit,
      ...(cursor ? { cursor } : {}),
      // Prefer the new `status` filter. Keep includeArchived as a back-
      // compat fallback (used by older console builds that only know the
      // checkbox). The service layer maps includeArchived→status when
      // status is unset, so passing both is fine.
      ...(status !== undefined ? { status } : {}),
      ...(includeArchivedRaw !== undefined ? { includeArchived } : {}),
      ...(q ? { q } : {}),
      ...(createdAfterRes.value !== undefined
        ? { createdAfter: createdAfterRes.value }
        : {}),
      ...(createdBeforeRes.value !== undefined
        ? { createdBefore: createdBeforeRes.value }
        : {}),
    });
    const items = [...page.items];
    if (orderRaw === "asc") {
      items.sort((a, b) => {
        const created = a.created_at.localeCompare(b.created_at);
        return created !== 0 ? created : a.id.localeCompare(b.id);
      });
    }
    return c.json({
      data: items.map(toApiAgent),
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: !!page.nextCursor,
    });
  });

  // GET /v1/agents/:id — get
  app.get("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const row = await services.agents.get({
      tenantId: c.var.tenant_id,
      agentId: c.req.param("id"),
    });
    if (!row) return c.json({ error: "Agent not found" }, 404);
    return c.json(toApiAgent(row));
  });

  // POST/PUT /v1/agents/:id — update
  const updateAgent = async (
    c: import("hono").Context<Vars, "/:id">,
  ): Promise<Response> => {
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const tenantId = c.var.tenant_id;
    const existing = await services.agents.get({ tenantId, agentId: id });
    if (!existing) return c.json({ error: "Agent not found" }, 404);

    const raw = (await c.req.json()) as {
      name?: string;
      model?: string | { id: string; speed?: "standard" | "fast" };
      system?: string | null;
      tools?: AgentConfig["tools"];
      description?: string | null;
      mcp_servers?: AgentConfig["mcp_servers"] | null;
      skills?: AgentConfig["skills"] | null;
      callable_agents?: AgentConfig["callable_agents"] | null;
      multiagent?: { type: "coordinator"; agents: unknown[] } | null;
      metadata?: Record<string, unknown>;
      version?: number;
      _oma?: {
        aux_model?: string | { id: string; speed?: "standard" | "fast" } | null;
        appendable_prompts?: string[] | null;
        notify?: AgentConfig["notify"] | null;
        hooks?: AgentConfig["hooks"] | null;
      };
    };

    let callableAgents: AgentConfig["callable_agents"] | null | undefined;
    if (raw.multiagent === null) {
      callableAgents = null;
    } else if (raw.multiagent !== undefined) {
      const ma = multiagentToCallableAgents(raw.multiagent);
      if (ma.error) return c.json({ error: ma.error }, 422);
      callableAgents = ma.list;
    } else if (raw.callable_agents !== undefined) {
      callableAgents = raw.callable_agents;
    }

    if (raw.mcp_servers !== undefined && raw.mcp_servers !== null) {
      const parsed = mcpServersSchema.safeParse(raw.mcp_servers);
      if (!parsed.success) {
        return c.json({ error: "invalid mcp_servers config", details: parsed.error.issues }, 422);
      }
    }

    const body = {
      ...raw,
      mcp_servers: Array.isArray(raw.mcp_servers)
        ? (reconcileMcpServerTokens(
            raw.mcp_servers as Array<Record<string, unknown>>,
            existing.mcp_servers,
          ) as AgentConfig["mcp_servers"])
        : raw.mcp_servers,
      callable_agents: callableAgents,
      aux_model: raw._oma?.aux_model,
      appendable_prompts: raw._oma?.appendable_prompts,
      notify: raw._oma?.notify,
      hooks: raw._oma?.hooks,
    };

    if (raw._oma?.hooks !== undefined && raw._oma.hooks !== null) {
      const parsed = agentHooksSchema.safeParse(raw._oma.hooks);
      if (!parsed.success) {
        return c.json({ error: "invalid hooks config", details: parsed.error.issues }, 422);
      }
    }

    if (deps.validateAgentLimits) {
      const limitCheck = deps.validateAgentLimits(body);
      if (!limitCheck.ok) return c.json({ error: limitCheck.error }, 400);
    }

    if (deps.validateModel && body.model !== undefined) {
      const eff = body.model ?? existing.model;
      const r = await deps.validateModel(tenantId, eff);
      if (!r.valid) return c.json({ error: r.error }, 400);
    }
    if (deps.validateModel && body.aux_model !== undefined) {
      const aux =
        body.aux_model === null ? undefined : (body.aux_model ?? existing.aux_model);
      if (aux !== undefined) {
        const ar = await deps.validateModel(tenantId, aux);
        if (!ar.valid) return c.json({ error: `aux_model: ${ar.error}` }, 400);
      }
    }

    try {
      const row = await services.agents.update({
        tenantId,
        agentId: id,
        expectedVersion: body.version,
        input: {
          name: body.name,
          model: body.model,
          system: body.system,
          tools: body.tools,
          description: body.description,
          mcp_servers: body.mcp_servers,
          skills: body.skills,
          callable_agents: body.callable_agents,
          metadata: body.metadata,
          aux_model: body.aux_model,
          appendable_prompts: body.appendable_prompts,
          enable_general_subagent: (body as { enable_general_subagent?: boolean })
            .enable_general_subagent,
          notify: body.notify,
          hooks: body.hooks,
          max_parallel_subagents: (body as { max_parallel_subagents?: number | null })
            .max_parallel_subagents,
        },
      });
      return c.json(toApiAgent(row));
    } catch (err) {
      if (err instanceof AgentVersionMismatchError) {
        return c.json(
          { error: "Version mismatch. Agent has been updated since you last read it." },
          409,
        );
      }
      if (err instanceof AgentNotFoundError) {
        return c.json({ error: "Agent not found" }, 404);
      }
      throw err;
    }
  };
  app.post("/:id", updateAgent);
  app.put("/:id", updateAgent);

  // GET /v1/agents/:id/versions — list all versions
  app.get("/:id/versions", async (c) => {
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const tenantId = c.var.tenant_id;
    const exists = await services.agents.get({ tenantId, agentId: id });
    if (!exists) return c.json({ error: "Agent not found" }, 404);
    const versions = await services.agents.listVersions({ tenantId, agentId: id });
    const data = versions
      .map((v) => formatAgent(v.snapshot))
      .sort((a, b) => a.version - b.version);
    return c.json({ data });
  });

  // GET /v1/agents/:id/versions/:version
  app.get("/:id/versions/:version", async (c) => {
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const v = parseInt(c.req.param("version"), 10);
    if (Number.isNaN(v)) return c.json({ error: "Version not found" }, 404);
    const row = await services.agents.getVersion({
      tenantId: c.var.tenant_id,
      agentId: id,
      version: v,
    });
    if (!row) return c.json({ error: "Version not found" }, 404);
    return c.json(formatAgent(row.snapshot));
  });

  // GET /v1/agents/:id/runs — cursor-paginated run history (issue #21).
  // Each item is a session summarized for a "what has this agent done"
  // dashboard: status, duration, tool-call count, stop reason. Backed by
  // the same indexed `sessions` row + cursor convention as GET /v1/agents
  // and GET /v1/sessions — no event-log replay on this read path. The
  // summary columns themselves are refreshed on session completion by
  // RuntimeAdapterImpl.endTurn/terminate (packages/session-runtime).
  app.get("/:id/runs", async (c) => {
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const tenantId = c.var.tenant_id;
    const exists = await services.agents.get({ tenantId, agentId: id });
    if (!exists) return c.json({ error: "Agent not found" }, 404);

    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(Math.max(1, Number(limitStr)), 100) : 50;
    const cursor = c.req.query("cursor") ?? undefined;

    const page = await services.sessions.listPage({
      tenantId,
      agentId: id,
      includeArchived: true,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return c.json({
      data: page.items.map(formatRun),
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: !!page.nextCursor,
    });
  });

  // GET /v1/agents/:id/analytics — per-agent session analytics for the
  // Observability tab. Same {@link SessionAnalytics} shape as
  // GET /v1/analytics/overview, scoped to this agent's sessions. `range`
  // query param: 7d | 30d | 90d (default 30d). See the analytics module for
  // the error-rate definition + tool_usage availability notes.
  app.get("/:id/analytics", async (c) => {
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const tenantId = c.var.tenant_id;
    const exists = await services.agents.get({ tenantId, agentId: id });
    if (!exists) return c.json({ error: "Agent not found" }, 404);

    const parsed = parseAnalyticsRange(c.req.query("range"));
    if ("error" in parsed) {
      return c.json(
        { error: { type: "invalid_request_error", ...parsed.error } },
        400,
      );
    }
    const analytics = await services.sessions.analytics({
      tenantId,
      agentId: id,
      range: parsed.range,
    });
    return c.json(analytics);
  });

  // POST /v1/agents/:id/archive
  app.post("/:id/archive", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      const row = await services.agents.archive({
        tenantId: c.var.tenant_id,
        agentId: c.req.param("id"),
      });
      return c.json(toApiAgent(row));
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        return c.json({ error: "Agent not found" }, 404);
      }
      throw err;
    }
  });

  // DELETE /v1/agents/:id
  app.delete("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const tenantId = c.var.tenant_id;
    const existing = await services.agents.get({ tenantId, agentId: id });
    if (!existing) return c.json({ error: "Agent not found" }, 404);

    if (deps.hasActiveSessionsByAgent) {
      const has = await deps.hasActiveSessionsByAgent(tenantId, id);
      if (has) {
        return c.json(
          {
            error:
              "Cannot delete agent with active sessions. Archive or delete sessions first.",
          },
          409,
        );
      }
    }

    if (deps.hasActiveEvalsByAgent) {
      const has = await deps.hasActiveEvalsByAgent(tenantId, id);
      if (has) {
        return c.json(
          {
            error:
              "Cannot delete agent with active eval runs. Wait for them to finish first.",
          },
          409,
        );
      }
    }

    await services.agents.delete({ tenantId, agentId: id });
    return c.json({ type: "agent_deleted", id });
  });

  return app;
}
