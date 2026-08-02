import { describe, expect, it } from "vitest";
import {
  canMoveItem,
  collectFacets,
  COLUMN_TRUNCATE_AT,
  deriveKanbanColumn,
  deriveScheduleColumn,
  describeCron,
  EMPTY_FILTERS,
  filterKanbanItems,
  formatCountdown,
  groupByColumn,
  isDraggable,
  sortKanbanItems,
  toScheduleItem,
  toSessionItem,
  truncateColumn,
  type KanbanItem,
  type ScheduleRecord,
} from "./kanban";
import type { SessionRecord } from "../types/session";

describe("deriveKanbanColumn", () => {
  it("places running sessions in the running column regardless of events", () => {
    expect(deriveKanbanColumn("running", null)).toBe("running");
    expect(deriveKanbanColumn("running", { type: "agent.tool_use" })).toBe("running");
  });

  it("places terminated sessions in done regardless of events", () => {
    expect(deriveKanbanColumn("terminated", null)).toBe("done");
    expect(
      deriveKanbanColumn("terminated", {
        type: "session.status_idle",
        stop_reason: { type: "requires_action" },
      }),
    ).toBe("done");
  });

  it("places rescheduling sessions in queued — container hasn't run yet", () => {
    expect(deriveKanbanColumn("rescheduling", null)).toBe("queued");
  });

  it("places a never-started idle session (no events) in queued", () => {
    expect(deriveKanbanColumn("idle", null)).toBe("queued");
    expect(deriveKanbanColumn(undefined, null)).toBe("queued");
  });

  it("treats an in-flight last-event fetch (undefined) the same as no events", () => {
    expect(deriveKanbanColumn("idle", undefined)).toBe("queued");
  });

  it("places an idle session whose last event requires action in blocked", () => {
    expect(
      deriveKanbanColumn("idle", {
        type: "session.status_idle",
        stop_reason: { type: "requires_action" },
      }),
    ).toBe("blocked");
  });

  it("places an idle session that finished a turn cleanly in done", () => {
    expect(
      deriveKanbanColumn("idle", {
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      }),
    ).toBe("done");
  });

  it("places an idle session with a status_idle event and no stop_reason in done", () => {
    expect(deriveKanbanColumn("idle", { type: "session.status_idle" })).toBe("done");
  });

  it("places an idle session whose last event is something else (e.g. post-error recovery) in done", () => {
    expect(deriveKanbanColumn("idle", { type: "session.error" })).toBe("done");
  });
});

// ─── Schedules on the board ─────────────────────────────────────────────────

function schedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "sch_1",
    agent_id: "agent_1",
    cron_expression: "0 9 * * 1",
    timezone: "UTC",
    input: "Post the weekly digest",
    environment_id: "env_1",
    next_run_at: "2026-08-03T09:00:00.000Z",
    enabled: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function sessionRow(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "ses_1",
    title: "A session",
    agent: { id: "agent_1", version: 1 },
    environment_id: "env_1",
    status: "running",
    created_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

describe("deriveScheduleColumn", () => {
  it("parks an enabled schedule in queued — it is waiting for its next firing", () => {
    expect(deriveScheduleColumn(schedule({ enabled: 1 }))).toBe("queued");
    expect(deriveScheduleColumn(schedule({ enabled: true }))).toBe("queued");
  });

  it("parks a disabled schedule in paused — the one state the API can persist", () => {
    expect(deriveScheduleColumn(schedule({ enabled: 0 }))).toBe("paused");
    expect(deriveScheduleColumn(schedule({ enabled: false }))).toBe("paused");
  });
});

describe("item construction", () => {
  it("overlays agent name/model and sandbox provider so facets read real fields", () => {
    const lookups = {
      agents: { agent_1: { name: "Digest bot", model: "claude-sonnet-4-6" } },
      providers: { env_1: "cloud" },
    };
    const item = toSessionItem(sessionRow(), null, lookups);
    expect(item).toMatchObject({
      kind: "session",
      agentName: "Digest bot",
      model: "claude-sonnet-4-6",
      sandboxProvider: "cloud",
      column: "running",
    });
  });

  it("titles a schedule by its input, falling back to the human cron", () => {
    expect(toScheduleItem(schedule()).title).toBe("Post the weekly digest");
    expect(toScheduleItem(schedule({ input: "  " })).title).toBe("Weekly Mon 09:00");
  });

  it("leaves model/provider undefined when nothing resolves them — no invented facet", () => {
    const item = toScheduleItem(schedule());
    expect(item.model).toBeUndefined();
    expect(item.sandboxProvider).toBeUndefined();
  });
});

describe("describeCron", () => {
  it("renders the common cadences a repeat badge needs", () => {
    expect(describeCron("0 9 * * 1")).toBe("Weekly Mon 09:00");
    expect(describeCron("30 6 * * *")).toBe("Daily 06:30");
    expect(describeCron("0 9 5 * *")).toBe("Monthly day 5 09:00");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 min");
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("0 9 * * 1,3")).toBe("Weekly Mon,Wed 09:00");
  });

  it("falls back to the raw expression rather than guessing wrong", () => {
    expect(describeCron("0 9 1-5 * *")).toBe("0 9 1-5 * *");
    expect(describeCron("not a cron")).toBe("not a cron");
  });
});

