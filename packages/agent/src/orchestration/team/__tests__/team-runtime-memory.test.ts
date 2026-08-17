/**
 * Runtime behavior tests for the post-run memory consolidation seam.
 *
 * `memory.consolidateOnComplete` is enforced behind a host-injected
 * `TeamRuntimeMemoryService`. These tests pin the four reachable outcomes:
 *
 *   - policy off              -> no consolidation events at all
 *   - declared + wired + ok   -> `team_consolidation_completed`
 *   - declared + unwired      -> `team_consolidation_skipped` (reason 'unwired')
 *   - declared + wired + throw -> `team_consolidation_skipped` (reason 'failed')
 *
 * The last two are the point of the suite: both previously returned silently,
 * making a never-performed consolidation indistinguishable from a successful
 * one. The `failed` case matters most — a store that rejects on every run was
 * completely invisible, because the failure is deliberately swallowed to keep
 * consolidation non-fatal.
 */
import { describe, expect, it, vi } from "vitest";
import { consolidateIfEnabled } from "../team-runtime-memory.js";
import type { TeamRuntimeMemoryService } from "../team-runtime-memory.js";
import type { TeamPolicies } from "../team-policy.js";
import type { TeamRuntimeEvent } from "../team-runtime-events.js";

function memoryPolicy(consolidateOnComplete: boolean): TeamPolicies {
  return {
    memory: {
      tier: "ephemeral",
      shareAcrossParticipants: true,
      consolidateOnComplete,
    },
  };
}

function collectEvents(): {
  events: TeamRuntimeEvent[];
  emitEvent: (event: TeamRuntimeEvent) => void;
} {
  const events: TeamRuntimeEvent[] = [];
  return { events, emitEvent: (event) => events.push(event) };
}

async function run(options: {
  policies: TeamPolicies;
  memory?: TeamRuntimeMemoryService;
}): Promise<TeamRuntimeEvent[]> {
  const { events, emitEvent } = collectEvents();
  await consolidateIfEnabled({
    teamId: "team-mem",
    runId: "run-mem",
    policies: options.policies,
    memory: options.memory,
    emitEvent,
  });
  return events;
}

