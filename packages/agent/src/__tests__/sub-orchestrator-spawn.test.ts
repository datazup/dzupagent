/**
 * Recursive sub-orchestrator spawning (ORCHESTRATION_V2).
 *
 * Covers `DelegatingSupervisor.spawnSubOrchestrator` — the first dispatch site
 * that descends an orchestrator level rather than delegating to a specialist
 * leaf. The three properties under test that nothing else in the suite pins:
 *
 *  1. hierarchy propagation into the CHILD (parentRunId / branchId / depth),
 *     including the parentRunId disambiguation that this package repeatedly
 *     refuses to collapse;
 *  2. the depth ceiling enforced AT THE SPAWN SITE, before a child is built;
 *  3. failure propagation from child up to the spawning caller.
 *
 * Deliberately kept in its own file rather than appended to
 * `delegating-supervisor.test.ts`: that file installs a module-level
 * `vi.mock("../orchestration/planning-agent.js")`, and these tests exercise the
 * real keyword-planning path a spawned child runs.
 */

import { describe, it, expect, vi } from "vitest";
import { createEventBus } from "@dzupagent/core";
import type {
  DzupEvent,
  DzupEventBus,
  AgentExecutionSpec,
} from "@dzupagent/core";
import type {
  DelegationTracker,
  DelegationResult,
} from "../orchestration/delegation.js";
import {
  DelegatingSupervisor,
  MAX_ORCHESTRATION_DEPTH,
  type SubOrchestratorFactory,
  type SubOrchestratorSpawnOptions,
} from "../orchestration/delegating-supervisor.js";
import { OrchestrationError } from "../orchestration/orchestration-error.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpecialist(id: string): AgentExecutionSpec {
  return {
    id,
    name: id,
    instructions: `You are the ${id} specialist`,
    modelTier: "codegen",
    // A tag the keyword planner can match, so `planAndDelegate` reliably
    // produces exactly one assignment for the prompts used below.
    metadata: { tags: ["database"] },
  } as AgentExecutionSpec;
}

function makeTracker(
  result: DelegationResult = { success: true, output: "child-ok" }
): DelegationTracker {
  return {
    delegate: vi.fn(async () => result),
    getActiveDelegations: vi.fn(() => []),
    cancel: vi.fn(() => false),
  };
}

function makeThrowingTracker(error: Error): DelegationTracker {
  return {
    delegate: vi.fn(async () => {
      throw error;
    }),
    getActiveDelegations: vi.fn(() => []),
    cancel: vi.fn(() => false),
  };
}

/** A prompt the keyword planner maps onto the "database" tag. */
const CHILD_PROMPT = "design the database schema";

/**
 * Builds a spawning supervisor. `runId` is the supervisor's OWN run — the
 * identity it hands a child as the child's orchestrator-hierarchy parent.
 */
function makeSpawner(
  overrides: {
    runId?: string;
    depth?: number;
    factory?: SubOrchestratorFactory;
    eventBus?: DzupEventBus;
    parentContextRunId?: string;
  } = {}
): DelegatingSupervisor {
  return new DelegatingSupervisor({
    specialists: new Map([["db-agent", makeSpecialist("db-agent")]]),
    tracker: makeTracker(),
    ...(overrides.runId !== undefined ? { runId: overrides.runId } : {}),
    ...(overrides.depth !== undefined ? { depth: overrides.depth } : {}),
    ...(overrides.factory ? { subOrchestratorFactory: overrides.factory } : {}),
    ...(overrides.eventBus ? { eventBus: overrides.eventBus } : {}),
    ...(overrides.parentContextRunId !== undefined
      ? {
          parentContext: {
            parentRunId: overrides.parentContextRunId,
            decisions: [],
            constraints: [],
            relevantFiles: [],
          },
        }
      : {}),
  });
}

/**
 * A well-behaved factory: spreads the supplied hierarchy onto the child config
 * verbatim, which is the factory contract.
 */
