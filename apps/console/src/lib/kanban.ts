/**
 * Column-placement + item model for the Kanban board (issue #22).
 *
 * Placement derives from EXISTING backend state only — no new status field
 * was invented for the board:
 *
 *   - sessions  → session `status` (idle | running | rescheduling |
 *     terminated, see AGENTS.md "Session Lifecycle") plus the most recent
 *     event's `stop_reason` (`session.status_idle` carries
 *     `stop_reason: { type: "end_turn" | "requires_action" }`).
 *   - schedules → the `enabled` flag on the `agent_schedules` row
 *     (AGENTS.md "Agent Schedules"). Enabled schedules wait in Queued;
 *     disabled ones sit in Paused. That single boolean is the ONLY
 *     board move the backend can persist, which is why every other drag
 *     is refused (see `canMoveItem`).
 */

import type { SessionRecord } from "../types/session";

export type KanbanColumn = "queued" | "running" | "blocked" | "done" | "paused";

export const KANBAN_COLUMNS: ReadonlyArray<{ id: KanbanColumn; label: string }> = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
  { id: "paused", label: "Paused" },
];

/**
 * Minimal shape of a session's most recent event, as read from the
 * `/v1/sessions/:id/events?order=desc&limit=1` response — specifically
 * the INNER `data` payload (the wrapper is `{ seq, type, ts, data }`;
 * `stop_reason` lives on `data`, not the wrapper — see
 * apps/agent/src/runtime/session-do.ts's GET /events handler and how
 * SessionDetail.tsx unwraps `e.data` before use).
 */
export interface LastEventForKanban {
  type: string;
  stop_reason?: { type: string };
}

/** One `agent_schedules` row as returned by `GET /v1/schedules`. `enabled`
 *  crosses the wire as SQLite's 0/1 integer, so it's read permissively. */
export interface ScheduleRecord {
  id: string;
  agent_id: string;
  cron_expression: string;
  timezone?: string | null;
  input?: string | null;
  environment_id?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_run_status?: string | null;
  last_run_error?: string | null;
  last_session_id?: string | null;
  enabled: number | boolean;
  created_at: string;
  updated_at?: string | null;
}

export function isScheduleEnabled(s: ScheduleRecord): boolean {
  return s.enabled === true || s.enabled === 1;
}

/**
 * Places a session into one of the Kanban columns.
 *
 *   - `running`      → status === "running"
 *   - `terminated`   → done (terminal, nothing pending)
 *   - `rescheduling` → queued (container still provisioning; hasn't
 *                      actually started a turn yet — see AGENTS.md's
 *                      "rescheduled" lifecycle state)
 *   - `idle`         → ambiguous on its own (could be "never started"
 *                      or "finished a turn"), disambiguated via the
 *                      session's last event:
 *       - no events yet                                   → queued
 *       - last event is `session.status_idle` with
 *         `stop_reason.type === "requires_action"`        → blocked
 *       - otherwise (finished a turn, nothing pending)     → done
 *
 * `lastEvent` is `null` when the session genuinely has zero events (or
 * the last-event fetch resolved that way). Pass `undefined` while that
 * per-session fetch is still in flight — the board treats it the same
 * as `null` (renders "queued" optimistically) until the fetch settles,
 * rather than inventing an extra "unknown" column.
 *
 * Never returns "paused" — that column is schedule-only.
 */
export function deriveKanbanColumn(
  status: string | undefined,
  lastEvent: LastEventForKanban | null | undefined,
): KanbanColumn {
  if (status === "running") return "running";
  if (status === "terminated") return "done";
  if (status === "rescheduling") return "queued";

  // status is "idle" (or unset, which the server treats as idle too).
  if (!lastEvent) return "queued";
  if (lastEvent.type === "session.status_idle" && lastEvent.stop_reason?.type === "requires_action") {
    return "blocked";
  }
  return "done";
}

/** A schedule is a recurring intent, not a run: enabled ⇒ waiting for its
 *  next firing (Queued); disabled ⇒ Paused. Its actual runs appear on the
 *  board separately, as the sessions they create. */
export function deriveScheduleColumn(schedule: ScheduleRecord): KanbanColumn {
  return isScheduleEnabled(schedule) ? "queued" : "paused";
}

// ─── Unified item model ─────────────────────────────────────────────────────

interface KanbanItemBase {
  id: string;
  column: KanbanColumn;
  title: string;
  agentId: string;
  /** Resolved from the agents list when available; falls back to the id. */
  agentName?: string;
  /** Resolved from the agents list — used by the Model facet. */
  model?: string;
  environmentId?: string;
  /** Resolved from the environments list (`config.sandbox_provider`). */
  sandboxProvider?: string;
  createdAt: string;
  /** Last activity, when the source row tracks one. Drives the default sort. */
  updatedAt?: string;
}

export interface KanbanSessionItem extends KanbanItemBase {
  kind: "session";
  session: SessionRecord;
}

export interface KanbanScheduleItem extends KanbanItemBase {
  kind: "schedule";
  schedule: ScheduleRecord;
}

