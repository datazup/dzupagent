/**
 * P4 HA scheduling — ScheduleTickWorker.
 *
 * The store-backed tick loop that replaces TriggerManager's per-process,
 * per-cron setInterval scheduling. One interval timer per node polls the shared
 * ScheduleStore via claimDue(skipIfRunning) and fires only the occurrences this
 * node won — so K nodes over one store fire a due cron exactly once.
 *
 * Mirrors MailDlqWorker: single setInterval (injectable interval + clock,
 * unref'd), re-entrancy guard, idempotent start/stop, manual tick() for tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScheduleTickWorker } from "../schedule-tick-worker.js";
import { InMemoryScheduleStore } from "../schedule-store.js";

const EVERY_5_MIN = "*/5 * * * *";

async function seed(
  store: InMemoryScheduleStore,
  id: string,
  nextRunAt: string
) {
  await store.save({
    id,
    name: id,
    cronExpression: EVERY_5_MIN,
    workflowText: "work",
    enabled: true,
    nextRunAt,
  });
}

describe("ScheduleTickWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tick claims a due schedule, fires it, and emits scheduler:triggered", async () => {
    const now = new Date("2026-06-17T10:06:00.000Z");
    const store = new InMemoryScheduleStore(() => now);
    await seed(store, "s1", "2026-06-17T10:05:00.000Z");

    const fired: string[] = [];
    const events: Array<{ type: string; scheduleId: string }> = [];
    const worker = new ScheduleTickWorker({
      store,
      claimerId: "node-a",
      onFire: async (claimed) => {
        fired.push(claimed.id);
        return `run-${claimed.id}`;
      },
      emit: (e) => events.push(e),
      now: () => now,
    });

    const result = await worker.tick();
    expect(result.fired).toBe(1);
    expect(fired).toEqual(["s1"]);
    expect(events).toContainEqual({
      type: "scheduler:triggered",
      scheduleId: "s1",
    });

    // markFired cleared running.
    const rec = await store.get("s1");
    expect(rec?.running).toBe(false);
    expect(rec?.lastFiredAt).toBeTruthy();
  });

  it("does not fire a not-yet-due schedule", async () => {
    const now = new Date("2026-06-17T10:06:00.000Z");
    const store = new InMemoryScheduleStore(() => now);
    await seed(store, "s1", "2026-06-17T10:10:00.000Z");

    const fired: string[] = [];
    const worker = new ScheduleTickWorker({
      store,
      claimerId: "node-a",
      onFire: async (c) => {
        fired.push(c.id);
        return "run";
      },
      now: () => now,
    });
    const result = await worker.tick();
    expect(result.fired).toBe(0);
    expect(fired).toEqual([]);
  });

  it("two workers over the same store do not double-fire a due schedule", async () => {
    const now = new Date("2026-06-17T10:06:00.000Z");
    const store = new InMemoryScheduleStore(() => now);
    await seed(store, "s1", "2026-06-17T10:05:00.000Z");

    const firedBy: string[] = [];
    const make = (id: string) =>
      new ScheduleTickWorker({
        store,
        claimerId: id,
        onFire: async (c) => {
          firedBy.push(`${id}:${c.id}`);
          return `run-${id}`;
        },
        now: () => now,
      });
    const a = make("node-a");
    const b = make("node-b");

    await Promise.all([a.tick(), b.tick()]);
    // Exactly one node fired s1.
    expect(firedBy).toHaveLength(1);
    expect(firedBy[0]).toMatch(/^node-[ab]:s1$/);
  });

  it("start() schedules a periodic tick; stop() halts it", async () => {
    const now = new Date("2026-06-17T10:06:00.000Z");
    const store = new InMemoryScheduleStore(() => now);
    await seed(store, "s1", "2026-06-17T10:05:00.000Z");

    let fired = 0;
    const worker = new ScheduleTickWorker({
      store,
      claimerId: "node-a",
      intervalMs: 5_000,
      onFire: async () => {
        fired += 1;
        return "run";
      },
      now: () => now,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(fired).toBe(1);

    await worker.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    // No further firing after stop (s1 already advanced anyway, but assert stable).
    expect(fired).toBe(1);
  });

  it("re-entrant ticks do not overlap", async () => {
    const now = new Date("2026-06-17T10:06:00.000Z");
    const store = new InMemoryScheduleStore(() => now);
    await seed(store, "s1", "2026-06-17T10:05:00.000Z");

    let inFlight = 0;
    let maxConcurrent = 0;
    const worker = new ScheduleTickWorker({
      store,
      claimerId: "node-a",
      onFire: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return "run";
      },
      now: () => now,
    });

    // Fire a second tick while the first is still awaiting.
    const t1 = worker.tick();
    const t2 = worker.tick();
    await Promise.all([t1, t2]);
    expect(maxConcurrent).toBeLessThanOrEqual(1);
  });

  it("rejects a non-positive interval", () => {
    const store = new InMemoryScheduleStore();
    expect(
      () =>
        new ScheduleTickWorker({
          store,
          claimerId: "n",
          intervalMs: 0,
          onFire: async () => "r",
        })
    ).toThrow();
  });
});
