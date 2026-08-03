// Sandbox usage quota — per-(tenant, provider) usage tracking.
//
// OSS mode records usage in-memory for visibility but does not enforce
// any credit limit. Cloudflare/Cloud Node mode writes usage events to
// the billing system which charges credits.
//
// The tracker is an in-memory ring buffer (configurable slot count) so
// it doesn't require a database yet. For persistence across restarts,
// wire a db-backed implementation through the same interface.

export interface SandboxUsageRecord {
  providerId: string;
  tenantId: string;
  sessionId: string;
  action: "exec" | "session_start" | "session_end";
  timestamp: string;
  /** Duration in ms (for session_start→session_end). */
  durationMs?: number;
}

export interface UsageStats {
  totalExecs: number;
  totalSessions: number;
  /** Sum of session durations in ms. */
  totalDurationMs: number;
  /** Per-provider breakdown. */
  byProvider: Record<string, {
    execs: number;
    sessions: number;
    durationMs: number;
  }>;
}

export interface SandboxQuotaStore {
  record(entry: SandboxUsageRecord): void;
  /** Get stats for a tenant, optionally filtered by provider. */
  getStats(tenantId: string, providerId?: string): UsageStats;
  /** List recent records for a tenant. */
  listRecent(tenantId: string, limit?: number): SandboxUsageRecord[];
}

/**
 * In-memory ring-buffer usage store. Persists nothing across restarts.
 * Suitable for OSS mode where credits are not enforced.
 */
export class InMemoryQuotaStore implements SandboxQuotaStore {
  private records: SandboxUsageRecord[] = [];
  private readonly maxRecords: number;

  constructor(maxRecords = 10_000) {
    this.maxRecords = maxRecords;
  }

  record(entry: SandboxUsageRecord): void {
    this.records.push(entry);
    // Trim old entries when over capacity
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  getStats(tenantId: string, providerId?: string): UsageStats {
    const relevant = providerId
      ? this.records.filter((r) => r.tenantId === tenantId && r.providerId === providerId)
      : this.records.filter((r) => r.tenantId === tenantId);

    const byProvider: UsageStats["byProvider"] = {};
    let totalExecs = 0;
    let totalSessions = 0;
    let totalDurationMs = 0;

    for (const r of relevant) {
      if (!byProvider[r.providerId]) {
        byProvider[r.providerId] = { execs: 0, sessions: 0, durationMs: 0 };
      }
      if (r.action === "exec") {
        totalExecs++;
        byProvider[r.providerId].execs++;
      } else if (r.action === "session_start") {
        totalSessions++;
        byProvider[r.providerId].sessions++;
      }
      if (r.durationMs) {
        totalDurationMs += r.durationMs;
        byProvider[r.providerId].durationMs += r.durationMs;
      }
    }

    return { totalExecs, totalSessions, totalDurationMs, byProvider };
  }

  listRecent(tenantId: string, limit = 100): SandboxUsageRecord[] {
    return this.records
      .filter((r) => r.tenantId === tenantId)
      .slice(-limit);
  }
}