describe("formatCountdown", () => {
  it("ticks down through seconds, minutes, hours and days", () => {
    expect(formatCountdown(45_000)).toBe("in 45s");
    expect(formatCountdown(14 * 60_000)).toBe("in 14m");
    expect(formatCountdown((2 * 60 + 14) * 60_000)).toBe("in 2h 14m");
    expect(formatCountdown(26 * 60 * 60_000)).toBe("in 1d 2h");
  });

  it("says due now once the next run is in the past — the tick claims it, not the UI", () => {
    expect(formatCountdown(0)).toBe("due now");
    expect(formatCountdown(-5000)).toBe("due now");
  });

  it("says not scheduled when the cron never resolves a next run", () => {
    expect(formatCountdown(null)).toBe("not scheduled");
  });
});

describe("canMoveItem", () => {
  const enabled = toScheduleItem(schedule({ enabled: 1 }));
  const disabled = toScheduleItem(schedule({ enabled: 0 }));

  it("pauses a schedule dragged into Paused by clearing enabled", () => {
    expect(canMoveItem(enabled, "paused")).toEqual({ allowed: true, enabled: false });
  });

  it("resumes a paused schedule dragged back into Queued", () => {
    expect(canMoveItem(disabled, "queued")).toEqual({ allowed: true, enabled: true });
  });

  it("refuses columns no schedule state maps onto, with a reason for the tooltip", () => {
    const verdict = canMoveItem(enabled, "running");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/recurring intent/);
  });

  it("refuses every session drag — its column is derived, not stored", () => {
    const s = toSessionItem(sessionRow(), null);
    expect(isDraggable(s)).toBe(false);
    const verdict = canMoveItem(s, "paused");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/derived from its own lifecycle/);
  });

  it("makes a drop back onto the same column a silent no-op", () => {
    expect(canMoveItem(enabled, "queued")).toEqual({ allowed: false });
  });
});

describe("filters", () => {
  const lookups = {
    agents: {
      agent_1: { name: "Digest bot", model: "claude-sonnet-4-6" },
      agent_2: { name: "Analyst", model: "claude-haiku-4-5" },
    },
    providers: { env_1: "cloud", env_2: "k8s-remote" },
  };
  const items: KanbanItem[] = [
    toSessionItem(sessionRow({ id: "ses_1" }), null, lookups),
    toSessionItem(
      sessionRow({ id: "ses_2", agent: { id: "agent_2", version: 1 }, environment_id: "env_2" }),
      null,
      lookups,
    ),
    toScheduleItem(schedule(), lookups),
  ];

  it("offers only facet values some item on the board actually carries", () => {
    const facets = collectFacets(items);
    expect(facets.agents.map((a) => a.label)).toEqual(["Analyst", "Digest bot"]);
    expect(facets.models.map((m) => m.value)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    ]);
    expect(facets.providers.map((p) => p.value)).toEqual(["cloud", "k8s-remote"]);
    expect(facets.kinds.map((k) => k.value)).toEqual(["schedule", "session"]);
  });

  it("omits a facet entirely when no item carries the field", () => {
    expect(collectFacets([toScheduleItem(schedule())]).models).toEqual([]);
  });

  it("passes everything through when nothing is filtered", () => {
    expect(filterKanbanItems(items, EMPTY_FILTERS)).toHaveLength(3);
  });

  it("filters by agent, model, provider and kind, and ANDs them together", () => {
    expect(filterKanbanItems(items, { ...EMPTY_FILTERS, agent: "agent_2" })).toHaveLength(1);
    expect(
      filterKanbanItems(items, { ...EMPTY_FILTERS, model: "claude-sonnet-4-6" }),
    ).toHaveLength(2);
    expect(filterKanbanItems(items, { ...EMPTY_FILTERS, provider: "k8s-remote" })).toHaveLength(1);
    expect(filterKanbanItems(items, { ...EMPTY_FILTERS, kind: "schedule" })).toHaveLength(1);
    expect(
      filterKanbanItems(items, { ...EMPTY_FILTERS, kind: "session", agent: "agent_1" }),
    ).toHaveLength(1);
    expect(
      filterKanbanItems(items, { ...EMPTY_FILTERS, kind: "schedule", agent: "agent_2" }),
    ).toHaveLength(0);
  });
});