function goodFactory(
  childTracker: DelegationTracker = makeTracker(),
  eventBus?: DzupEventBus
): SubOrchestratorFactory {
  return ({ hierarchy }) =>
    new DelegatingSupervisor({
      specialists: new Map([["db-agent", makeSpecialist("db-agent")]]),
      tracker: childTracker,
      ...(eventBus ? { eventBus } : {}),
      ...hierarchy,
    });
}

/**
 * Like {@link goodFactory}, but also gives the child a `runId` of its own so it
 * can in turn become a parent. Needed for any chained spawn.
 */
function chainableFactory(childRunId: string): SubOrchestratorFactory {
  return ({ hierarchy }) =>
    new DelegatingSupervisor({
      specialists: new Map([["db-agent", makeSpecialist("db-agent")]]),
      tracker: makeTracker(),
      runId: childRunId,
      ...hierarchy,
    });
}

function spawnOptions(
  overrides: Partial<SubOrchestratorSpawnOptions> = {}
): SubOrchestratorSpawnOptions {
  return {
    parentRunId: "spawner-run",
    branchId: "branch-left",
    depth: 1,
    inputPrompt: CHILD_PROMPT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Successful spawn + hierarchy propagation
// ---------------------------------------------------------------------------

describe("spawnSubOrchestrator — successful spawn", () => {
  it("propagates parentRunId, branchId and depth into the child", async () => {
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(),
    });

    const spawned = await spawner.spawnSubOrchestrator(spawnOptions());

    expect(spawned.hierarchy).toEqual({
      parentRunId: "spawner-run",
      branchId: "branch-left",
      depth: 1,
    });
    // The returned child agrees with the derived hierarchy.
    expect(spawned.supervisor.hierarchy).toEqual({
      parentRunId: "spawner-run",
      branchId: "branch-left",
      depth: 1,
    });
  });

  it("sets the child's depth to spawner depth + 1", async () => {
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 1,
      factory: goodFactory(),
    });

    const spawned = await spawner.spawnSubOrchestrator(
      spawnOptions({ depth: 2 })
    );

    expect(spawner.hierarchy.depth).toBe(1);
    expect(spawned.supervisor.hierarchy.depth).toBe(2);
  });

  it("takes branchId verbatim from the spawn options", async () => {
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(),
    });

    const spawned = await spawner.spawnSubOrchestrator(
      spawnOptions({ branchId: "branch-right" })
    );

    expect(spawned.supervisor.hierarchy.branchId).toBe("branch-right");
  });

  it("runs the child and returns its aggregated result", async () => {
    const childTracker = makeTracker({ success: true, output: "child-output" });
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(childTracker),
    });

    const spawned = await spawner.spawnSubOrchestrator(spawnOptions());

    expect(childTracker.delegate).toHaveBeenCalled();
    expect(spawned.result.failed).toEqual([]);
    expect(spawned.result.succeeded.length).toBeGreaterThan(0);
    const sole = [...spawned.result.results.values()][0]!;
    expect(sole.output).toBe("child-output");
  });

  it("passes the inputPrompt through to the child as its goal", async () => {
    const childTracker = makeTracker();
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(childTracker),
    });

    await spawner.spawnSubOrchestrator(
      spawnOptions({ inputPrompt: "design the database schema" })
    );

    const request = vi.mocked(childTracker.delegate).mock.calls[0]![0]!;
    expect(request.task).toContain("database");
  });

  it("hands the factory the full spawn options for persona/provider wiring", async () => {
    const seen: SubOrchestratorSpawnOptions[] = [];
    const factory: SubOrchestratorFactory = ({ hierarchy, options }) => {
      seen.push(options);
      return new DelegatingSupervisor({
        specialists: new Map([["db-agent", makeSpecialist("db-agent")]]),
        tracker: makeTracker(),
        ...hierarchy,
      });
    };
    const spawner = makeSpawner({ runId: "spawner-run", depth: 0, factory });

    await spawner.spawnSubOrchestrator(
      spawnOptions({
        personaId: "persona-x",
        preferredProvider: "anthropic",
        budgetCents: 250,
      })
    );

    expect(seen[0]).toMatchObject({
      personaId: "persona-x",
      preferredProvider: "anthropic",
      budgetCents: 250,
    });
  });

  it("accepts a per-call factory when none is configured", async () => {
    const spawner = makeSpawner({ runId: "spawner-run", depth: 0 });

    const spawned = await spawner.spawnSubOrchestrator(
      spawnOptions(),
      goodFactory()
    );

    expect(spawned.supervisor.hierarchy.parentRunId).toBe("spawner-run");
  });

  it("awaits an async factory", async () => {
    const factory: SubOrchestratorFactory = async ({ hierarchy }) => {
      // A real microtask boundary, without a timer the lint rule flags.
      await Promise.resolve();
      return new DelegatingSupervisor({
        specialists: new Map([["db-agent", makeSpecialist("db-agent")]]),
        tracker: makeTracker(),
        ...hierarchy,
      });
    };
    const spawner = makeSpawner({ runId: "spawner-run", depth: 0, factory });

    const spawned = await spawner.spawnSubOrchestrator(spawnOptions());

    expect(spawned.supervisor.hierarchy.depth).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. The parentRunId disambiguation
// ---------------------------------------------------------------------------

describe("spawnSubOrchestrator — parentRunId disambiguation", () => {
  it("uses the spawner's OWN runId, not its DelegationContext.parentRunId", async () => {
    const spawner = makeSpawner({
      runId: "spawner-own-run",
      depth: 0,
      factory: goodFactory(),
      // The per-delegation parent — concept (b). Must NOT become the child's
      // orchestrator-hierarchy parent.
      parentContextRunId: "delegation-parent-run",
    });

    const spawned = await spawner.spawnSubOrchestrator(
      spawnOptions({ parentRunId: "spawner-own-run" })
    );

    expect(spawned.supervisor.hierarchy.parentRunId).toBe("spawner-own-run");
    expect(spawned.supervisor.hierarchy.parentRunId).not.toBe(
      "delegation-parent-run"
    );
  });

  it("refuses to spawn when the supervisor has no runId of its own", async () => {
    // Has a DelegationContext.parentRunId available, but that is concept (b)
    // and must not be silently substituted for concept (a).
    const spawner = makeSpawner({
      depth: 0,
      factory: goodFactory(),
      parentContextRunId: "delegation-parent-run",
    });

    await expect(
      spawner.spawnSubOrchestrator(
        spawnOptions({ parentRunId: "delegation-parent-run" })
      )
    ).rejects.toThrow(/has no `runId`/);
  });

  it("keeps the spawner's own hierarchy parent distinct from the child's", async () => {
    // Spawner is itself a sub-orchestrator: its hierarchy.parentRunId is its
    // grandparent, while the child's parentRunId is the spawner's own run.
    const spawner = new DelegatingSupervisor({
      specialists: new Map([["db-agent", makeSpecialist("db-agent")]]),
      tracker: makeTracker(),
      parentRunId: "grandparent-run",
      runId: "spawner-run",
      depth: 1,
      subOrchestratorFactory: goodFactory(),
    });

    const spawned = await spawner.spawnSubOrchestrator(
      spawnOptions({ depth: 2 })
    );

    expect(spawner.hierarchy.parentRunId).toBe("grandparent-run");
    expect(spawned.supervisor.hierarchy.parentRunId).toBe("spawner-run");
  });
});

// ---------------------------------------------------------------------------
// 3. Depth limit — enforced AT THE SPAWN SITE
// ---------------------------------------------------------------------------

describe("spawnSubOrchestrator — depth limit at the dispatch site", () => {
  it("allows a spawn from depth 0 (child lands at depth 1)", async () => {
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(),
    });

    const spawned = await spawner.spawnSubOrchestrator(spawnOptions());

    expect(spawned.supervisor.hierarchy.depth).toBe(1);
  });

  it("allows a spawn from depth 1 — the deepest legal spawn site", async () => {
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: MAX_ORCHESTRATION_DEPTH - 2,
      factory: goodFactory(),
    });

    const spawned = await spawner.spawnSubOrchestrator(
      spawnOptions({ depth: MAX_ORCHESTRATION_DEPTH - 1 })
    );

    expect(spawned.supervisor.hierarchy.depth).toBe(
      MAX_ORCHESTRATION_DEPTH - 1
    );
  });

  it("throws when spawning from depth 2 — the child would be at the ceiling", async () => {
    // Depth 2 is a legally *constructable* supervisor (the constructor guard
    // rejects only depth >= MAX), but it is NOT a legal spawn site: the child
    // would land at depth 3 == MAX_ORCHESTRATION_DEPTH.
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: MAX_ORCHESTRATION_DEPTH - 1,
      factory: goodFactory(),
    });

    expect(spawner.hierarchy.depth).toBe(MAX_ORCHESTRATION_DEPTH - 1);
    await expect(
      spawner.spawnSubOrchestrator(
        spawnOptions({ depth: MAX_ORCHESTRATION_DEPTH })
      )
    ).rejects.toThrow(
      `Orchestration depth limit reached: depth=${MAX_ORCHESTRATION_DEPTH} >= max=${MAX_ORCHESTRATION_DEPTH}.`
    );
  });

  it("rejects at the dispatch site BEFORE the factory is invoked", async () => {
    const factory = vi.fn(goodFactory());
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: MAX_ORCHESTRATION_DEPTH - 1,
      factory,
    });

    await expect(
      spawner.spawnSubOrchestrator(
        spawnOptions({ depth: MAX_ORCHESTRATION_DEPTH })
      )
    ).rejects.toThrow(/Orchestration depth limit reached/);

    // The point of a dispatch-site guard: no child is ever built.
    expect(factory).not.toHaveBeenCalled();
  });

  it("depth guard fires before the missing-factory and missing-runId checks", async () => {
    // No factory and no runId, but too deep: the depth error is what surfaces,
    // proving the guard is genuinely first.
    const spawner = makeSpawner({ depth: MAX_ORCHESTRATION_DEPTH - 1 });

    await expect(
      spawner.spawnSubOrchestrator(
        spawnOptions({ depth: MAX_ORCHESTRATION_DEPTH })
      )
    ).rejects.toThrow(/Orchestration depth limit reached/);
  });

  it("a depth-2 supervisor still delegates to specialists normally", async () => {
    // Being an illegal spawn site does not make it an illegal supervisor: it is
    // a valid leaf orchestrator.
    const tracker = makeTracker();
    const spawner = new DelegatingSupervisor({
      specialists: new Map([["db-agent", makeSpecialist("db-agent")]]),
      tracker,
      runId: "spawner-run",
      depth: MAX_ORCHESTRATION_DEPTH - 1,
    });

    const result = await spawner.delegateTask("Task A", "db-agent", {});

    expect(result.success).toBe(true);
  });

  it("the chain root → child → grandchild exhausts the depth budget", async () => {
    const root = makeSpawner({
      runId: "root-run",
      depth: 0,
      factory: chainableFactory("child-run"),
    });

    const childSpawn = await root.spawnSubOrchestrator(
      spawnOptions({ parentRunId: "root-run" })
    );
    expect(childSpawn.supervisor.hierarchy.depth).toBe(1);

    // The child can spawn once more...
    const grandchild = await childSpawn.supervisor.spawnSubOrchestrator(
      {
        parentRunId: "child-run",
        branchId: "branch-left",
        depth: 2,
        inputPrompt: CHILD_PROMPT,
      },
      chainableFactory("grandchild-run")
    );
    expect(grandchild.supervisor.hierarchy.depth).toBe(2);
    expect(grandchild.supervisor.hierarchy.parentRunId).toBe("child-run");

    // ...but the grandchild, at depth 2, is the deepest level: spawning again
    // would put a child at MAX_ORCHESTRATION_DEPTH.
    await expect(
      grandchild.supervisor.spawnSubOrchestrator(
        {
          parentRunId: "grandchild-run",
          branchId: "branch-left",
          depth: 3,
          inputPrompt: CHILD_PROMPT,
        },
        chainableFactory("great-grandchild-run")
      )
    ).rejects.toThrow(/Orchestration depth limit reached/);
  });
});

