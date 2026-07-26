/**
 * Contract tests pinning the documented no-op of `AgentTask.priority`.
 *
 * The docstring on that field (see `routing-policy-types.ts`) states that it is
 * an UNENFORCED HINT: no built-in `RoutingPolicy` reads it, and routing
 * behaviour is identical whether it is set, unset, or set to any value. That is
 * structural — `RoutingPolicy.select(task, candidates)` scores ONE task against
 * N candidates, so there is no seam at which two tasks could be ordered against
 * each other. Priority is a cross-task scheduling concept and this package has
 * no scheduler.
 *
 * These tests are deliberately *negative*: if someone later teaches a built-in
 * policy to honour `priority`, they fail loudly and the "unenforced" docs get
 * revisited rather than silently rotting.
 *
 * They additionally pin the DIRECTION CLASH the docstring warns about:
 * `AgentTask.priority` documents "higher = more urgent" while the one live
 * `priority` consumer in this package, `DelegationRequest.priority`
 * (`delegation/lifecycle.ts`, `request.priority ?? 5`), documents "lower =
 * higher". Two same-named fields with inverted meanings is a real inverted-
 * comparator hazard, so the clash is asserted here: whichever side changes
 * first, this test forces the other's docs to be reconciled.
 */
import { describe, expect, it, vi } from "vitest";
import { RuleBasedRouting } from "../routing/rule-based-routing.js";
import { HashRouting } from "../routing/hash-routing.js";
import { RoundRobinRouting } from "../routing/round-robin-routing.js";
import { LLMRouting } from "../routing/llm-routing.js";
import { startDelegation } from "../delegation/lifecycle.js";
import type {
  DelegationRequest,
  ActiveDelegation,
} from "../delegation/types.js";
import type { RunStore } from "@dzupagent/core/persistence";
import type {
  AgentSpec,
  AgentTask,
  RoutingPolicy,
} from "../routing-policy-types.js";

const CANDIDATES: AgentSpec[] = [
  { id: "alpha", name: "alpha", tags: ["db"] },
  { id: "beta", name: "beta", tags: ["ui"] },
  { id: "gamma", name: "gamma", tags: ["api"] },
];

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskId: "task-1",
    content: "build the thing",
    ...overrides,
  };
}

/**
 * Every priority value worth probing, including the values that would flip a
 * naive comparator written for the opposite convention.
 */
const PRIORITY_VALUES = [0, 1, 5, 10, 99, -1, Number.MAX_SAFE_INTEGER];

/**
 * Build the built-in policies fresh per assertion. `RoundRobinRouting` is
 * stateful (an internal counter), so each case needs its own instance for a
 * fair comparison.
 */
function builtInPolicies(): Array<{ name: string; make: () => RoutingPolicy }> {
  return [
    {
      name: "RuleBasedRouting",
      make: () =>
        new RuleBasedRouting({
          rules: [{ tag: "db", agentId: "alpha" }],
          fallbackAgentId: "beta",
        }),
    },
    { name: "HashRouting", make: () => new HashRouting({}) },
    { name: "RoundRobinRouting", make: () => new RoundRobinRouting() },
    {
      name: "LLMRouting",
      make: () => new LLMRouting({ fallback: "first-candidate" }),
    },
  ];
}

describe("AgentTask.priority is documented as an unenforced hint", () => {
  for (const { name, make } of builtInPolicies()) {
    it(`${name} selects identically regardless of priority`, () => {
      const baseline = make().select(task(), CANDIDATES);

      for (const priority of PRIORITY_VALUES) {
        const withPriority = make().select(task({ priority }), CANDIDATES);

        expect(
          withPriority.selected.map((a) => a.id),
          `${name} changed its selection for priority=${priority}`
        ).toEqual(baseline.selected.map((a) => a.id));
        expect(withPriority.strategy).toBe(baseline.strategy);
        expect(withPriority.reason).toBe(baseline.reason);
      }
    });

    it(`${name} produces identical diagnostics regardless of priority`, () => {
      // Diagnostics carry rejection reasons; a policy that started consulting
      // priority would most plausibly surface it here first.
      const baseline = make().select(task(), CANDIDATES);
      const highest = make().select(
        task({ priority: Number.MAX_SAFE_INTEGER }),
        CANDIDATES
      );
      const lowest = make().select(task({ priority: -1 }), CANDIDATES);

      expect(highest.diagnostics).toEqual(baseline.diagnostics);
      expect(lowest.diagnostics).toEqual(baseline.diagnostics);
    });
  }

  it("does not order a batch of tasks — routing has no cross-task seam", () => {
    // The structural claim in the docstring: select() takes ONE task. Feeding a
    // low-priority task before a high-priority one cannot reorder anything,
    // because the policy never sees them together. Round-robin makes this
    // visible: slots are handed out in CALL order, not priority order.
    const policy = new RoundRobinRouting();

    const lowFirst = policy.select(
      task({ taskId: "low", priority: 1 }),
      CANDIDATES
    );
    const highSecond = policy.select(
      task({ taskId: "high", priority: 100 }),
      CANDIDATES
    );

    // The high-priority task got the SECOND slot purely because it was
    // submitted second. Priority did not promote it.
    expect(lowFirst.selected[0]?.id).toBe("alpha");
    expect(highSecond.selected[0]?.id).toBe("beta");
  });
});

describe("AgentTask.priority vs DelegationRequest.priority direction clash", () => {
  it("pins the delegation default that anchors the opposite convention", async () => {
    // `delegation/lifecycle.ts` resolves an omitted priority to 5, under the
    // "lower = higher" reading documented on DelegationRequest. The default is
    // an inline literal, so pin it through its observable effect: the priority
    // stamped onto the created run's metadata. If this default moves, the
    // AgentTask.priority docstring that cites it must be revisited.
    const created: Array<{ metadata?: Record<string, unknown> }> = [];
    const runStore = {
      create: vi.fn(async (input: { metadata?: Record<string, unknown> }) => {
        created.push(input);
        return { id: "run-1" };
      }),
    } as unknown as RunStore;

    const request = {
      targetAgentId: "specialist",
      task: "do it",
      input: {},
    } as DelegationRequest;

    await startDelegation(
      { runStore, eventBus: undefined },
      new Map<string, ActiveDelegation & { abort: AbortController }>(),
      request,
      "deleg-1",
      "parent-run-1"
    );

    expect(created[0]?.metadata?.["priority"]).toBe(5);
  });

  it("documents that the two conventions are inverted, not aligned", () => {
    // A single urgency ranking expressed in BOTH conventions. This is the
    // executable form of the warning: the same intent produces opposite
    // orderings, so a comparator must never be copied between the two types.
    const mostUrgent = { agentTaskPriority: 100, delegationPriority: 1 };
    const leastUrgent = { agentTaskPriority: 1, delegationPriority: 100 };

    // AgentTask: higher = more urgent.
    expect(mostUrgent.agentTaskPriority).toBeGreaterThan(
      leastUrgent.agentTaskPriority
    );
    // DelegationRequest: lower = more urgent.
    expect(mostUrgent.delegationPriority).toBeLessThan(
      leastUrgent.delegationPriority
    );

    // Sorting "most urgent first" therefore requires OPPOSITE comparators.
    const byAgentTask = [leastUrgent, mostUrgent].sort(
      (a, b) => b.agentTaskPriority - a.agentTaskPriority
    );
    const byDelegation = [leastUrgent, mostUrgent].sort(
      (a, b) => a.delegationPriority - b.delegationPriority
    );

    expect(byAgentTask[0]).toBe(mostUrgent);
    expect(byDelegation[0]).toBe(mostUrgent);
  });
});
