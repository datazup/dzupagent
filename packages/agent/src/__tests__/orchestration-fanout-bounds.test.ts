/**
 * ORCH-DSL-L1-H-07 — orchestration fan-out must be bounded.
 *
 * Five sites dispatched one simultaneous model call per item with no cap while
 * the bounded pool in `concurrency-runner.ts` sat unused — `debate()` most
 * sharply, since `orchestrator.ts` already imports and uses that pool about a
 * hundred lines above.
 *
 * Each test asserts *peak* simultaneous in-flight calls, following the idiom
 * established in `concurrency-runner.test.ts` and `map-reduce.test.ts`. Peak is
 * what a cap constrains; a total count would pass just as well unbounded, so
 * asserting totals here would be vacuous.
 */
import { describe, it, expect, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { DzupAgent } from "../agent/dzip-agent.js";
import { AgentOrchestrator } from "../orchestration/orchestrator.js";
import { DelegatingSupervisor } from "../orchestration/delegating-supervisor.js";
import { TopologyExecutor } from "../orchestration/topology/topology-executor.js";
import { ContractNetPolicy } from "../orchestration/fleet/policies/contract-net-policy.js";
import { DEFAULT_ORCHESTRATION_FANOUT } from "../orchestration/concurrency-runner.js";

// Real timers are load-bearing here, not incidental. These tests assert *peak
// simultaneous* in-flight calls, which only exists if tasks genuinely overlap
// in wall-clock time. Fake timers would advance the clock deterministically and
// collapse the overlap the probe is built to observe, making every peak
// assertion vacuous. Same reason `concurrency-runner.test.ts` and
// `map-reduce.test.ts` use real delays for their peak assertions.
const delay = (ms: number): Promise<void> =>
  // eslint-disable-next-line no-restricted-syntax -- peak-concurrency assertions require real overlap
  new Promise((resolve) => setTimeout(resolve, ms));

/** Tracks simultaneous entries so a test can assert the peak. */
function createConcurrencyProbe() {
  let active = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      active++;
      peak = Math.max(peak, active);
      try {
        return await fn();
      } finally {
        active--;
      }
    },
  };
}

/** A model whose `invoke` is slow enough for overlap to be observable. */
function createProbedModel(
  probe: ReturnType<typeof createConcurrencyProbe>
): BaseChatModel {
  return {
    invoke: vi.fn(() =>
      probe.run(async () => {
        await delay(10);
        return new AIMessage("ok");
      })
    ),
    bindTools: vi.fn().mockReturnThis(),
    model: "test-model",
  } as unknown as BaseChatModel;
}

function createAgents(
  count: number,
  probe: ReturnType<typeof createConcurrencyProbe>
): DzupAgent[] {
  return Array.from(
    { length: count },
    (_unused, i) =>
      new DzupAgent({
        id: `agent-${i}`,
        instructions: "test",
        model: createProbedModel(probe),
      })
  );
}

