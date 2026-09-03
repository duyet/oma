// Sessions routes — runtime-agnostic mount over the SessionRouter.
//
// CF wires SessionRouter = CfSessionRouter (DO RPC); Node wires
// SessionRouter = NodeSessionRouter (in-process registry + SQL log +
// hub). Routes here never know about SessionDO bindings, R2, or
// node:fs — those concerns live in the runtime adapters and the
// optional CF-only callbacks in `deps`.
//
// The complex session-create flow (USAGE_METER gate, GitHub fast-path
// token mint, refreshProviderCredentialsForSession, R2 file copy on
// resource attach, R2 outputs cascade-delete) is plumbed through
// optional `deps.lifecycle` hooks so the package can stay environment-
// neutral while preserving CF wire shape.

import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Context } from "hono";
import {
  generateFileId,
  generateEventId,
  guessSessionOutputMime,
} from "@duyet/oma-shared";
import type {
  AgentConfig,
  ContentBlock,
  CredentialConfig,
  EnvironmentConfig,
  SessionEvent,
  SessionResource,
  UserMessageEvent,
} from "@duyet/oma-shared";
import {
  SessionArchivedError,
  SessionMemoryStoreMaxExceededError,
  SessionNotFoundError,
  SessionResourceMaxExceededError,
  SessionResourceNotFoundError,
} from "@duyet/oma-sessions-store";
import type { SessionRouter, SessionInitParams } from "@duyet/oma-session-runtime";
import type { RouteServicesArg } from "../types";
import { resolveSessionEnvironmentId } from "./resolve-environment";
import { redactMcpServers } from "../mcp-server-redaction";
import { resolveServices } from "../types";
import { federatedListBody } from "../federation-fanout";
import type { FederationCryptoDep, FederatedRow } from "../federation-fanout";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

const ALLOWED_EVENT_TYPES = new Set<string>([
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "user.custom_tool_result",
  "user.define_outcome",
]);

interface BlobObjectListing {
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  media_type: string;
}

export interface OutputsAdapter {
  /** Listing for GET /v1/sessions/:id/outputs. */
  list(tenantId: string, sessionId: string): Promise<BlobObjectListing[] | null>;
  /** Streaming download for GET /v1/sessions/:id/outputs/:filename. */
  read(
    tenantId: string,
    sessionId: string,
    filename: string,
  ): Promise<{
    body: ReadableStream<Uint8Array> | ArrayBuffer;
    size: number;
    contentType: string;
  } | null>;
  /** Cascade-delete on session DELETE — best-effort. */
  deleteAll(tenantId: string, sessionId: string): Promise<void>;
}

export interface SessionLifecycleHooks {
  /** Pre-create gate (USAGE_METER.canStartSandbox). Returns null to
   *  proceed; { status, body } to short-circuit. */
  preCreateGate?: (input: {
    tenantId: string;
    agentId: string;
    isLocalRuntime: boolean;
  }) => Promise<{ status: number; body: unknown } | null>;
  /** Refresh provider-tagged credentials for the given vault set + return
   *  any session.warning events to inject. CF: refreshProviderCredentialsForSession.
   *  Node: returns []. */
  refreshSessionCredentials?: (input: {
    tenantId: string;
    agentId: string;
    vaultIds: string[];
  }) => Promise<SessionEvent[]>;
  /** GitHub binding fast-path: per-repo, mint a fresh installation token
   *  + return the matching vault id to attach. */
  githubBindingFastPath?: (input: {
    tenantId: string;
    repoUrl: string;
  }) => Promise<{ token: string; vaultId: string } | null>;
  /** Per-session daily-cap + per-minute rate-limit on session create. */
  preCreateRateLimit?: (input: {
    tenantId: string;
  }) => Promise<{ status: number; body: unknown } | null>;
  /** Best-effort daemon dispose forward (CF RuntimeRoom). Called on DELETE. */
  notifyDaemonDispose?: (input: {
    runtimeId: string;
    sessionId: string;
  }) => Promise<void>;
  /** Resolve {file_id} ContentBlocks to inline base64 + return mount ids
   *  for the sandbox. CF: reads bytes from FILES_BUCKET. Node: returns
   *  blocks unchanged (file_id resolution lands in the Node port later). */
  resolveFileIds?: (input: {
    tenantId: string;
    blocks: ContentBlock[];
  }) => Promise<{ blocks: ContentBlock[]; mountFileIds: string[] }>;
  /** Copy a file from the global filesBlob into a per-session scope on
   *  POST /v1/sessions resources. CF: R2 copy. Node: filesystem copy
   *  or alias. */
  cloneSessionFile?: (input: {
    tenantId: string;
    sessionId: string;
    sourceFileId: string;
  }) => Promise<{
    fileId: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
  } | null>;
  fileExists?: (input: {
    tenantId: string;
    fileId: string;
  }) => Promise<boolean>;
  /** Delete a session's blob storage (R2 prefix or local files) on
   *  session DELETE. */
  cascadeDeleteFiles?: (input: {
    tenantId: string;
    sessionId: string;
  }) => Promise<void>;
  /** Promote a sandbox path to a first-class file_id (POST /sessions/:id/files). */
  promoteSandboxFile?: (input: {
    tenantId: string;
    sessionId: string;
    sandboxPath: string;
    filename: string;
    mediaType: string;
    downloadable: boolean;
    bytes: ArrayBuffer;
  }) => Promise<unknown>;
}