describe("consolidateIfEnabled", () => {
  it("does nothing when the policy does not request consolidation", async () => {
    const consolidate = vi.fn(async () => {});
    const events = await run({
      policies: memoryPolicy(false),
      memory: { consolidate },
    });

    // An undeclared pass is genuinely a no-op: it must not consolidate, and it
    // must not report a skip either (nothing was asked for, so nothing is
    // missing — a skip here would be noise that hides the real misconfigs).
    expect(consolidate).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("consolidates and reports completion when a service is wired", async () => {
    const consolidate = vi.fn(async () => {});
    const events = await run({
      policies: memoryPolicy(true),
      memory: { consolidate },
    });

    expect(consolidate).toHaveBeenCalledExactlyOnceWith("team-mem", "team-mem");
    expect(events).toEqual([
      {
        type: "team_consolidation_completed",
        teamId: "team-mem",
        runId: "run-mem",
        namespace: "team-mem",
        at: expect.any(Date),
      },
    ]);
  });

  it("reports a skip when consolidation is declared but no service is wired", async () => {
    const events = await run({ policies: memoryPolicy(true) });

    expect(events).toEqual([
      {
        type: "team_consolidation_skipped",
        teamId: "team-mem",
        runId: "run-mem",
        namespace: "team-mem",
        reason: "unwired",
        at: expect.any(Date),
      },
    ]);
    // No fabricated success: the completion event must NOT be emitted, or a
    // dashboard counting it would report consolidation that never happened.
    expect(events.some((e) => e.type === "team_consolidation_completed")).toBe(
      false
    );
  });

  it("omits `error` on an unwired skip because nothing ran to fail", async () => {
    const [event] = await run({ policies: memoryPolicy(true) });

    expect(event).toBeDefined();
    expect(event).not.toHaveProperty("error");
  });

  it("reports a skip with the error when a wired service throws", async () => {
    const consolidate = vi.fn(async () => {
      throw new Error("store unreachable");
    });
    const events = await run({
      policies: memoryPolicy(true),
      memory: { consolidate },
    });

    expect(consolidate).toHaveBeenCalledOnce();
    expect(events).toEqual([
      {
        type: "team_consolidation_skipped",
        teamId: "team-mem",
        runId: "run-mem",
        namespace: "team-mem",
        reason: "failed",
        error: "store unreachable",
        at: expect.any(Date),
      },
    ]);
  });

  it("reports a skip when a non-throwing consolidation result is degraded", async () => {
    const consolidate = vi.fn(async () => ({
      status: "degraded" as const,
      degradations: [
        {
          operation: "search" as const,
          impact: "source-unavailable" as const,
          // ERR-C-30: degradation reasons are stable codes, not driver text.
          reason: "backend-error" as const,
          errorId: "00000000-0000-4000-8000-000000000000",
        },
      ],
    }));
    const events = await run({
      policies: memoryPolicy(true),
      memory: { consolidate },
    });

    expect(events).toEqual([
      {
        type: "team_consolidation_skipped",
        teamId: "team-mem",
        runId: "run-mem",
        namespace: "team-mem",
        reason: "failed",
        error: "backend-error",
        at: expect.any(Date),
      },
    ]);
  });

  it("does not reject the run when a wired service throws", async () => {
    // Consolidation is a non-critical post-run step: reporting the failure must
    // not have converted it into a fatal one.
    await expect(
      run({
        policies: memoryPolicy(true),
        memory: {
          consolidate: async () => {
            throw new Error("store unreachable");
          },
        },
      })
    ).resolves.toBeDefined();
  });

  it("stringifies a non-Error rejection rather than dropping the reason", async () => {
    const events = await run({
      policies: memoryPolicy(true),
      memory: {
        consolidate: async () => {
          throw "plain string failure";
        },
      },
    });

    expect(events[0]).toMatchObject({
      type: "team_consolidation_skipped",
      reason: "failed",
      error: "plain string failure",
    });
  });

  it("survives an observer that throws while reporting a failure", async () => {
    // The emit happens inside the catch block of a step whose whole contract is
    // to be non-fatal. A throwing observer must not convert a swallowed
    // consolidation failure into a failed run.
    const emitEvent = vi.fn(() => {
      throw new Error("observer exploded");
    });

    await expect(
      consolidateIfEnabled({
        teamId: "team-mem",
        runId: "run-mem",
        policies: memoryPolicy(true),
        memory: {
          consolidate: async () => {
            throw new Error("store unreachable");
          },
        },
        emitEvent,
      })
    ).resolves.toBeUndefined();
    expect(emitEvent).toHaveBeenCalledOnce();
  });

  it("prefers the `consolidate` callback over a backing store", async () => {
    const consolidate = vi.fn(async () => {});
    const store = { search: vi.fn(), put: vi.fn(), delete: vi.fn() };
    const events = await run({
      policies: memoryPolicy(true),
      memory: {
        consolidate,
        store: store as unknown as NonNullable<TeamRuntimeMemoryService["store"]>,
      },
    });

    expect(consolidate).toHaveBeenCalledOnce();
    expect(store.search).not.toHaveBeenCalled();
    expect(events[0]?.type).toBe("team_consolidation_completed");
  });

  it("consolidates through the ConsolidationEngine when only a store is wired", async () => {
    const store = {
      search: vi.fn(async () => []),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const events = await run({
      policies: memoryPolicy(true),
      memory: { store: store as unknown as NonNullable<TeamRuntimeMemoryService["store"]> },
    });

    // The engine is reached (it queries the store), and the pass reports
    // completion rather than a skip.
    expect(store.search).toHaveBeenCalled();
    expect(events[0]?.type).toBe("team_consolidation_completed");
  });

  it("does not report completion when the backing store search fails", async () => {
    const store = {
      search: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const events = await run({
      policies: memoryPolicy(true),
      memory: { store: store as unknown as NonNullable<TeamRuntimeMemoryService["store"]> },
    });

    expect(events[0]).toMatchObject({
      type: "team_consolidation_skipped",
      reason: "failed",
      // ERR-C-30: the engine's degradation reports a stable code, not the
      // store's raw message.
      error: "backend-error",
    });
    expect(events.some((event) => event.type === "team_consolidation_completed"))
      .toBe(false);
  });
});
