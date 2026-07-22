/**
 * ERR-L-06 regression: a failing retention prune must NOT be swallowed silently.
 *
 * Previously `this._store.prune(cutoff).catch(() => {})` dropped every prune
 * failure with zero observability, letting the audit store grow unbounded with
 * no signal. This test pins that a rejecting prune now emits a structured
 * warning while staying non-fatal (entry appends still succeed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEventBus } from "@dzupagent/core";
import type { DzupEventBus } from "@dzupagent/core";
import { defaultLogger } from "@dzupagent/core/utils";
import { AuditTrail, InMemoryAuditStore } from "../audit-trail.js";
import type { AuditEntry, AuditStore } from "../audit-trail.js";

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Store that appends normally but rejects on prune. */
class PruneFailingStore implements AuditStore {
  private readonly inner = new InMemoryAuditStore();
  append(entry: AuditEntry): Promise<void> {
    return this.inner.append(entry);
  }
  getByRun(runId: string): Promise<AuditEntry[]> {
    return this.inner.getByRun(runId);
  }
  getByAgent(agentId: string, limit?: number): Promise<AuditEntry[]> {
    return this.inner.getByAgent(agentId, limit);
  }
  getByCategory(
    category: Parameters<AuditStore["getByCategory"]>[0],
    limit?: number,
  ): Promise<AuditEntry[]> {
    return this.inner.getByCategory(category, limit);
  }
  getAll(limit?: number, offset?: number): Promise<AuditEntry[]> {
    return this.inner.getAll(limit, offset);
  }
  getLatest(): Promise<AuditEntry | undefined> {
    return this.inner.getLatest();
  }
  prune(): Promise<number> {
    return Promise.reject(new Error("prune boom"));
  }
}

describe("ERR-L-06 — audit-trail prune failure telemetry", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let bus: DzupEventBus;

  beforeEach(() => {
    warnSpy = vi.spyOn(defaultLogger, "warn").mockImplementation(() => {});
    bus = createEventBus();
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs a warning when retention prune rejects, without breaking appends", async () => {
    const store = new PruneFailingStore();
    const trail = new AuditTrail({ store, retentionDays: 1 });
    trail.attach(bus);

    // Prune fires on seq % 100 === 99 → need 100 mapped events.
    for (let i = 0; i < 100; i++) {
      bus.emit({ type: "agent:started", agentId: "a", runId: `r${i}` });
    }
    await tick();
    await tick();

    // Appends still succeeded (non-fatal).
    const entries = await store.getAll();
    expect(entries.length).toBe(100);

    // The prune failure is now observable.
    expect(warnSpy).toHaveBeenCalledWith(
      "[otel] audit-trail retention prune failed",
      expect.objectContaining({
        operation: "auditTrail.prune",
        error: "prune boom",
      }),
    );
  });
});
