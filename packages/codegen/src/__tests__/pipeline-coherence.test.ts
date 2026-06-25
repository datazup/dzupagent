/**
 * Pipeline coherence deep tests.
 *
 * Sources under test:
 *   packages/codegen/src/pipeline/pipeline-executor.ts
 *   packages/codegen/src/pipeline/gen-pipeline-builder.ts
 *   packages/codegen/src/pipeline/guardrail-gate.ts
 *   packages/codegen/src/pipeline/budget-gate.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { PipelineExecutor } from "../pipeline/pipeline-executor.js";
import type {
  PhaseConfig,
  ExecutorConfig,
} from "../pipeline/pipeline-executor.js";
import { GenPipelineBuilder } from "../pipeline/gen-pipeline-builder.js";
import {
  runGuardrailGate,
  summarizeGateResult,
} from "../pipeline/guardrail-gate.js";
import type { GuardrailGateConfig } from "../pipeline/guardrail-gate.js";
import { runBudgetGate } from "../pipeline/budget-gate.js";
import type { BudgetGateConfig } from "../pipeline/budget-gate.js";
import type { GuardrailEngine } from "../guardrails/guardrail-engine.js";
import type {
  GuardrailContext,
  GuardrailReport,
} from "../guardrails/guardrail-types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePhase(
  id: string,
  execute: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
  overrides?: Partial<PhaseConfig>
): PhaseConfig {
  return { id, name: id, execute, ...overrides };
}

function makePassEngine(overrides?: Partial<GuardrailReport>): GuardrailEngine {
  const report: GuardrailReport = {
    violations: [],
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    ...overrides,
  };
  return { evaluate: () => report } as unknown as GuardrailEngine;
}

function makeFailEngine(errorCount = 1): GuardrailEngine {
  const report: GuardrailReport = {
    violations: [
      {
        severity: "error",
        file: "src/a.ts",
        message: "critical issue",
        rule: "no-bad",
      },
    ],
    errorCount,
    warningCount: 0,
    infoCount: 0,
  };
  return { evaluate: () => report } as unknown as GuardrailEngine;
}

function makeWarnEngine(): GuardrailEngine {
  const report: GuardrailReport = {
    violations: [
      {
        severity: "warning",
        file: "src/b.ts",
        message: "warning issue",
        rule: "no-warn",
      },
    ],
    errorCount: 0,
    warningCount: 1,
    infoCount: 0,
  };
  return { evaluate: () => report } as unknown as GuardrailEngine;
}

// ---------------------------------------------------------------------------
// PipelineExecutor — empty pipeline
// ---------------------------------------------------------------------------

describe("PipelineExecutor — empty pipeline", () => {
  it("returns completed status with no phases", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute([], {});
    expect(result.status).toBe("completed");
  });

  it("returns empty phases array", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute([], {});
    expect(result.phases).toHaveLength(0);
  });

  it("returns initial state unchanged", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute([], { seed: "value" });
    expect(result.state["seed"]).toBe("value");
  });

  it("records a non-negative totalDurationMs", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute([], {});
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — single phase pipeline
// ---------------------------------------------------------------------------

describe("PipelineExecutor — single phase pipeline", () => {
  it("returns output from the single step directly in state", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [makePhase("only", async () => ({ answer: 42 }))],
      {}
    );
    expect(result.state["answer"]).toBe(42);
  });

  it("phase result has status completed", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [makePhase("only", async () => ({ done: true }))],
      {}
    );
    expect(result.phases[0]!.status).toBe("completed");
  });

  it("phase result carries the output", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [makePhase("only", async () => ({ key: "val" }))],
      {}
    );
    expect(result.phases[0]!.output).toEqual({ key: "val" });
  });

  it("overall status is completed when the only phase succeeds", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute([makePhase("only", async () => ({}))], {});
    expect(result.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — step ordering and state flow
// ---------------------------------------------------------------------------

describe("PipelineExecutor — steps execute in declared order", () => {
  it("three sequential phases run in declaration order", async () => {
    const order: string[] = [];
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase("first", async () => {
          order.push("first");
          return { step: 1 };
        }),
        makePhase("second", async () => {
          order.push("second");
          return { step: 2 };
        }),
        makePhase("third", async () => {
          order.push("third");
          return { step: 3 };
        }),
      ],
      {}
    );
    expect(result.status).toBe("completed");
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("output of step N feeds step N+1", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase("a", async () => ({ x: 10 })),
        makePhase("b", async (s) => ({ y: (s["x"] as number) * 2 })),
        makePhase("c", async (s) => ({ z: (s["y"] as number) + 1 })),
      ],
      {}
    );
    expect(result.state["x"]).toBe(10);
    expect(result.state["y"]).toBe(20);
    expect(result.state["z"]).toBe(21);
  });

  it("pipeline state accumulates — later phases see earlier outputs", async () => {
    const captured: string[] = [];
    const ex = new PipelineExecutor();
    await ex.execute(
      [
        makePhase("p1", async () => ({ p1: true })),
        makePhase("p2", async (s) => {
          captured.push(Object.keys(s).join(","));
          return { p2: true };
        }),
        makePhase("p3", async (s) => {
          captured.push(Object.keys(s).join(","));
          return { p3: true };
        }),
      ],
      {}
    );
    // p2 sees p1's output
    expect(captured[0]).toContain("p1");
    // p3 sees both p1 and p2's output
    expect(captured[1]).toContain("p1");
    expect(captured[1]).toContain("p2");
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — failure halts the pipeline
// ---------------------------------------------------------------------------

describe("PipelineExecutor — step failure aborts pipeline", () => {
  it("stops executing phases after first failure (default — no continue-on-failure)", async () => {
    const laterCalled = vi.fn();
    const ex = new PipelineExecutor();
    await ex.execute(
      [
        makePhase("fail", async () => {
          throw new Error("bang");
        }),
        makePhase("should-not-run", async () => {
          laterCalled();
          return {};
        }),
      ],
      {}
    );
    expect(laterCalled).not.toHaveBeenCalled();
  });

  it("overall status is failed when any phase throws", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase("fail", async () => {
          throw new Error("oops");
        }),
      ],
      {}
    );
    expect(result.status).toBe("failed");
  });

  it("failed phase result contains the error message", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase("fail", async () => {
          throw new Error("the-error");
        }),
      ],
      {}
    );
    const ph = result.phases.find((p) => p.phaseId === "fail");
    expect(ph!.error).toContain("the-error");
  });

  it("phases after failure are not in the results", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase("ok", async () => ({ a: 1 })),
        makePhase("fail", async () => {
          throw new Error("stop");
        }),
        makePhase("after", async () => ({ b: 2 })),
      ],
      {}
    );
    const afterPhase = result.phases.find((p) => p.phaseId === "after");
    expect(afterPhase).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — state propagation contract
// ---------------------------------------------------------------------------

describe("PipelineExecutor — state propagation contract", () => {
  it("a key returned by a phase is visible to the next phase", async () => {
    const ex = new PipelineExecutor();
    const seen: unknown[] = [];
    await ex.execute(
      [
        makePhase("writer", async () => ({ secret: "found" })),
        makePhase("reader", async (s) => {
          seen.push(s["secret"]);
          return {};
        }),
      ],
      {}
    );
    expect(seen[0]).toBe("found");
  });

  it("a key NOT returned by a phase does not appear in subsequent phase state", async () => {
    // Only values explicitly returned by a phase are merged into state;
    // local variables or discarded mutations are invisible to later phases.
    const ex = new PipelineExecutor();
    const seen: unknown[] = [];
    await ex.execute(
      [
        makePhase("writer", async () => {
          // Does NOT return 'hidden' — so it should not appear downstream
          return {};
        }),
        makePhase("reader", async (s) => {
          seen.push(s["hidden"]);
          return {};
        }),
      ],
      {}
    );
    expect(seen[0]).toBeUndefined();
  });

  it("final pipeline state contains keys from all phases", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase("p1", async () => ({ from_p1: 1 })),
        makePhase("p2", async () => ({ from_p2: 2 })),
        makePhase("p3", async () => ({ from_p3: 3 })),
      ],
      {}
    );
    expect(result.state["from_p1"]).toBe(1);
    expect(result.state["from_p2"]).toBe(2);
    expect(result.state["from_p3"]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — dependency resolution (DAG)
// ---------------------------------------------------------------------------

describe("PipelineExecutor — DAG dependency resolution", () => {
  it("phase with dependsOn runs after all listed dependencies", async () => {
    const order: string[] = [];
    const ex = new PipelineExecutor();
    const phases: PhaseConfig[] = [
      makePhase(
        "c",
        async () => {
          order.push("c");
          return {};
        },
        { dependsOn: ["a", "b"] }
      ),
      makePhase("a", async () => {
        order.push("a");
        return {};
      }),
      makePhase(
        "b",
        async () => {
          order.push("b");
          return {};
        },
        { dependsOn: ["a"] }
      ),
    ];
    await ex.execute(phases, {});
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  it("throws on a circular dependency", async () => {
    const ex = new PipelineExecutor();
    const phases: PhaseConfig[] = [
      makePhase("a", async () => ({}), { dependsOn: ["b"] }),
      makePhase("b", async () => ({}), { dependsOn: ["a"] }),
    ];
    await expect(ex.execute(phases, {})).rejects.toThrow(/Cycle/);
  });

  it("throws on unknown dependency reference", async () => {
    const ex = new PipelineExecutor();
    await expect(
      ex.execute(
        [makePhase("a", async () => ({}), { dependsOn: ["ghost"] })],
        {}
      )
    ).rejects.toThrow(/Unknown dependency/);
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — conditional phases
// ---------------------------------------------------------------------------

describe("PipelineExecutor — conditional phases", () => {
  it("skips a phase whose condition returns false", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase("skip-me", async () => ({ ran: true }), {
          condition: () => false,
        }),
      ],
      {}
    );
    expect(result.phases[0]!.status).toBe("skipped");
    expect(result.state["ran"]).toBeUndefined();
  });

  it("runs a phase whose condition returns true", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase("run-me", async () => ({ ran: true }), {
          condition: () => true,
        }),
      ],
      {}
    );
    expect(result.phases[0]!.status).toBe("completed");
    expect(result.state["ran"]).toBe(true);
  });

  it("condition receives current pipeline state", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase("set-flag", async () => ({ flag: true })),
        makePhase("conditional", async () => ({ conditional: "ran" }), {
          condition: (s) => s["flag"] === true,
        }),
      ],
      {}
    );
    expect(result.state["conditional"]).toBe("ran");
  });

  it("skipped phase marks __phase_<id>_skipped in state", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [makePhase("optPhase", async () => ({}), { condition: () => false })],
      {}
    );
    expect(result.state["__phase_optPhase_skipped"]).toBe(true);
  });

  it("overall status is completed even when optional phase is skipped", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase("required", async () => ({ done: true })),
        makePhase("optional", async () => ({}), { condition: () => false }),
      ],
      {}
    );
    expect(result.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — retry strategies
// ---------------------------------------------------------------------------

describe("PipelineExecutor — retry strategies", () => {
  it("immediate retry: succeeds on third attempt", async () => {
    let attempts = 0;
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase(
          "flaky",
          async () => {
            attempts++;
            if (attempts < 3) throw new Error("fail");
            return { ok: true };
          },
          { maxRetries: 3, retryStrategy: "immediate" }
        ),
      ],
      {}
    );
    expect(result.status).toBe("completed");
    expect(result.state["ok"]).toBe(true);
    expect(attempts).toBe(3);
  });

  it("exhausted retries → failed status", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [
        makePhase(
          "perm-fail",
          async () => {
            throw new Error("nope");
          },
          { maxRetries: 1 }
        ),
      ],
      {}
    );
    expect(result.status).toBe("failed");
    expect(result.phases[0]!.status).toBe("failed");
    expect(result.phases[0]!.retries).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — timeout
// ---------------------------------------------------------------------------

describe("PipelineExecutor — timeout", () => {
  it("marks phase as timeout when it exceeds per-phase timeoutMs", async () => {
    const ex = new PipelineExecutor({ defaultTimeoutMs: 5000 });
    const result = await ex.execute(
      [
        makePhase(
          "slow",
          async () => {
            await new Promise((r) => setTimeout(r, 300));
            return {};
          },
          { timeoutMs: 50 }
        ),
      ],
      {}
    );
    expect(result.phases[0]!.status).toBe("timeout");
    expect(result.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — callbacks
// ---------------------------------------------------------------------------

describe("PipelineExecutor — callbacks", () => {
  it("onCheckpoint called after each successful phase with accumulated state", async () => {
    const checkpoints: Array<{ phaseId: string; keys: string[] }> = [];
    const ex = new PipelineExecutor({
      onCheckpoint: async (phaseId, state) => {
        checkpoints.push({ phaseId, keys: Object.keys(state) });
      },
    });
    await ex.execute(
      [
        makePhase("step1", async () => ({ s1: 1 })),
        makePhase("step2", async () => ({ s2: 2 })),
      ],
      {}
    );
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]!.phaseId).toBe("step1");
    expect(checkpoints[1]!.phaseId).toBe("step2");
    expect(checkpoints[1]!.keys).toContain("s1"); // accumulated
  });

  it("onCheckpoint is NOT called for failed phases", async () => {
    const onCheckpoint = vi.fn(async () => {});
    const ex = new PipelineExecutor({ onCheckpoint });
    await ex.execute(
      [
        makePhase("fail", async () => {
          throw new Error("x");
        }),
      ],
      {}
    );
    expect(onCheckpoint).not.toHaveBeenCalled();
  });

  it("onProgress fires for each phase with final progress=1 on success", async () => {
    const calls: Array<{ phaseId: string; progress: number }> = [];
    const ex = new PipelineExecutor({
      onProgress: (phaseId, progress) => calls.push({ phaseId, progress }),
    });
    await ex.execute([makePhase("p", async () => ({ done: true }))], {});
    const pCalls = calls.filter((c) => c.phaseId === "p");
    expect(pCalls[pCalls.length - 1]!.progress).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — budget gate
// ---------------------------------------------------------------------------

describe("PipelineExecutor — budget gate", () => {
  it("proceeds when budget is within limit", async () => {
    const checkBudget = vi.fn(async () => ({
      withinBudget: true,
      usedCents: 10,
      remainingCents: 90,
    }));
    const ex = new PipelineExecutor({
      budgetGate: {
        checkBudget,
        workflowRunId: "run-1",
        budgetLimitCents: 100,
      },
    });
    const result = await ex.execute(
      [makePhase("work", async () => ({ done: true }))],
      {}
    );
    expect(result.status).toBe("completed");
    expect(checkBudget).toHaveBeenCalledTimes(1);
  });

  it("fails phase and stops pipeline when budget is exceeded", async () => {
    const checkBudget = vi.fn(async () => ({
      withinBudget: false,
      usedCents: 110,
      remainingCents: 0,
    }));
    const laterCalled = vi.fn();
    const ex = new PipelineExecutor({
      budgetGate: {
        checkBudget,
        workflowRunId: "run-1",
        budgetLimitCents: 100,
      },
    });
    const result = await ex.execute(
      [
        makePhase("over-budget", async () => ({ done: true })),
        makePhase("later", async () => {
          laterCalled();
          return {};
        }),
      ],
      {}
    );
    expect(result.status).toBe("failed");
    expect(laterCalled).not.toHaveBeenCalled();
    const phase = result.phases.find((p) => p.phaseId === "over-budget");
    expect(phase!.status).toBe("failed");
    expect(phase!.error).toContain("Budget exceeded");
  });

  it("stores budget info in state under __phase_<id>_budget", async () => {
    const checkBudget = vi.fn(async () => ({
      withinBudget: true,
      usedCents: 25,
      remainingCents: 75,
    }));
    const ex = new PipelineExecutor({
      budgetGate: {
        checkBudget,
        workflowRunId: "run-1",
        budgetLimitCents: 100,
      },
    });
    const result = await ex.execute([makePhase("p", async () => ({}))], {});
    const budgetState = result.state["__phase_p_budget"] as Record<
      string,
      unknown
    >;
    expect(budgetState).toBeDefined();
    expect(budgetState["passed"]).toBe(true);
    expect(budgetState["usedCents"]).toBe(25);
    expect(budgetState["remainingCents"]).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// PipelineExecutor — guardrail gate integration
// ---------------------------------------------------------------------------

describe("PipelineExecutor — guardrail gate integration", () => {
  it("passes phase when guardrail engine reports 0 errors", async () => {
    const engine = makePassEngine();
    const ex = new PipelineExecutor({
      guardrailGate: { engine },
      buildGuardrailContext: (_phaseId, state): GuardrailContext => ({
        files: [{ path: "src/a.ts", content: String(state["content"] ?? "") }],
      }),
    });
    const result = await ex.execute(
      [makePhase("gen", async () => ({ content: "export const x = 1" }))],
      {}
    );
    expect(result.status).toBe("completed");
    expect(result.phases[0]!.status).toBe("completed");
  });

  it("fails phase when guardrail engine reports errors", async () => {
    const engine = makeFailEngine();
    const ex = new PipelineExecutor({
      guardrailGate: { engine },
      buildGuardrailContext: (_phaseId, _state): GuardrailContext => ({
        files: [{ path: "src/a.ts", content: "bad code" }],
      }),
    });
    const result = await ex.execute(
      [makePhase("gen", async () => ({ content: "bad code" }))],
      {}
    );
    expect(result.status).toBe("failed");
    expect(result.phases[0]!.status).toBe("failed");
  });

  it("stores guardrail result in state", async () => {
    const engine = makePassEngine();
    const ex = new PipelineExecutor({
      guardrailGate: { engine },
      buildGuardrailContext: (): GuardrailContext => ({
        files: [],
      }),
    });
    const result = await ex.execute([makePhase("gen", async () => ({}))], {});
    const guardrailState = result.state["__phase_gen_guardrail"] as Record<
      string,
      unknown
    >;
    expect(guardrailState).toBeDefined();
    expect(guardrailState["passed"]).toBe(true);
    expect(guardrailState["errorCount"]).toBe(0);
  });

  it("strict mode fails when only warnings present", async () => {
    const engine = makeWarnEngine();
    const ex = new PipelineExecutor({
      guardrailGate: { engine, strictMode: true },
      buildGuardrailContext: (): GuardrailContext => ({ files: [] }),
    });
    const result = await ex.execute([makePhase("gen", async () => ({}))], {});
    expect(result.status).toBe("failed");
  });

  it("normal mode passes when only warnings present", async () => {
    const engine = makeWarnEngine();
    const ex = new PipelineExecutor({
      guardrailGate: { engine, strictMode: false },
      buildGuardrailContext: (): GuardrailContext => ({ files: [] }),
    });
    const result = await ex.execute([makePhase("gen", async () => ({}))], {});
    expect(result.status).toBe("completed");
  });

  it("skips guardrail when buildGuardrailContext returns undefined", async () => {
    const engine = makeFailEngine(); // would fail if called
    const engineEvaluate = vi.spyOn(engine, "evaluate");
    const ex = new PipelineExecutor({
      guardrailGate: { engine },
      buildGuardrailContext: (): undefined => undefined,
    });
    const result = await ex.execute([makePhase("gen", async () => ({}))], {});
    expect(result.status).toBe("completed");
    expect(engineEvaluate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runGuardrailGate — standalone tests
// ---------------------------------------------------------------------------

describe("runGuardrailGate", () => {
  const dummyContext: GuardrailContext = { files: [] };

  it("passes when errorCount is 0 (normal mode)", () => {
    const config: GuardrailGateConfig = { engine: makePassEngine() };
    const result = runGuardrailGate(config, dummyContext);
    expect(result.passed).toBe(true);
  });

  it("fails when errorCount > 0 (normal mode)", () => {
    const config: GuardrailGateConfig = { engine: makeFailEngine() };
    const result = runGuardrailGate(config, dummyContext);
    expect(result.passed).toBe(false);
  });

  it("fails in strict mode when only warnings present", () => {
    const config: GuardrailGateConfig = {
      engine: makeWarnEngine(),
      strictMode: true,
    };
    const result = runGuardrailGate(config, dummyContext);
    expect(result.passed).toBe(false);
  });

  it("passes in strict mode when 0 errors and 0 warnings", () => {
    const config: GuardrailGateConfig = {
      engine: makePassEngine(),
      strictMode: true,
    };
    const result = runGuardrailGate(config, dummyContext);
    expect(result.passed).toBe(true);
  });

  it("result carries the guardrail report", () => {
    const config: GuardrailGateConfig = {
      engine: makePassEngine({ infoCount: 3 }),
    };
    const result = runGuardrailGate(config, dummyContext);
    expect(result.report.infoCount).toBe(3);
  });

  it("includes formattedReport when reporter is configured", () => {
    const reporter = { format: vi.fn(() => "FORMATTED REPORT") };
    const config: GuardrailGateConfig = {
      engine: makePassEngine(),
      reporter:
        reporter as unknown as import("../guardrails/guardrail-reporter.js").GuardrailReporter,
    };
    const result = runGuardrailGate(config, dummyContext);
    expect(result.formattedReport).toBe("FORMATTED REPORT");
    expect(reporter.format).toHaveBeenCalledOnce();
  });

  it("omits formattedReport when no reporter configured", () => {
    const config: GuardrailGateConfig = { engine: makePassEngine() };
    const result = runGuardrailGate(config, dummyContext);
    expect(result.formattedReport).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// summarizeGateResult
// ---------------------------------------------------------------------------

describe("summarizeGateResult", () => {
  it("produces a PASSED summary when the gate passed", () => {
    const engine = makePassEngine();
    const result = runGuardrailGate({ engine }, { files: [] });
    const summary = summarizeGateResult(result);
    expect(summary).toContain("PASSED");
  });

  it("produces a FAILED summary when the gate failed", () => {
    const engine = makeFailEngine();
    const result = runGuardrailGate({ engine }, { files: [] });
    const summary = summarizeGateResult(result);
    expect(summary).toContain("FAILED");
  });

  it("includes error and warning counts in the summary", () => {
    const engine = makeFailEngine(2);
    const result = runGuardrailGate({ engine }, { files: [] });
    const summary = summarizeGateResult(result);
    expect(summary).toContain("2 error");
  });

  it("lists violation details for failed gate", () => {
    const engine = makeFailEngine();
    const result = runGuardrailGate({ engine }, { files: [] });
    const summary = summarizeGateResult(result);
    expect(summary).toContain("src/a.ts");
  });
});

// ---------------------------------------------------------------------------
// runBudgetGate — standalone tests
// ---------------------------------------------------------------------------

describe("runBudgetGate", () => {
  it("returns passed=true when within budget", async () => {
    const config: BudgetGateConfig = {
      checkBudget: async () => ({
        withinBudget: true,
        usedCents: 10,
        remainingCents: 90,
      }),
      workflowRunId: "run-1",
      budgetLimitCents: 100,
    };
    const result = await runBudgetGate(config);
    expect(result.passed).toBe(true);
    expect(result.usedCents).toBe(10);
    expect(result.remainingCents).toBe(90);
  });

  it("returns passed=false when budget is exceeded", async () => {
    const config: BudgetGateConfig = {
      checkBudget: async () => ({
        withinBudget: false,
        usedCents: 110,
        remainingCents: 0,
      }),
      workflowRunId: "run-1",
      budgetLimitCents: 100,
    };
    const result = await runBudgetGate(config);
    expect(result.passed).toBe(false);
  });

  it("forwards workflowRunId and budgetLimitCents to checkBudget", async () => {
    const checkBudget = vi.fn(async () => ({
      withinBudget: true,
      usedCents: 0,
      remainingCents: 200,
    }));
    const config: BudgetGateConfig = {
      checkBudget,
      workflowRunId: "my-run",
      budgetLimitCents: 200,
    };
    await runBudgetGate(config);
    expect(checkBudget).toHaveBeenCalledWith("my-run", 200);
  });
});

// ---------------------------------------------------------------------------
// GenPipelineBuilder — configuration builder
// ---------------------------------------------------------------------------

describe("GenPipelineBuilder", () => {
  let builder: GenPipelineBuilder;

  beforeEach(() => {
    builder = new GenPipelineBuilder();
  });

  it("starts with no phases", () => {
    expect(builder.getPhases()).toHaveLength(0);
  });

  it("addPhase appends a generation phase", () => {
    builder.addPhase({ name: "gen", promptType: "code" });
    expect(builder.getPhases()).toHaveLength(1);
    expect(builder.getPhases()[0]!.type).toBe("generation");
    expect(builder.getPhases()[0]!.name).toBe("gen");
  });

  it("addPhase is chainable", () => {
    const ret = builder.addPhase({ name: "gen", promptType: "code" });
    expect(ret).toBe(builder);
  });

  it("addSubAgentPhase appends a subagent phase", () => {
    builder.addSubAgentPhase({ name: "sub", promptType: "sub-prompt" });
    expect(builder.getPhases()[0]!.type).toBe("subagent");
  });

  it("addValidationPhase appends a validation phase with threshold", () => {
    builder.addValidationPhase({ dimensions: ["correctness"], threshold: 0.8 });
    const phase = builder.getPhases()[0]!;
    expect(phase.type).toBe("validation");
    expect(phase.threshold).toBe(0.8);
  });

  it('addValidationPhase uses "validate" as default name', () => {
    builder.addValidationPhase({ dimensions: ["correctness"], threshold: 0.7 });
    expect(builder.getPhases()[0]!.name).toBe("validate");
  });

  it("addValidationPhase respects custom name", () => {
    builder.addValidationPhase({
      name: "lint-check",
      dimensions: ["correctness"],
      threshold: 0.9,
    });
    expect(builder.getPhases()[0]!.name).toBe("lint-check");
  });

  it("addFixPhase appends a fix phase with maxAttempts=3 by default", () => {
    builder.addFixPhase();
    const phase = builder.getPhases()[0]!;
    expect(phase.type).toBe("fix");
    expect(phase.maxAttempts).toBe(3);
  });

  it('addFixPhase uses "fix" as default name', () => {
    builder.addFixPhase();
    expect(builder.getPhases()[0]!.name).toBe("fix");
  });

  it("addFixPhase respects custom maxAttempts", () => {
    builder.addFixPhase({ maxAttempts: 5 });
    expect(builder.getPhases()[0]!.maxAttempts).toBe(5);
  });

  it("addReviewPhase appends a review phase with autoApprove=false by default", () => {
    builder.addReviewPhase();
    const phase = builder.getPhases()[0]!;
    expect(phase.type).toBe("review");
    expect(phase.autoApprove).toBe(false);
  });

  it("addReviewPhase respects autoApprove=true", () => {
    builder.addReviewPhase({ autoApprove: true });
    expect(builder.getPhases()[0]!.autoApprove).toBe(true);
  });

  it("withGuardrails appends a guardrail phase", () => {
    const engine = makePassEngine();
    builder.withGuardrails({ engine });
    const phase = builder.getPhases()[0]!;
    expect(phase.type).toBe("guardrail");
    expect(phase.name).toBe("guardrail-gate");
  });

  it("withGuardrails is chainable", () => {
    const engine = makePassEngine();
    const ret = builder.withGuardrails({ engine });
    expect(ret).toBe(builder);
  });

  it("getGuardrailConfig returns undefined before withGuardrails is called", () => {
    expect(builder.getGuardrailConfig()).toBeUndefined();
  });

  it("getGuardrailConfig returns config after withGuardrails", () => {
    const engine = makePassEngine();
    const config: GuardrailGateConfig = { engine, strictMode: true };
    builder.withGuardrails(config);
    expect(builder.getGuardrailConfig()).toBe(config);
  });

  it("getPhaseNames returns names in insertion order", () => {
    builder
      .addPhase({ name: "gen", promptType: "code" })
      .addValidationPhase({ dimensions: ["correctness"], threshold: 0.8 })
      .addFixPhase()
      .addReviewPhase();
    expect(builder.getPhaseNames()).toEqual([
      "gen",
      "validate",
      "fix",
      "review",
    ]);
  });

  it("getGenerationPhases returns only generation and subagent types", () => {
    builder
      .addPhase({ name: "gen", promptType: "code" })
      .addValidationPhase({ dimensions: ["correctness"], threshold: 0.8 })
      .addSubAgentPhase({ name: "sub", promptType: "sub" })
      .addFixPhase();
    const genPhases = builder.getGenerationPhases();
    expect(genPhases).toHaveLength(2);
    expect(genPhases.map((p) => p.name)).toEqual(["gen", "sub"]);
  });

  it("getPhase returns a phase by name", () => {
    builder.addPhase({ name: "myPhase", promptType: "code" });
    expect(builder.getPhase("myPhase")).toBeDefined();
    expect(builder.getPhase("myPhase")!.name).toBe("myPhase");
  });

  it("getPhase returns undefined for unknown name", () => {
    builder.addPhase({ name: "gen", promptType: "code" });
    expect(builder.getPhase("ghost")).toBeUndefined();
  });

  it("building a full pipeline preserves declaration order", () => {
    builder
      .addPhase({ name: "p1", promptType: "code" })
      .addValidationPhase({ dimensions: ["correctness"], threshold: 0.7 })
      .addFixPhase({ name: "fix1" })
      .addReviewPhase({ name: "approve" })
      .withGuardrails({ engine: makePassEngine() });
    expect(builder.getPhaseNames()).toEqual([
      "p1",
      "validate",
      "fix1",
      "approve",
      "guardrail-gate",
    ]);
  });

  it("empty builder getGenerationPhases returns []", () => {
    expect(builder.getGenerationPhases()).toHaveLength(0);
  });

  it("skipCondition is stored on phase when provided", () => {
    const skipFn = () => true;
    builder.addPhase({
      name: "gen",
      promptType: "code",
      skipCondition: skipFn,
    });
    expect(builder.getPhase("gen")!.skipCondition).toBe(skipFn);
  });

  it("skills array is stored on generation phase", () => {
    builder.addPhase({
      name: "gen",
      promptType: "code",
      skills: ["skill-a", "skill-b"],
    });
    expect(builder.getPhase("gen")!.skills).toEqual(["skill-a", "skill-b"]);
  });
});