export type KanbanItem = KanbanSessionItem | KanbanScheduleItem;

/** Per-agent metadata the board overlays onto items so filtering by model
 *  reads a real field rather than a guess. */
export interface AgentLookupEntry {
  name?: string;
  model?: string;
}

export interface BoardLookups {
  agents?: Record<string, AgentLookupEntry>;
  /** environment_id → sandbox provider id. */
  providers?: Record<string, string>;
}

export function toSessionItem(
  session: SessionRecord,
  lastEvent: LastEventForKanban | null | undefined,
  lookups: BoardLookups = {},
): KanbanSessionItem {
  const agentId = session.agent.id;
  const agent = lookups.agents?.[agentId];
  return {
    kind: "session",
    id: session.id,
    column: deriveKanbanColumn(session.status, lastEvent),
    title: session.title?.trim() || "Untitled",
    agentId,
    agentName: agent?.name,
    model: agent?.model,
    environmentId: session.environment_id,
    sandboxProvider: lookups.providers?.[session.environment_id],
    createdAt: session.created_at,
    updatedAt: session.updated_at ?? undefined,
    session,
  };
}

export function toScheduleItem(
  schedule: ScheduleRecord,
  lookups: BoardLookups = {},
): KanbanScheduleItem {
  const agent = lookups.agents?.[schedule.agent_id];
  const envId = schedule.environment_id ?? undefined;
  return {
    kind: "schedule",
    id: schedule.id,
    column: deriveScheduleColumn(schedule),
    title: schedule.input?.trim() || describeCron(schedule.cron_expression),
    agentId: schedule.agent_id,
    agentName: agent?.name,
    model: agent?.model,
    environmentId: envId,
    sandboxProvider: envId ? lookups.providers?.[envId] : undefined,
    createdAt: schedule.created_at,
    updatedAt: schedule.updated_at ?? schedule.last_run_at ?? undefined,
    schedule,
  };
}

// ─── Cron → human label ─────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Renders `minute hour` as HH:MM when both are plain numbers, else null. */
function clockLabel(minute: string, hour: string): string | null {
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  return `${pad(Number(hour))}:${pad(Number(minute))}`;
}

function dayList(dow: string): string | null {
  const parts = dow.split(",");
  const names: string[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p) % 7;
    if (n > 6) return null;
    names.push(DAY_NAMES[n]);
  }
  return names.join(",");
}

/**
 * Best-effort human label for a 5-field cron — enough for a repeat badge
 * ("Weekly Mon 09:00"). Anything it can't confidently describe falls back to
 * the raw expression rather than guessing wrong.
 */