describe("orchestration fan-out is bounded (ORCH-DSL-L1-H-07)", () => {
  it("debate() caps simultaneous proposer calls at the default", async () => {
    const probe = createConcurrencyProbe();
    const proposers = createAgents(12, probe);
    const judge = new DzupAgent({
      id: "judge",
      instructions: "test",
      model: createProbedModel(createConcurrencyProbe()),
    });

    await AgentOrchestrator.debate(proposers, judge, "task");

    expect(probe.peak).toBeLessThanOrEqual(DEFAULT_ORCHESTRATION_FANOUT);
    // Guards against a cap so tight it serialises the fan-out entirely.
    expect(probe.peak).toBeGreaterThan(1);
  });

  it("debate() honours an explicit maxConcurrency", async () => {
    const probe = createConcurrencyProbe();
    const proposers = createAgents(9, probe);
    const judge = new DzupAgent({
      id: "judge",
      instructions: "test",
      model: createProbedModel(createConcurrencyProbe()),
    });

    await AgentOrchestrator.debate(proposers, judge, "task", {
      maxConcurrency: 2,
    });

    expect(probe.peak).toBe(2);
  });

  it("debate() still returns one proposal per proposer, in order", async () => {
    // The cap must not drop or reorder work: `debate()` renders proposals as
    // indexed "Proposal N", so order carries meaning.
    const contents = ["alpha", "beta", "gamma", "delta"];
    const proposers = contents.map(
      (text, i) =>
        new DzupAgent({
          id: `p-${i}`,
          instructions: "test",
          model: {
            invoke: vi.fn(async () => {
              // Reverse the delays so completion order differs from input order.
              await delay((contents.length - i) * 5);
              return new AIMessage(text);
            }),
            bindTools: vi.fn().mockReturnThis(),
            model: "test-model",
          } as unknown as BaseChatModel,
        })
    );

    let judgePrompt = "";
    const judge = new DzupAgent({
      id: "judge",
      instructions: "test",
      model: {
        invoke: vi.fn((messages: Array<{ content: unknown }>) => {
          judgePrompt = String(messages[messages.length - 1]?.content ?? "");
          return Promise.resolve(new AIMessage("verdict"));
        }),
        bindTools: vi.fn().mockReturnThis(),
        model: "test-model",
      } as unknown as BaseChatModel,
    });

    await AgentOrchestrator.debate(proposers, judge, "task", {
      maxConcurrency: 2,
    });

    expect(judgePrompt.indexOf("alpha")).toBeGreaterThan(-1);
    expect(judgePrompt.indexOf("alpha")).toBeLessThan(
      judgePrompt.indexOf("beta")
    );
    expect(judgePrompt.indexOf("beta")).toBeLessThan(
      judgePrompt.indexOf("gamma")
    );
    expect(judgePrompt.indexOf("gamma")).toBeLessThan(
      judgePrompt.indexOf("delta")
    );
  });

  it("delegateAndCollect() caps simultaneous specialist calls", async () => {
    const probe = createConcurrencyProbe();
    const count = 10;
    // Probe the tracker's `delegate`, which is the seam `delegateTask` drives
    // for each assignment — the per-item work the cap has to bound.
    const supervisor = new DelegatingSupervisor({
      specialists: new Map(
        Array.from({ length: count }, (_unused, i) => [
          `agent-${i}`,
          {
            id: `agent-${i}`,
            name: `agent-${i}`,
            instructions: `You are the agent-${i} specialist`,
            modelTier: "codegen" as const,
          },
        ])
      ),
      tracker: {
        delegate: vi.fn(() =>
          probe.run(async () => {
            await delay(10);
            return { success: true, output: "ok" };
          })
        ),
        getActiveDelegations: vi.fn(() => []),
        cancel: vi.fn(() => false),
      } as never,
    });

    const result = await supervisor.delegateAndCollect(
      Array.from({ length: count }, (_unused, i) => ({
        task: `task-${i}`,
        specialistId: `agent-${i}`,
        input: {},
      })),
      { maxConcurrency: 3 }
    );

    expect(probe.peak).toBe(3);
    // The cap must not drop work.
    expect(result.results).toHaveLength(count);
  });

  it("executeMesh() caps simultaneous agent calls per round", async () => {
    const probe = createConcurrencyProbe();
    const agents = createAgents(8, probe);

    const result = await TopologyExecutor.executeMesh({
      agents,
      task: "task",
      maxRounds: 1,
      maxConcurrency: 2,
    });

    expect(probe.peak).toBe(2);
    expect(result.results).toHaveLength(8);
  });

  it("ContractNetPolicy caps simultaneous bidder calls", async () => {
    const probe = createConcurrencyProbe();
    const policy = new ContractNetPolicy({
      bidder: (worker) =>
        probe.run(async () => {
          await delay(10);
          return Number(worker.workerId.split("-")[1] ?? 0);
        }),
      maxConcurrency: 2,
    });

    const fleet = Array.from({ length: 7 }, (_unused, i) => ({
      workerId: `w-${i}`,
      repo: `repo-${i}`,
      busy: false,
    }));

    const assignment = await policy.assignTask(
      { id: "t1", description: "task" } as never,
      fleet as never,
      {} as never
    );

    expect(probe.peak).toBe(2);
    // Highest bid still wins — bounding must not perturb selection.
    expect(assignment.workerId).toBe("w-6");
  });
});