export interface SessionRoutesDeps {
  services: RouteServicesArg;
  /** Per-request SessionRouter — CF resolves per-tenant; Node returns
   *  the singleton router built at process start. */
  router: SessionRouter | ((c: Context) => SessionRouter);
  /** Environment lookup for session create. Returns the snapshot the
   *  runtime needs at /init. */
  loadEnvironment?: (input: {
    tenantId: string;
    environmentId: string;
  }) => Promise<EnvironmentConfig | null>;
  /** Vault credential bundling for /init. Both runtimes read from
   *  services.credentials but we keep it pluggable for future variants. */
  fetchVaultCredentials?: (input: {
    tenantId: string;
    vaultIds: string[];
  }) => Promise<Array<{ vault_id: string; credentials: CredentialConfig[] }>>;
  /** Outputs surface — CF wraps R2; Node wraps the local FS in
   *  outputsRoot. Null disables /outputs routes. */
  outputs?: OutputsAdapter | null;
  /** Optional debug-token gate for POST /v1/sessions/:id/__debug_recovery__.
   *  When unset the route 404s. */
  debugRecoveryToken?: string;
  /** CF lifecycle hooks (USAGE_METER, refresh, fast-path, etc.). All
   *  optional — Node leaves them undefined and the package degrades
   *  gracefully (no-op). */
  lifecycle?: SessionLifecycleHooks;
  /** At-rest crypto for federated-listing fan-out (issue #132 M3). Same
   *  FEDERATION_CRYPTO_LABEL crypto the federation registry routes use.
   *  Unset ⇒ `?include_remotes=1` degrades to local rows plus a
   *  `remote_errors[]` marker per registered instance. */
  federationCrypto?: FederationCryptoDep;
}

function resolveRouter(
  arg: SessionRouter | ((c: Context) => SessionRouter),
  c: Context,
): SessionRouter {
  return typeof arg === "function" ? arg(c) : arg;
}

function mapSessionError(c: Context, err: unknown): Response {
  if (err instanceof SessionNotFoundError) return c.json({ error: "Session not found" }, 404);
  if (err instanceof SessionResourceNotFoundError) return c.json({ error: "Resource not found" }, 404);
  if (err instanceof SessionArchivedError) return c.json({ error: err.message }, 409);
  if (err instanceof SessionResourceMaxExceededError) return c.json({ error: err.message }, 400);
  if (err instanceof SessionMemoryStoreMaxExceededError) return c.json({ error: err.message }, 422);
  throw err;
}

function snapshotToSessionAgent(
  agentId: string,
  snapshot: AgentConfig | null,
): Record<string, unknown> {
  if (!snapshot) return { type: "agent", id: agentId, version: 1 };
  const {
    aux_model: _a,
    appendable_prompts: _ap,
    callable_agents,
    archived_at: _ar,
    created_at: _ca,
    updated_at: _ua,
    metadata: _md,
    ...rest
  } = snapshot;
  const localCallable = (callable_agents ?? []).filter(
    (c): c is Extract<typeof c, { type: "agent" }> => c.type === "agent",
  );
  const multiagent = localCallable.length > 0
    ? {
        type: "coordinator" as const,
        agents: localCallable.map((c) => ({
          type: "agent" as const,
          id: c.id,
          version: c.version ?? 1,
        })),
      }
    : null;
  return {
    type: "agent",
    ...rest,
    // agent_snapshot carries the real mcp_servers[].authorization_token
    // (session creation copies it straight off the agent row so the MCP
    // proxy can resolve it) — never echo that plaintext value back through
    // this API response. See issue #196 / packages/http-routes/src/mcp-
    // server-redaction.ts.
    mcp_servers: redactMcpServers(rest.mcp_servers),
    id: agentId,
    version: snapshot.version ?? 1,
    multiagent,
  };
}

function toApiSession(row: {
  id: string;
  tenant_id?: string;
  agent_id: string;
  agent_snapshot?: AgentConfig | null;
  environment_id?: string;
  environment_snapshot?: EnvironmentConfig | null;
  title?: string | null;
  vault_ids?: string[] | null;
  metadata?: Record<string, unknown> | null;
  status: string;
  created_at: string;
  updated_at?: string | null;
  archived_at?: string | null;
  terminated_at?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  // Run-summary rollup columns maintained by RuntimeAdapterImpl.endTurn /
  // .terminate (packages/session-runtime/src/adapter.ts) on every turn
  // transition. Declared explicitly — not just carried anonymously through
  // `...rest` — because the Console dashboard + sessions list now render
  // them as columns, so they are part of this endpoint's contract.
  message_count?: number;
  tool_call_count?: number;
  stop_reason?: string | null;
}): Record<string, unknown> {
  const {
    tenant_id: _t,
    agent_id,
    agent_snapshot,
    environment_snapshot: _es,
    title,
    vault_ids,
    metadata,
    input_tokens,
    output_tokens,
    message_count,
    tool_call_count,
    ...rest
  } = row;
  const createdMs = Date.parse(row.created_at);
  const terminatedMs = row.terminated_at ? Date.parse(row.terminated_at) : null;
  const updatedMs = row.updated_at ? Date.parse(row.updated_at) : null;
  // Wall-clock end reference, in priority order:
  //   terminated_at — the session is over; its duration is final.
  //   now           — the session is mid-turn, so it is still accruing.
  //   updated_at    — idle: the clock stopped at the last turn transition.
  // The last case is why this isn't just `terminated_at ?? now`: an idle
  // session created a week ago and untouched since did nothing for that
  // week, and reporting "7d" for it is simply wrong.
  const idleEndMs =
    row.status !== "running" && updatedMs !== null && Number.isFinite(updatedMs)
      ? updatedMs
      : null;
  const refMs = terminatedMs ?? idleEndMs ?? Date.now();
  const durationSeconds = Number.isFinite(createdMs)
    ? Math.max(0, Math.round((refMs - createdMs) / 1000))
    : undefined;
  return {
    ...rest,
    type: "session" as const,
    title: title ?? null,
    agent_id,
    agent: snapshotToSessionAgent(agent_id, agent_snapshot ?? null),
    vault_ids: vault_ids ?? [],
    metadata: metadata ?? {},
    input_tokens: input_tokens ?? 0,
    output_tokens: output_tokens ?? 0,
    message_count: message_count ?? 0,
    tool_call_count: tool_call_count ?? 0,
    resources: [] as unknown[],
    outcome_evaluations: [] as unknown[],
    usage: {} as Record<string, unknown>,
    stats: durationSeconds !== undefined ? { duration_seconds: durationSeconds } : {},
  };
}