describe("sortKanbanItems", () => {
  const a = toSessionItem(
    sessionRow({ id: "ses_a", title: "Beta", created_at: "2026-08-01T00:00:00.000Z" }),
    null,
  );
  const b = toSessionItem(
    sessionRow({ id: "ses_b", title: "Alpha", created_at: "2026-08-02T00:00:00.000Z" }),
    null,
  );

  it("defaults to newest activity first", () => {
    expect(sortKanbanItems([a, b], "recent").map((i) => i.id)).toEqual(["ses_b", "ses_a"]);
  });

  it("supports oldest-first and name sorts", () => {
    expect(sortKanbanItems([b, a], "oldest").map((i) => i.id)).toEqual(["ses_a", "ses_b"]);
    expect(sortKanbanItems([a, b], "name").map((i) => i.title)).toEqual(["Alpha", "Beta"]);
  });

  it("prefers updated_at over created_at so a refreshed row surfaces", () => {
    const refreshed = toSessionItem(
      sessionRow({
        id: "ses_c",
        created_at: "2020-01-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      }),
      null,
    );
    expect(sortKanbanItems([a, b, refreshed], "recent")[0].id).toBe("ses_c");
  });

  it("breaks ties on id so repeated polls don't shuffle cards", () => {
    const x = toSessionItem(sessionRow({ id: "ses_x" }), null);
    const y = toSessionItem(sessionRow({ id: "ses_y" }), null);
    expect(sortKanbanItems([y, x], "recent").map((i) => i.id)).toEqual(["ses_x", "ses_y"]);
  });

  it("does not mutate the input array", () => {
    const input = [b, a];
    sortKanbanItems(input, "oldest");
    expect(input.map((i) => i.id)).toEqual(["ses_b", "ses_a"]);
  });
});

describe("truncateColumn", () => {
  const many = Array.from({ length: COLUMN_TRUNCATE_AT + 4 }, (_, i) =>
    toSessionItem(sessionRow({ id: `ses_${i}` }), null),
  );

  it("caps a long column and reports what it hid", () => {
    const t = truncateColumn(many, COLUMN_TRUNCATE_AT, false);
    expect(t.visible).toHaveLength(COLUMN_TRUNCATE_AT);
    expect(t.hiddenCount).toBe(4);
  });

  it("shows everything once expanded", () => {
    expect(truncateColumn(many, COLUMN_TRUNCATE_AT, true)).toEqual({
      visible: many,
      hiddenCount: 0,
    });
  });

  it("leaves a short column alone", () => {
    const few = many.slice(0, 3);
    expect(truncateColumn(few, COLUMN_TRUNCATE_AT, false)).toEqual({
      visible: few,
      hiddenCount: 0,
    });
  });
});

describe("groupByColumn", () => {
  it("buckets mixed sessions and schedules into all five columns", () => {
    const grouped = groupByColumn([
      toSessionItem(sessionRow({ id: "ses_run", status: "running" }), null),
      toSessionItem(sessionRow({ id: "ses_done", status: "terminated" }), null),
      toScheduleItem(schedule({ id: "sch_on", enabled: 1 })),
      toScheduleItem(schedule({ id: "sch_off", enabled: 0 })),
    ]);
    expect(grouped.running.map((i) => i.id)).toEqual(["ses_run"]);
    expect(grouped.done.map((i) => i.id)).toEqual(["ses_done"]);
    expect(grouped.queued.map((i) => i.id)).toEqual(["sch_on"]);
    expect(grouped.paused.map((i) => i.id)).toEqual(["sch_off"]);
    expect(grouped.blocked).toEqual([]);
  });
});