// A child built by `goodFactory` receives the derived hierarchy but no `runId`
// of its own, so it cannot name itself anyone's parent. That is a deliberate
// failure rather than a fallback to a different identity.
describe("spawnSubOrchestrator — chained spawning needs a child runId", () => {
  it("a child without its own runId cannot spawn a grandchild", async () => {
    const root = makeSpawner({
      runId: "root-run",
      depth: 0,
      factory: goodFactory(),
    });

    const child = await root.spawnSubOrchestrator(
      spawnOptions({ parentRunId: "root-run" })
    );

    await expect(
      child.supervisor.spawnSubOrchestrator(
        {
          parentRunId: "child-run",
          branchId: "b",
          depth: 2,
          inputPrompt: CHILD_PROMPT,
        },
        goodFactory()
      )
    ).rejects.toThrow(/has no `runId`/);
  });
});

// ---------------------------------------------------------------------------
// 4. Failure propagation from child to parent
// ---------------------------------------------------------------------------

describe("spawnSubOrchestrator — failure propagation", () => {
  it("propagates a thrown child delegation error to the spawning caller", async () => {
    const boom = new Error("child specialist exploded");
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(makeThrowingTracker(boom)),
    });

    // `planAndDelegate` aggregates via allSettled, so a thrown delegation
    // surfaces as a failed entry rather than a rejection...
    const spawned = await spawner.spawnSubOrchestrator(spawnOptions());
    expect(spawned.result.failed.length).toBeGreaterThan(0);
    expect(spawned.result.succeeded).toEqual([]);
    const sole = [...spawned.result.results.values()][0]!;
    expect(sole.success).toBe(false);
    expect(sole.error).toContain("child specialist exploded");
  });

  it("propagates an unsuccessful child DelegationResult as a failure", async () => {
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(
        makeTracker({ success: false, output: null, error: "child said no" })
      ),
    });

    const spawned = await spawner.spawnSubOrchestrator(spawnOptions());

    expect(spawned.result.failed.length).toBeGreaterThan(0);
    const sole = [...spawned.result.results.values()][0]!;
    expect(sole.error).toBe("child said no");
  });

  it("rejects when the child cannot plan the prompt at all", async () => {
    // No specialist matches, so the child's planAndDelegate throws — and that
    // rejection reaches the spawning caller unchanged.
    const factory: SubOrchestratorFactory = ({ hierarchy }) =>
      new DelegatingSupervisor({
        specialists: new Map([["db-agent", makeSpecialist("db-agent")]]),
        tracker: makeTracker(),
        ...hierarchy,
      });
    const spawner = makeSpawner({ runId: "spawner-run", depth: 0, factory });

    await expect(
      spawner.spawnSubOrchestrator(
        spawnOptions({ inputPrompt: "zzzz nothing matches this at all zzzz" })
      )
    ).rejects.toThrow(OrchestrationError);
  });

  it("propagates a factory throw to the spawning caller", async () => {
    const factory: SubOrchestratorFactory = () => {
      throw new Error("factory could not resolve child specialists");
    };
    const spawner = makeSpawner({ runId: "spawner-run", depth: 0, factory });

    await expect(spawner.spawnSubOrchestrator(spawnOptions())).rejects.toThrow(
      "factory could not resolve child specialists"
    );
  });

  it("propagates an async factory rejection", async () => {
    const factory: SubOrchestratorFactory = async () => {
      throw new Error("async factory failed");
    };
    const spawner = makeSpawner({ runId: "spawner-run", depth: 0, factory });

    await expect(spawner.spawnSubOrchestrator(spawnOptions())).rejects.toThrow(
      "async factory failed"
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Guard rails around the spawn contract
// ---------------------------------------------------------------------------

describe("spawnSubOrchestrator — contract validation", () => {
  it("throws when no factory is configured or supplied", async () => {
    const spawner = makeSpawner({ runId: "spawner-run", depth: 0 });

    await expect(spawner.spawnSubOrchestrator(spawnOptions())).rejects.toThrow(
      /no subOrchestratorFactory/
    );
  });

  it("rejects a caller-asserted parentRunId that disagrees with the spawner", async () => {
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(),
    });

    await expect(
      spawner.spawnSubOrchestrator(
        spawnOptions({ parentRunId: "some-other-run" })
      )
    ).rejects.toThrow(/does not match this supervisor's run/);
  });

  it("rejects a caller-asserted depth that disagrees with spawner depth + 1", async () => {
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(),
    });

    await expect(
      spawner.spawnSubOrchestrator(spawnOptions({ depth: 2 }))
    ).rejects.toThrow(/does not match the derived child depth 1/);
  });

  it("rejects a factory that drops the supplied hierarchy", async () => {
    const factory: SubOrchestratorFactory = () =>
      new DelegatingSupervisor({
        specialists: new Map([["db-agent", makeSpecialist("db-agent")]]),
        tracker: makeTracker(),
        // hierarchy deliberately NOT spread
      });
    const spawner = makeSpawner({ runId: "spawner-run", depth: 0, factory });

    await expect(spawner.spawnSubOrchestrator(spawnOptions())).rejects.toThrow(
      /hierarchy does not match the derived one/
    );
  });

  it("rejects a factory that rewrites the branchId", async () => {
    const factory: SubOrchestratorFactory = ({ hierarchy }) =>
      new DelegatingSupervisor({
        specialists: new Map([["db-agent", makeSpecialist("db-agent")]]),
        tracker: makeTracker(),
        ...hierarchy,
        branchId: "some-other-branch",
      });
    const spawner = makeSpawner({ runId: "spawner-run", depth: 0, factory });

    await expect(spawner.spawnSubOrchestrator(spawnOptions())).rejects.toThrow(
      /hierarchy does not match the derived one/
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Event surface — what is emitted, and what is deliberately NOT
// ---------------------------------------------------------------------------

describe("spawnSubOrchestrator — event surface", () => {
  function makeBus(): { bus: DzupEventBus; seen: DzupEvent[] } {
    const bus = createEventBus();
    const seen: DzupEvent[] = [];
    bus.onAny((e) => { seen.push(e) });
    return { bus, seen };
  }

  it("emits no delegation:* or supervisor:* event from the spawn site itself", async () => {
    const { bus, seen } = makeBus();
    // Child gets NO event bus, so anything observed on `bus` came from the
    // spawn site rather than from the child's own delegations.
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(makeTracker()),
      eventBus: bus,
    });

    await spawner.spawnSubOrchestrator(spawnOptions());

    // A sub-orchestrator dispatch is not a delegation to a specialist, and
    // there is no truthful existing shape for it — so nothing is emitted rather
    // than a fabricated event inflating forge_delegation_*_total.
    expect(seen).toEqual([]);
  });

  it("makes the parent→child edge reconstructable from the CHILD's events", async () => {
    const { bus, seen } = makeBus();
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      // Child shares the bus — this is how the tree becomes observable.
      factory: goodFactory(makeTracker(), bus),
    });

    await spawner.spawnSubOrchestrator(spawnOptions());

    const childDelegating = seen.filter(
      (e) => e.type === "supervisor:delegating"
    );
    expect(childDelegating.length).toBeGreaterThan(0);

    // The child stamps its hierarchy onto the requests it issues, which is what
    // an out-of-process observer correlates on.
    expect(spawner.hierarchy.depth).toBe(0);
  });

  it("stamps the spawner's run as hierarchy.parentRunId on the child's delegation requests", async () => {
    const childTracker = makeTracker();
    const spawner = makeSpawner({
      runId: "spawner-run",
      depth: 0,
      factory: goodFactory(childTracker),
    });

    await spawner.spawnSubOrchestrator(spawnOptions());

    const request = vi.mocked(childTracker.delegate).mock.calls[0]![0]!;
    expect(request.hierarchy).toEqual({
      parentRunId: "spawner-run",
      branchId: "branch-left",
      depth: 1,
    });
    // ...and the per-delegation context is untouched by any of this.
    expect(request.context).toBeUndefined();
  });
});