export function buildSessionRoutes(deps: SessionRoutesDeps) {
  const app = new Hono<Vars>();

  // ── Create ────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const t = c.var.tenant_id;

    if (deps.lifecycle?.preCreateRateLimit) {
      const r = await deps.lifecycle.preCreateRateLimit({ tenantId: t });
      if (r) return c.json(r.body as object, r.status as 429);
    }

    const body = await c.req.json<{
      agent: string | { id: string; version?: number };
      environment_id?: string;
      environment?: string | { id: string };
      title?: string;
      vault_ids?: string[];
      metadata?: Record<string, unknown>;
      /** Per-session override of the agent's default model — see the
       *  harness resolution formula in AGENTS.md ("Session gains optional
       *  model + reasoning_effort overrides"). Forwarded as init params,
       *  never appended to the event log. */
      model?: string;
      /** Per-session override of a local-kind environment's default
       *  reasoning effort. No-op for cloud-kind environments (no harness
       *  there defines the concept yet). */
      reasoning_effort?: string;
      resources?: Array<{
        type: "file" | "memory_store" | "github_repository" | "github_repo" | "env" | "env_secret";
        file_id?: string;
        memory_store_id?: string;
        mount_path?: string;
        access?: "read_write" | "read_only";
        instructions?: string;
        url?: string;
        repo_url?: string;
        authorization_token?: string;
        checkout?: { type?: string; name?: string; sha?: string };
        name?: string;
        value?: string;
      }>;
    }>();

    const agentId = typeof body.agent === "string" ? body.agent : body.agent?.id;
    const wrappedEnv =
      typeof body.environment === "string" ? body.environment : body.environment?.id;
    if (!agentId) return c.json({ error: "agent is required" }, 400);

    // metadata: optional plain-object bag stamped onto the session row at
    // create (issue #252). Publication session-create forwards
    // publication_id/end_user_id here — dropping it silently breaks the
    // per_1k_tokens post-turn debit (no wallet resolves) and notify webhook
    // envelopes. Same shape the POST /:id update route accepts.
    if (
      body.metadata !== undefined &&
      (body.metadata === null ||
        typeof body.metadata !== "object" ||
        Array.isArray(body.metadata))
    ) {
      return c.json({ error: "metadata must be a plain object" }, 400);
    }
    const metadata = body.metadata;

    const memCount = (body.resources ?? []).filter((r) => r.type === "memory_store").length;
    if (memCount > 8) {
      return c.json({ error: "Maximum 8 memory_store resources per session" }, 422);
    }

    const seenStores = new Set<string>();
    for (const r of body.resources ?? []) {
      if (r.type === "memory_store" && r.memory_store_id) {
        if (seenStores.has(r.memory_store_id)) {
          return c.json(
            { error: `Duplicate memory_store resource: ${r.memory_store_id}` },
            422,
          );
        }
        seenStores.add(r.memory_store_id);
      }
    }

    const agentRow = await services.agents.get({ tenantId: t, agentId });
    if (!agentRow) return c.json({ error: "Agent not found" }, 404);

    // Environment resolution (docs/sandbox-runtime-selection.md):
    //   1. body.environment_id / body.environment
    //   2. agent.metadata.default_environment_id
    //   3. else 400 — never invent a provider without an environment row
    const envResolved = resolveSessionEnvironmentId({
      bodyEnvironmentId: body.environment_id ?? wrappedEnv,
      agentMetadata: (agentRow as { metadata?: Record<string, unknown> }).metadata,
    });
    const envId = envResolved.environmentId;
    if (!envId) {
      return c.json(
        {
          error: "environment_id is required",
          hint:
            "Pass environment_id on the request, or set agent.metadata.default_environment_id",
        },
        400,
      );
    }

    const { tenant_id: _atid, ...agentSnapshot } = agentRow;
    const envSnap = deps.loadEnvironment
      ? await deps.loadEnvironment({ tenantId: t, environmentId: envId })
      : null;
    if (!envSnap) {
      if (envResolved.source === "agent_default") {
        return c.json(
          {
            error:
              "agent.metadata.default_environment_id points to a missing or inaccessible environment",
            environment_id: envId,
          },
          422,
        );
      }
      return c.json({ error: "Environment not found" }, 404);
    }
    // Prefer services.environments when present so we can refuse archived envs
    // even if loadEnvironment still returns a snapshot for them.
    if (services.environments) {
      const envRow = await services.environments.get({
        tenantId: t,
        environmentId: envId,
      });
      if (envRow?.archived_at) {
        return c.json(
          {
            error:
              envResolved.source === "agent_default"
                ? "agent.metadata.default_environment_id points to an archived environment"
                : "Environment is archived",
            environment_id: envId,
          },
          422,
        );
      }
    }
    const isLocalRuntime = envSnap.config?.kind === "local";

    if (deps.lifecycle?.preCreateGate) {
      const gate = await deps.lifecycle.preCreateGate({
        tenantId: t,
        agentId,
        isLocalRuntime,
      });
      if (gate) return c.json(gate.body as object, gate.status as 402);
    }

    const vaultIds = body.vault_ids ?? [];

    // GitHub fast-path: pre-mint installation tokens for unbound repo refs.
    const fastPathTokens = new Map<string, string>();
    if (deps.lifecycle?.githubBindingFastPath && body.resources?.length) {
      for (const res of body.resources) {
        if (
          (res.type === "github_repository" || res.type === "github_repo") &&
          (res.url || res.repo_url) &&
          !res.authorization_token
        ) {
          const repoUrl = res.url || res.repo_url!;
          const fast = await deps.lifecycle.githubBindingFastPath({
            tenantId: t,
            repoUrl,
          });
          if (fast) {
            fastPathTokens.set(repoUrl, fast.token);
            if (!vaultIds.includes(fast.vaultId)) vaultIds.push(fast.vaultId);
          }
        }
      }
    }

    const refreshEvents = deps.lifecycle?.refreshSessionCredentials
      ? await deps.lifecycle.refreshSessionCredentials({
          tenantId: t,
          agentId,
          vaultIds,
        })
      : [];

    const vaultCreds = deps.fetchVaultCredentials
      ? await deps.fetchVaultCredentials({ tenantId: t, vaultIds })
      : [];

    // Build initial resource inputs (non-file).
    const nonFileInputs: Array<{
      type: "memory_store" | "github_repository" | "env";
      [k: string]: unknown;
    }> = [];
    for (const res of body.resources ?? []) {
      if (res.type === "memory_store" && res.memory_store_id) {
        nonFileInputs.push({
          type: "memory_store",
          memory_store_id: res.memory_store_id,
          mount_path: res.mount_path,
          access: res.access === "read_only" ? "read_only" : "read_write",
          instructions:
            typeof res.instructions === "string"
              ? res.instructions.slice(0, 4096)
              : undefined,
        });
      } else if (
        (res.type === "github_repository" || res.type === "github_repo") &&
        (res.url || res.repo_url)
      ) {
        const repoUrl = res.url || res.repo_url!;
        nonFileInputs.push({
          type: "github_repository",
          url: repoUrl,
          repo_url: repoUrl,
          mount_path: res.mount_path || "/workspace",
          checkout: res.checkout,
        });
      } else if ((res.type === "env" || res.type === "env_secret") && res.name && res.value) {
        nonFileInputs.push({ type: "env", name: res.name });
      }
    }

    let session;
    let createdResources: Array<{ id: string; type: string; resource: SessionResource }>;
    try {
      const result = await services.sessions.create({
        tenantId: t,
        agentId,
        environmentId: envId,
        title: body.title ?? "",
        vaultIds,
        agentSnapshot: agentSnapshot as AgentConfig,
        environmentSnapshot: envSnap ?? undefined,
        metadata,
        resources: nonFileInputs as never,
      });
      session = result.session;
      createdResources = result.resources as never;
    } catch (err) {
      return mapSessionError(c, err);
    }
    const sessionId = session.id;

    // Init the runtime layer (DO PUT /init or Node warm + init events).
    const initParams: SessionInitParams = {
      agentId,
      environmentId: envId,
      title: body.title ?? "",
      tenantId: t,
      vaultIds,
      agentSnapshot: agentSnapshot as AgentConfig,
      environmentSnapshot: envSnap ?? undefined,
      vaultCredentials: vaultCreds,
      initEvents: refreshEvents,
      // Mirror whatever metadata ended up on the just-created row into DO
      // state (issue #222) — see SessionInitParams.metadata.
      metadata: session.metadata ?? undefined,
      // Session-level model/reasoning_effort overrides (harness-to-
      // environment migration). Stored as init params / DO state only —
      // NEVER appended to the event log (would bust Anthropic's prompt
      // cache; see interface.ts's cache-prefix contract).
      model: body.model,
      reasoningEffort: body.reasoning_effort,
    };
    await router.init(sessionId, initParams).catch((err) => {
      console.warn(`[sessions] router.init failed for ${sessionId}:`, err);
    });

    // File resource cloning (per-session R2 copy / FS link).
    if (deps.lifecycle?.cloneSessionFile) {
      for (const res of body.resources ?? []) {
        if (res.type === "file" && res.file_id) {
          const cloned = await deps.lifecycle.cloneSessionFile({
            tenantId: t,
            sessionId,
            sourceFileId: res.file_id,
          });
          if (cloned) {
            try {
              const added = await services.sessions.addResource({
                tenantId: t,
                sessionId,
                resource: {
                  type: "file",
                  file_id: cloned.fileId,
                  mount_path: res.mount_path,
                } as never,
              });
              createdResources.push(added as never);
            } catch (err) {
              return mapSessionError(c, err);
            }
          }
        }
      }
    }

    const response: Record<string, unknown> = { ...toApiSession(session as never) };
    if (createdResources.length > 0) {
      response.resources = createdResources.map((r) => r.resource);
    }
    return c.json(response, 201);
  });

  // ── List / Get / Update / Archive / Delete ────────────────────────────
  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const agentIdFilter = c.req.query("agent_id") || undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    const cursor = c.req.query("cursor") ?? c.req.query("page");
    const q = c.req.query("q") ?? undefined;
    const includeArchived = c.req.query("include_archived") === "true";

    // status: session lifecycle filter (idle | running | rescheduling |
    // terminated). Whitelist strictly — unknown value is a 400, NOT a
    // silent fallback. Mirrors the agents-route pattern; allowing arbitrary
    // strings here would mask client bugs.
    const statusRaw = c.req.query("status");
    let status: "idle" | "running" | "rescheduling" | "terminated" | undefined;
    if (statusRaw !== undefined) {
      if (
        statusRaw === "idle" ||
        statusRaw === "running" ||
        statusRaw === "rescheduling" ||
        statusRaw === "terminated"
      ) {
        status = statusRaw;
      } else {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_status",
              message: `Invalid status '${statusRaw}'; expected one of idle|running|rescheduling|terminated.`,
            },
          },
          400,
        );
      }
    }

    // created_after / created_before: ISO timestamps → epoch ms. The console
    // SessionsList date-range filter sends these; reject unparseable values so
    // the client knows it's a malformed request, not just "no results".
    // Mirrors the agents list route (packages/http-routes/src/agents/index.ts).
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

    const page = await services.sessions.listPage({
      tenantId: c.var.tenant_id,
      agentId: agentIdFilter,
      limit,
      cursor: cursor ?? undefined,
      includeArchived,
      ...(status ? { status } : {}),
      ...(q ? { q } : {}),
      ...(createdAfterRes.value !== undefined
        ? { createdAfter: createdAfterRes.value }
        : {}),
      ...(createdBeforeRes.value !== undefined
        ? { createdBefore: createdBeforeRes.value }
        : {}),
    });
    // Federated listing (issue #132 M3) — opt-in via `?include_remotes=1`.
    // Without it this is exactly the local page it always was.
    const body = await federatedListBody(c, {
      kv: services.kv,
      crypto: deps.federationCrypto,
      tenantId: c.var.tenant_id,
      resource: "sessions",
      limit,
      localItems: page.items.map((row) => toApiSession(row as never)) as unknown as FederatedRow[],
      localNextCursor: page.nextCursor,
    });
    return c.json({
      ...body,
      // `next_page` is the legacy spelling of the same cursor; keep both.
      ...(body.next_cursor ? { next_page: body.next_cursor } : {}),
    });
  });

  app.get("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const response: Record<string, unknown> = { ...toApiSession(sess as never) };
    const live = await router.getFullStatus(id);
    if (live) {
      response.status = live.status;
      response.usage = live.usage;
      if (live.outcome_evaluations) response.outcome_evaluations = live.outcome_evaluations;
      if (live.resources) response.resources = live.resources;
      if (live.sandbox_usage) response.sandbox_usage = live.sandbox_usage;
      response.sandbox_status = live.sandbox_status ?? "none";
    }
    response.outputs = live?.outputs ?? [];
    return c.json(response);
  });

  app.post("/:id/pause", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({ tenantId: c.var.tenant_id, sessionId: id });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const r = await router.pause(id);
    if (r.status >= 400) {
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    return c.json({ id, sandbox_status: "paused" as const });
  });

  app.post("/:id/resume", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({ tenantId: c.var.tenant_id, sessionId: id });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const r = await router.resume(id);
    if (r.status >= 400) {
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    return c.json({ id, sandbox_status: "running" as const });
  });

  // PATCH /:id/runtime — change the session-level model / reasoning-effort
  // override mid-session. Scoped to this session only: the agent record is
  // shared by every other session, so switching models here must never
  // write back to it. `null` clears an override and falls back to the
  // agent's configured model.
  app.patch("/:id/runtime", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({ tenantId: c.var.tenant_id, sessionId: id });
    if (!sess) return c.json({ error: "Session not found" }, 404);

    let body: { model?: string | null; reasoning_effort?: string | null };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } },
        400,
      );
    }
    const badField = (["model", "reasoning_effort"] as const).find((f) => {
      const v = body[f];
      return v !== undefined && v !== null && (typeof v !== "string" || v.trim() === "");
    });
    if (badField) {
      return c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `${badField} must be a non-empty string or null`,
          },
        },
        422,
      );
    }
    if (!router.updateRuntimeSettings) {
      return c.json(
        {
          type: "error",
          error: {
            type: "not_supported_error",
            message: "This runtime does not support changing the model mid-session",
          },
        },
        501,
      );
    }
    const r = await router.updateRuntimeSettings(id, {
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.reasoning_effort !== undefined ? { reasoningEffort: body.reasoning_effort } : {}),
    });
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });

  app.post("/:id/archive", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      const sess = await services.sessions.archive({
        tenantId: c.var.tenant_id,
        sessionId: c.req.param("id"),
      });
      return c.json(toApiSession(sess as never));
    } catch (err) {
      return mapSessionError(c, err);
    }
  });

  app.post("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{
      title?: string;
      metadata?: Record<string, unknown>;
    }>();
    try {
      const updated = await services.sessions.update({
        tenantId: c.var.tenant_id,
        sessionId: c.req.param("id"),
        title: body.title,
        metadata: body.metadata,
      });
      return c.json(toApiSession(updated as never));
    } catch (err) {
      return mapSessionError(c, err);
    }
  });

  app.delete("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const t = c.var.tenant_id;
    const sess = await services.sessions.get({ tenantId: t, sessionId: id });
    if (!sess) return c.json({ error: "Session not found" }, 404);

    // Best-effort runtime teardown — never blocks the row delete.
    await router.destroy(id).catch(() => undefined);

    // Local-runtime daemon dispose.
    const rid = (
      sess as unknown as {
        environment_snapshot?: { config?: { local?: { runtime_id?: string } } };
      }
    ).environment_snapshot?.config?.local?.runtime_id;
    if (rid && deps.lifecycle?.notifyDaemonDispose) {
      await deps.lifecycle
        .notifyDaemonDispose({ runtimeId: rid, sessionId: id })
        .catch(() => undefined);
    }

    try {
      await services.sessions.delete({ tenantId: t, sessionId: id });
    } catch (err) {
      return mapSessionError(c, err);
    }

    if (deps.lifecycle?.cascadeDeleteFiles) {
      await deps.lifecycle
        .cascadeDeleteFiles({ tenantId: t, sessionId: id })
        .catch((err) => console.warn("[sessions] cascade-delete failed:", err));
    }

    return c.json({ type: "session_deleted", id });
  });

  // ── Events ────────────────────────────────────────────────────────────
  app.post("/:id/events", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const t = c.var.tenant_id;
    const sess = await services.sessions.get({ tenantId: t, sessionId: id });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    if ((sess as unknown as { archived_at?: string | null }).archived_at) {
      return c.json({ error: "Session is archived and cannot receive new events" }, 409);
    }
    const body = await c.req.json<{ events: SessionEvent[] }>();
    if (!Array.isArray(body.events) || body.events.length === 0) {
      return c.json({ error: "events array is required" }, 400);
    }
    for (const ev of body.events) {
      if (!ALLOWED_EVENT_TYPES.has(ev.type)) {
        return c.json({ error: `Unsupported event type: ${ev.type}` }, 400);
      }
    }

    for (const ev of body.events) {
      let outgoing: SessionEvent = ev;
      if (
        (ev.type === "user.message" || ev.type === "user.custom_tool_result") &&
        deps.lifecycle?.resolveFileIds
      ) {
        const e = ev as { content?: ContentBlock[] };
        if (Array.isArray(e.content)) {
          try {
            const { blocks, mountFileIds } = await deps.lifecycle.resolveFileIds({
              tenantId: t,
              blocks: e.content,
            });
            outgoing = {
              ...ev,
              content: blocks,
              ...(mountFileIds.length > 0 ? { _mount_file_ids: mountFileIds } : {}),
            } as SessionEvent;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.json({ error: `file_id resolution failed: ${msg}` }, 400);
          }
        }
      }
      const result = await router.appendEvent(id, outgoing);
      if (result.status >= 400) {
        return new Response(result.body, {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return c.body(null, 202);
  });

  // ── Messages convenience (one-shot user.message + stream) ─────────────
  app.post("/:id/messages", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const t = c.var.tenant_id;
    const sess = await services.sessions.get({ tenantId: t, sessionId: id });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const body = await c.req
      .json<{ content: string | ContentBlock[] }>()
      .catch(() => ({ content: "" as string | ContentBlock[] }));
    const content: ContentBlock[] = typeof body.content === "string"
      ? [{ type: "text", text: body.content } as ContentBlock]
      : Array.isArray(body.content) ? body.content : [];
    if (content.length === 0) {
      return c.json({ error: "content is required (string or ContentBlock[])" }, 400);
    }
    const userMessageId = generateEventId();
    const ev = {
      type: "user.message",
      id: userMessageId,
      content,
    } as unknown as UserMessageEvent;

    // /messages is OMA-only sugar (Anthropic spec doesn't have it). Always
    // open the underlying stream with chunks admitted so the in-turn matcher
    // below sees the full chunk lifecycle and the SDK's onText/onThinking
    // hooks fire. **Open the stream BEFORE appending the user.message** —
    // post-stream-split the default streamEvents doesn't replay history,
    // so a user.message broadcast before the stream attaches would be
    // lost and inTurn would never trigger.
    const handle = await router.streamEvents(id, { include: ["chunks"] });
    const append = await router.appendEvent(id, ev);
    if (append.status >= 400) {
      handle.close();
      return new Response(append.body, {
        status: append.status,
        headers: { "content-type": "application/json" },
      });
    }
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let inTurn = false;
        let closed = false;
        const closeOnce = () => {
          if (closed) return;
          closed = true;
          handle.close();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        try {
          for await (const frame of handle) {
            let parsed: { type?: string; id?: string } | null = null;
            try {
              parsed = JSON.parse(frame.data) as { type?: string; id?: string };
            } catch {
              /* ignore */
            }
            // Same SSE-named-event format as openSse() — Anthropic SDKs
            // discriminate on the SSE event name field, not on data.type.
            const eventLine = parsed?.type ? `event: ${parsed.type}\n` : "";
            if (!inTurn) {
              if (parsed?.type === "user.message" && parsed.id === userMessageId) {
                inTurn = true;
                controller.enqueue(enc.encode(`${eventLine}data: ${frame.data}\n\n`));
              }
              continue;
            }
            controller.enqueue(enc.encode(`${eventLine}data: ${frame.data}\n\n`));
            if (parsed?.type === "session.status_idle") {
              closeOnce();
              return;
            }
          }
        } finally {
          closeOnce();
        }
      },
      cancel: () => handle.close(),
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  app.get("/:id/events", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const accept = c.req.header("Accept") || "";
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    if (accept.includes("text/event-stream")) {
      return openSse(c, router, id);
    }
    const after = c.req.query("after_seq");
    const limit = c.req.query("limit");
    const order = c.req.query("order") as "asc" | "desc" | undefined;
    const page = await router.getEvents(id, {
      afterSeq: after !== undefined ? Number(after) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
      order,
    });
    return c.json(page);
  });

  app.get("/:id/stream", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    return openSse(c, router, id);
  });

  app.get("/:id/events/stream", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    return openSse(c, router, id);
  });

  // ── Trajectory ────────────────────────────────────────────────────────
  app.get("/:id/trajectory", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    try {
      const trajectory = (await router.getTrajectory(sess as never, {
        fetchEnvironmentConfig: () =>
          deps.loadEnvironment
            ? deps.loadEnvironment({
                tenantId: c.var.tenant_id,
                environmentId: (sess as unknown as { environment_id: string }).environment_id,
              })
            : Promise.resolve(null),
      })) as { agent_config?: AgentConfig } & Record<string, unknown>;
      // buildTrajectory (packages/eval-core) embeds session.agent_snapshot
      // verbatim as agent_config — including the real mcp_servers[].
      // authorization_token — because eval-core is framework-agnostic and
      // has no HTTP boundary of its own. This route is the client-facing
      // seam, so redact here the same way the session GET route does
      // (issue #223 / mcp-server-redaction.ts).
      if (trajectory.agent_config) {
        trajectory.agent_config = {
          ...trajectory.agent_config,
          mcp_servers: redactMcpServers(trajectory.agent_config.mcp_servers),
        };
      }
      return c.json(trajectory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  // ── Pending events (AMA) ──────────────────────────────────────────────
  // GET /v1/sessions/:id/pending — list user.* events enqueued but not
  // yet drained by the harness. Forwards opaque query string (?session_
  // thread_id, ?include_cancelled) to the SessionRouter.
  app.get("/:id/pending", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const tenantId = c.var.tenant_id;
    const sessionId = c.req.param("id");
    const sess = await services.sessions.get({ tenantId, sessionId });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const url = new URL(c.req.url);
    const result = await router.getPending(sessionId, { rawSearch: url.search });
    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  });

  // ── LLM call body fetch ───────────────────────────────────────────────
  // GET /v1/sessions/:id/llm-calls/:event_id — read the persisted full
  // LLM request/response body for one span.model_request_end event.
  // CF reads from R2 (FILES_BUCKET); other runtimes return 501.
  app.get("/:id/llm-calls/:event_id", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const tenantId = c.var.tenant_id;
    const sessionId = c.req.param("id");
    const eventId = c.req.param("event_id");
    const sess = await services.sessions.get({ tenantId, sessionId });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const result = await router.getLlmCallBody(tenantId, sessionId, eventId);
    return new Response(result.body, {
      status: result.status,
      headers: {
        "content-type": result.contentType,
        ...(("contentLength" in result && result.contentLength != null)
          ? { "content-length": String(result.contentLength) }
          : {}),
      },
    });
  });

  // ── Debug recovery ────────────────────────────────────────────────────
  app.post("/:id/__debug_recovery__", async (c) => {
    if (!deps.debugRecoveryToken) return c.json({ error: "not found" }, 404);
    const provided =
      c.req.header("x-debug-token") ??
      (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (provided !== deps.debugRecoveryToken) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const r = await router.triggerDebugRecovery(id, provided);
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });

  // ── Exec ──────────────────────────────────────────────────────────────
  app.post("/:id/exec", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const body = await c.req
      .json<{ command: string; timeout_ms?: number }>()
      .catch(() => ({ command: "" }));
    if (!body.command) return c.json({ error: "command is required" }, 400);
    try {
      const r = await router.exec(id, body);
      return c.json(r);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // ── Files (sandbox path → file_id promotion) ──────────────────────────
  app.post("/:id/files", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const t = c.var.tenant_id;
    const sess = await services.sessions.get({ tenantId: t, sessionId: id });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json<{
      path: string;
      filename?: string;
      media_type?: string;
      downloadable?: boolean;
    }>();
    if (!body.path) return c.json({ error: "path is required" }, 400);
    if (!deps.lifecycle?.promoteSandboxFile) {
      return c.json({ error: "filesBlob not configured on this server" }, 500);
    }
    const buf = await router.readSandboxFile(id, body.path);
    if (!buf) return c.json({ error: "Cannot read sandbox path" }, 400);
    const filename = body.filename || body.path.split("/").pop() || "file";
    const ext = filename.toLowerCase().split(".").pop() || "";
    const guess: Record<string, string> = {
      pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/markdown",
      csv: "text/csv", json: "application/json",
    };
    const mediaType = body.media_type || guess[ext] || "application/octet-stream";
    const downloadable = body.downloadable === undefined ? true : body.downloadable === true;
    const row = await deps.lifecycle.promoteSandboxFile({
      tenantId: t,
      sessionId: id,
      sandboxPath: body.path,
      filename,
      mediaType,
      downloadable,
      bytes: buf,
    });
    return c.json(row, 201);
  });

  // ── Resources ─────────────────────────────────────────────────────────
  app.post("/:id/resources", async (c) => {
    const services = resolveServices(deps.services, c);
    const sessionId = c.req.param("id");
    const t = c.var.tenant_id;
    const body = await c.req.json<{
      type: "file" | "memory_store";
      file_id?: string;
      memory_store_id?: string;
      mount_path?: string;
      access?: "read_write" | "read_only";
      instructions?: string;
    }>();
    if (!body.type) return c.json({ error: "type is required" }, 400);
    if (body.type === "file") {
      if (!body.file_id) return c.json({ error: "file_id is required for file resources" }, 400);
    }
    if (body.type === "memory_store" && !body.memory_store_id) {
      return c.json({ error: "memory_store_id is required for memory_store resources" }, 400);
    }
    try {
      let fileId = body.file_id;
      if (body.type === "file" && body.file_id && deps.lifecycle?.fileExists) {
        const exists = await deps.lifecycle.fileExists({
          tenantId: t,
          fileId: body.file_id,
        });
        if (!exists) return c.json({ error: "File not found" }, 404);
      }
      const added = await services.sessions.addResource({
        tenantId: t,
        sessionId,
        resource: {
          type: body.type,
          file_id: fileId,
          memory_store_id: body.memory_store_id,
          mount_path: body.mount_path,
          access:
            body.type === "memory_store"
              ? body.access === "read_only"
                ? "read_only"
                : "read_write"
              : undefined,
          instructions:
            body.type === "memory_store" && typeof body.instructions === "string"
              ? body.instructions.slice(0, 4096)
              : undefined,
        } as never,
      });
      return c.json(added.resource, 201);
    } catch (err) {
      return mapSessionError(c, err);
    }
  });

  app.get("/:id/resources", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      const rs = await services.sessions.listResources({
        tenantId: c.var.tenant_id,
        sessionId: c.req.param("id"),
      });
      return c.json({ data: rs.map((r) => r.resource) });
    } catch (err) {
      return mapSessionError(c, err);
    }
  });

  app.get("/:id/resources/:resource_id", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      const row = await services.sessions.getResource({
        tenantId: c.var.tenant_id,
        sessionId: c.req.param("id"),
        resourceId: c.req.param("resource_id"),
      });
      if (!row) return c.json({ error: "Resource not found" }, 404);
      return c.json(row.resource);
    } catch (err) {
      return mapSessionError(c, err);
    }
  });

  app.post("/:id/resources/:resource_id", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      const body = await c.req.json<SessionResource>();
      if (!body || typeof body !== "object" || !body.type) {
        return c.json({ error: "resource body with `type` field is required" }, 400);
      }
      const row = await services.sessions.updateResource({
        tenantId: c.var.tenant_id,
        sessionId: c.req.param("id"),
        resourceId: c.req.param("resource_id"),
        resource: body,
      });
      return c.json(row.resource);
    } catch (err) {
      return mapSessionError(c, err);
    }
  });

  app.delete("/:id/resources/:resource_id", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      await services.sessions.deleteResource({
        tenantId: c.var.tenant_id,
        sessionId: c.req.param("id"),
        resourceId: c.req.param("resource_id"),
      });
      return c.json({ type: "resource_deleted", id: c.req.param("resource_id") });
    } catch (err) {
      return mapSessionError(c, err);
    }
  });

  // ── Threads ───────────────────────────────────────────────────────────
  app.get("/:id/threads", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const list = await router.listThreads(id);
    return c.json(list);
  });

  app.get("/:id/threads/:thread_id", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const r = await router.getThread(id, c.req.param("thread_id"));
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });

  app.post("/:id/threads/:thread_id/archive", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const r = await router.archiveThread(id, c.req.param("thread_id"));
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });

  app.get("/:id/threads/:thread_id/events", async (c) => {
    const services = resolveServices(deps.services, c);
    const router = resolveRouter(deps.router, c);
    const id = c.req.param("id");
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const after = c.req.query("after_seq");
    const limit = c.req.query("limit");
    const page = await router.getThreadEvents(id, c.req.param("thread_id"), {
      afterSeq: after !== undefined ? Number(after) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
    return c.json(page);
  });

  app.get("/:id/threads/:thread_id/stream", (c) =>
    openSse(c, resolveRouter(deps.router, c), c.req.param("id"), c.req.param("thread_id")),
  );
  app.get("/:id/threads/:thread_id/events/stream", (c) =>
    openSse(c, resolveRouter(deps.router, c), c.req.param("id"), c.req.param("thread_id")),
  );

  // ── Outputs (R2 / local FS — adapter-driven) ──────────────────────────
  app.get("/:id/outputs", async (c) => {
    if (!deps.outputs) return c.json({ data: [], has_more: false });
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const t = c.var.tenant_id;
    const sess = await services.sessions.get({ tenantId: t, sessionId: id });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const data = await deps.outputs.list(t, id);
    return c.json({ data: data ?? [], has_more: false });
  });

  app.get("/:id/outputs/:filename", async (c) => {
    if (!deps.outputs) return c.json({ error: "outputs not configured" }, 404);
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const filename = c.req.param("filename");
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    const sess = await services.sessions.get({
      tenantId: c.var.tenant_id,
      sessionId: id,
    });
    if (!sess) return c.json({ error: "Session not found" }, 404);
    const obj = await deps.outputs.read(c.var.tenant_id, id, filename);
    if (!obj) return c.json({ error: "Output file not found" }, 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.contentType,
        "Content-Length": String(obj.size),
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  });

  // Re-export utility imports referenced only when no path hits — keeps
  // the bundler from tree-shaking shared/file-storage symbols that
  // CF callers expect at runtime.
  void generateFileId;
  void guessSessionOutputMime;
  void nanoid;

  return app;
}

async function openSse(
  c: Context<Vars>,
  router: SessionRouter,
  sessionId: string,
  threadId?: string,
): Promise<Response> {
  const lastEventId = parseInt(c.req.header("Last-Event-ID") ?? "", 10);
  // Spec-vs-extension opt-in (default = Anthropic-spec wire behavior):
  //   ?include=chunks  → admit OMA extension events (chunks, lifecycle,
  //                      system.*, session.warning, extra spans)
  //   ?replay=1        → replay full persisted history before tailing
  //                      (Last-Event-ID also implies replay-from-seq, so
  //                      callers can resume cleanly without flag awareness)
  // See SPEC_EVENT_TYPES in @duyet/oma-api-types for the spec set.
  const include = (c.req.query("include") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const replay = c.req.query("replay") === "1";
  const handle = await router.streamEvents(sessionId, {
    threadId,
    lastEventId: Number.isFinite(lastEventId) ? lastEventId : undefined,
    replay,
    include,
  });
  const enc = new TextEncoder();
  let closed = false;
  const closeHandle = () => {
    if (closed) return;
    closed = true;
    handle.close();
  };
  const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: string) => {
    if (closed) return false;
    try {
      controller.enqueue(enc.encode(chunk));
      return true;
    } catch {
      closeHandle();
      return false;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!safeEnqueue(controller, "retry: 1000\n\n")) return;
        for await (const frame of handle) {
          let seq: number | undefined;
          let evType: string | undefined;
          try {
            const parsed = JSON.parse(frame.data) as { seq?: number; type?: string };
            seq = parsed.seq;
            evType = parsed.type;
          } catch {
            /* ignore */
          }
          // Emit SSE-named events ("event: <type>") in addition to the
          // data line. Anthropic's official SDKs use the SSE event-name
          // field as the discriminator (see anthropic-sdk-python
          // _streaming.py:84-130) and never yield frames where it's
          // missing — without this line the SDK's iterator hangs forever
          // even though the wire is delivering events.
          const eventLine = evType ? `event: ${evType}\n` : "";
          const idLine = seq !== undefined ? `id: ${seq}\n` : "";
          if (!safeEnqueue(controller, `${eventLine}${idLine}data: ${frame.data}\n\n`)) return;
        }
      } finally {
        closeHandle();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
    cancel: () => closeHandle(),
  });
  c.req.raw.signal?.addEventListener("abort", () => closeHandle());
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