export function describeCron(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron.trim();
  const [minute, hour, dom, month, dow] = f;

  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every minute";
  }

  const everyNMin = /^\*\/(\d+)$/.exec(minute);
  if (everyNMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every ${everyNMin[1]} min`;
  }

  const everyNHour = /^\*\/(\d+)$/.exec(hour);
  if (everyNHour && /^\d+$/.test(minute) && dom === "*" && month === "*" && dow === "*") {
    return `Every ${everyNHour[1]}h at :${pad(Number(minute))}`;
  }

  if (minute === "*" && /^\d+$/.test(hour)) {
    return `Hourly window ${pad(Number(hour))}:00`;
  }

  const clock = clockLabel(minute, hour);
  if (!clock) return cron.trim();

  if (dom === "*" && month === "*" && dow === "*") return `Daily ${clock}`;
  if (dom === "*" && month === "*" && dow !== "*") {
    const days = dayList(dow);
    return days ? `Weekly ${days} ${clock}` : cron.trim();
  }
  if (/^\d+$/.test(dom) && month === "*" && dow === "*") {
    return `Monthly day ${Number(dom)} ${clock}`;
  }
  return cron.trim();
}

// ─── Countdown ──────────────────────────────────────────────────────────────

/**
 * "in 2h 14m" style countdown for a schedule's `next_run_at`. Rendered from a
 * client-side ticking clock, so it takes the delta in ms rather than reading
 * `Date.now()` itself (keeps it pure + testable).
 *
 *  - `null` next run (unparseable cron never fires) → "not scheduled"
 *  - already past → "due now" (the per-minute tick hasn't claimed it yet)
 */
export function formatCountdown(msUntil: number | null): string {
  if (msUntil === null || !Number.isFinite(msUntil)) return "not scheduled";
  if (msUntil <= 0) return "due now";

  const s = Math.floor(msUntil / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}

// ─── Drag transitions ───────────────────────────────────────────────────────

export interface MoveVerdict {
  allowed: boolean;
  /** Why the move is refused — surfaced as the card's drag tooltip. */
  reason?: string;
  /** The `enabled` value to PATCH when the move IS allowed. */
  enabled?: boolean;
}

const SESSION_IMMOVABLE =
  "A session's column is derived from its own lifecycle — move it by acting on the session, not by dragging.";

/**
 * The only board move any backend state can absorb: flipping a schedule's
 * `enabled` flag between Queued and Paused. Everything else is refused with
 * the reason shown as a tooltip, rather than faking a transition the API
 * would drop on the next poll.
 */
export function canMoveItem(item: KanbanItem, to: KanbanColumn): MoveVerdict {
  if (item.kind === "session") {
    return { allowed: false, reason: SESSION_IMMOVABLE };
  }
  if (to === item.column) return { allowed: false };
  if (to === "paused") return { allowed: true, enabled: false };
  if (to === "queued") return { allowed: true, enabled: true };
  return {
    allowed: false,
    reason:
      "A schedule is a recurring intent — it can only be paused or resumed. Its runs appear as their own session cards.",
  };
}

/** Whether an item can be dragged anywhere at all (drives `draggable`). */
export function isDraggable(item: KanbanItem): boolean {
  return item.kind === "schedule";
}

// ─── Filters ────────────────────────────────────────────────────────────────

export const FILTER_ANY = "any";

export interface KanbanFilters {
  agent: string;
  model: string;
  provider: string;
  kind: string;
}

export const EMPTY_FILTERS: KanbanFilters = {
  agent: FILTER_ANY,
  model: FILTER_ANY,
  provider: FILTER_ANY,
  kind: FILTER_ANY,
};

export interface FacetOption {
  value: string;
  label: string;
}

/**
 * Facets are derived from what the items ACTUALLY carry — an agent/model/
 * provider only becomes selectable once some item on the board has it. That
 * keeps the bar honest: no dropdown offers a value nothing can match.
 */
export function collectFacets(items: KanbanItem[]): {
  agents: FacetOption[];
  models: FacetOption[];
  providers: FacetOption[];
  kinds: FacetOption[];
} {
  const agents = new Map<string, string>();
  const models = new Set<string>();
  const providers = new Set<string>();
  const kinds = new Set<string>();

  for (const it of items) {
    if (it.agentId) agents.set(it.agentId, it.agentName || it.agentId);
    if (it.model) models.add(it.model);
    if (it.sandboxProvider) providers.add(it.sandboxProvider);
    kinds.add(it.kind);
  }

  const sorted = (s: Set<string>): FacetOption[] =>
    [...s].sort().map((v) => ({ value: v, label: v }));

  return {
    agents: [...agents.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    models: sorted(models),
    providers: sorted(providers),
    kinds: [...kinds]
      .sort()
      .map((k) => ({ value: k, label: k === "schedule" ? "Schedules" : "Sessions" })),
  };
}

export function filterKanbanItems(items: KanbanItem[], filters: KanbanFilters): KanbanItem[] {
  return items.filter((it) => {
    if (filters.agent !== FILTER_ANY && it.agentId !== filters.agent) return false;
    if (filters.model !== FILTER_ANY && it.model !== filters.model) return false;
    if (filters.provider !== FILTER_ANY && it.sandboxProvider !== filters.provider) return false;
    if (filters.kind !== FILTER_ANY && it.kind !== filters.kind) return false;
    return true;
  });
}

// ─── Sorting ────────────────────────────────────────────────────────────────

export type KanbanSort = "recent" | "oldest" | "name";

export const KANBAN_SORTS: ReadonlyArray<{ id: KanbanSort; label: string }> = [
  { id: "recent", label: "Most recent" },
  { id: "oldest", label: "Oldest first" },
  { id: "name", label: "Name (A–Z)" },
];

function activityMs(item: KanbanItem): number {
  const t = Date.parse(item.updatedAt ?? item.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Default is "recent" — a board is read newest-first. Sorting is stable on
 *  id so equal timestamps don't shuffle between polls. */
export function sortKanbanItems(items: KanbanItem[], sort: KanbanSort): KanbanItem[] {
  const copy = [...items];
  copy.sort((a, b) => {
    let d = 0;
    if (sort === "name") d = a.title.localeCompare(b.title);
    else if (sort === "oldest") d = activityMs(a) - activityMs(b);
    else d = activityMs(b) - activityMs(a);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  return copy;
}

// ─── Column truncation ──────────────────────────────────────────────────────

/** Cards a collapsible column renders before the "Show more" expander. */
export const COLUMN_TRUNCATE_AT = 10;

export interface TruncatedColumn {
  visible: KanbanItem[];
  hiddenCount: number;
}

/** Done accumulates without bound, so it renders only the first `limit`
 *  cards until the user expands. `limit <= 0` disables truncation. */
export function truncateColumn(
  items: KanbanItem[],
  limit: number,
  expanded: boolean,
): TruncatedColumn {
  if (expanded || limit <= 0 || items.length <= limit) {
    return { visible: items, hiddenCount: 0 };
  }
  return { visible: items.slice(0, limit), hiddenCount: items.length - limit };
}

/** Groups items into every column, preserving the order given. */
export function groupByColumn(items: KanbanItem[]): Record<KanbanColumn, KanbanItem[]> {
  const grouped: Record<KanbanColumn, KanbanItem[]> = {
    queued: [],
    running: [],
    blocked: [],
    done: [],
    paused: [],
  };
  for (const it of items) grouped[it.column].push(it);
  return grouped;
}
