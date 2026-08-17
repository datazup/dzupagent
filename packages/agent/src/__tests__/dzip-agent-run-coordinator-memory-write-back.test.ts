/**
 * Regression suite for the memory write-back stop-reason guard in
 * `agent/dzip-agent-run-coordinator.ts` (`runGenerate`).
 *
 * The guard used to read `(result.stopReason as string) !== "failed"`.
 * `"failed"` is not a `StopReason` member and has no producer anywhere in the
 * repo -- it belongs to the unrelated `RunStatus` / `StreamingStatus` /
 * pipeline-state vocabularies -- so the `as string` cast silenced the compiler
 * and the guard was ALWAYS TRUE. Every errored, aborted, stuck,
 * budget-exhausted, token-exhausted and compression-failed run persisted its
 * partial content into long-term memory.
 *
 * The rule asserted here is not invented for this suite: the streaming half of
 * the same feature already gates `maybeWriteBackMemory` on
 * `stopReason === 'complete'` in BOTH `streaming-run-fallback.ts` and
 * `streaming-run-iteration.ts`. `generate()` now matches it, and the last test
 * pins that parity directly.
 *
 * Two deliberate anti-vacuity properties:
 *
 *  1. `WRITE_BACK_EXPECTATION` is declared here as a total
 *     `Record<StopReason, boolean>` and is NOT imported from the
 *     implementation. It is an independent oracle, and adding a member to
 *     `StopReason` breaks THIS FILE's compile until the new member is
 *     classified -- so the table cannot rot.
 *  2. Every case drives a NON-EMPTY `content`. `maybeWriteBackMemory` also
 *     returns early when `content` is empty, so a suppressed write with empty
 *     content would prove nothing; with non-empty content the only thing that
 *     can suppress it is the stop-reason guard under test.
 */
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DzupAgent } from "../agent/dzip-agent.js";
import type { GenerateResult } from "../agent/agent-types.js";
import type { StopReason } from "../agent/tool-loop.js";
import { executeGenerateRun } from "../agent/run-engine.js";
import type * as RunEngineNs from "../agent/run-engine.js";
import { makeMockMemoryService, makeMockModel } from "./test-utils.js";

type RunEngineModule = typeof RunEngineNs;

/**
 * Only `executeGenerateRun` is replaced, and it defaults to the REAL
 * implementation (restored in `beforeEach`). The tests that name a stop reason
 * explicitly override it for that one case; every other test in this file runs
 * the genuine run engine and tool loop end to end.
 */
vi.mock("../agent/run-engine.js", async (importOriginal) => {
  const actual = await importOriginal<RunEngineModule>();
  return { ...actual, executeGenerateRun: vi.fn(actual.executeGenerateRun) };
});

const actualRunEngine = await vi.importActual<RunEngineModule>(
  "../agent/run-engine.js"
);

// `"failed"` was never a member of the union. This assertion is the compile-time
// tombstone for the original bug: if anyone re-adds `"failed"` to `StopReason`,
// the expectation below becomes unused and the build fails, forcing a re-read of
// this suite.
// @ts-expect-error "failed" is not a StopReason member.
const FAILED_IS_NOT_A_STOP_REASON: StopReason = "failed";
void FAILED_IS_NOT_A_STOP_REASON;

/**
 * The oracle. Total over `StopReason`, declared independently of the
 * implementation's own map so that a wrong implementation cannot agree with it
 * by construction.
 */
const WRITE_BACK_EXPECTATION: Record<StopReason, boolean> = {
  complete: true,
  iteration_limit: false,
  budget_exceeded: false,
  aborted: false,
  error: false,
  stuck: false,
  token_exhausted: false,
  compression_failed: false,
  approval_pending: false,
};

function memoryAgentConfig(
  id: string,
  model: BaseChatModel,
  memory: ReturnType<typeof makeMockMemoryService>
) {
  return {
    id,
    instructions: "Base instructions",
    model,
    memory,
    memoryNamespace: "facts",
    memoryScope: { project: "demo" },
  };
}

/** A model that never stops asking for a tool, but always carries content. */
function makeAlwaysToolCallingModel(content: string): BaseChatModel {
  return {
    invoke: vi.fn(
      async () =>
        new AIMessage({
          content,
          tool_calls: [{ id: "call-loop", name: "loop", args: {} }],
        })
    ),
    bindTools: vi.fn().mockReturnThis(),
  } as unknown as BaseChatModel;
}

const loopTool = tool(async () => "tool output", {
  name: "loop",
  description: "a tool the model keeps calling",
  schema: z.object({}),
});

describe("runGenerate memory write-back stop-reason guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the genuine run engine for the end-to-end cases.
    vi.mocked(executeGenerateRun).mockImplementation(
      actualRunEngine.executeGenerateRun
    );
  });

  // -------------------------------------------------------------------------
  // Real producers: no stop reason is hand-written, the tool loop emits it.
  // -------------------------------------------------------------------------

  it('writes back when the REAL tool loop reports "complete"', async () => {
    const memory = makeMockMemoryService();
    const agent = new DzupAgent(
      memoryAgentConfig("wb-complete", makeMockModel("final answer"), memory)
    );

    const result = await agent.generate([new HumanMessage("hello")]);

    // The stop reason came out of the real loop, not out of a fixture.
    expect(result.stopReason).toBe("complete");
    expect(result.content).toBe("final answer");

    // PROVE the finalizer actually fired with the run's content. Without this
    // the suppression assertions below could all pass on an unreachable path.
    expect(memory.put).toHaveBeenCalledTimes(1);
    expect(memory.put.mock.calls[0]![3]).toMatchObject({
      text: "final answer",
      agentId: "wb-complete",
    });
  });

  it('suppresses write-back when the REAL tool loop reports "iteration_limit"', async () => {
    const memory = makeMockMemoryService();
    const partial = "partial answer that must never reach long-term memory";
    const agent = new DzupAgent({
      ...memoryAgentConfig(
        "wb-iteration-limit",
        makeAlwaysToolCallingModel(partial),
        memory
      ),
      tools: [loopTool],
    });

    const result = await agent.generate([new HumanMessage("go")], {
      maxIterations: 2,
    });

    // Produced by the real loop.
    expect(result.stopReason).toBe("iteration_limit");
    // Non-vacuity: content is non-empty, so `maybeWriteBackMemory`'s
    // empty-content early return cannot be what suppressed the write.
    expect(result.content).not.toBe("");
    expect(memory.put).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Exhaustive table over every StopReason member.
  // -------------------------------------------------------------------------

  const rows = Object.entries(WRITE_BACK_EXPECTATION) as Array<
    [StopReason, boolean]
  >;

  it("covers every StopReason member", () => {
    // Guards against a silently shrinking table if the cast above ever drifts.
    expect(rows).toHaveLength(9);
  });

  for (const [stopReason, shouldWriteBack] of rows) {
    const verb = shouldWriteBack ? "writes back" : "suppresses write-back";

    it(`${verb} on stopReason="${stopReason}"`, async () => {
      const memory = makeMockMemoryService();
      const content = `content from a run that stopped with ${stopReason}`;

      vi.mocked(executeGenerateRun).mockResolvedValue({
        content,
        messages: [],
        usage: { totalInputTokens: 1, totalOutputTokens: 1, llmCalls: 1 },
        hitIterationLimit: stopReason === "iteration_limit",
        stopReason,
        toolStats: [],
      } satisfies GenerateResult);

      const agent = new DzupAgent(
        memoryAgentConfig(`wb-${stopReason}`, makeMockModel("unused"), memory)
      );

      const result = await agent.generate([new HumanMessage("hi")]);

      expect(result.stopReason).toBe(stopReason);
      // Every row carries non-empty content, so the only thing that can
      // suppress a write here is the stop-reason guard.
      expect(result.content).toBe(content);

      if (shouldWriteBack) {
        expect(memory.put).toHaveBeenCalledTimes(1);
        expect(memory.put.mock.calls[0]![3]).toMatchObject({ text: content });
      } else {
        expect(memory.put).not.toHaveBeenCalled();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Parity with the streaming path, which is the evidence for the rule above.
  // -------------------------------------------------------------------------

  it("matches stream() write-back behaviour for the same run outcomes", async () => {
    const completeMemory = makeMockMemoryService();
    const completeAgent = new DzupAgent(
      memoryAgentConfig(
        "parity-complete",
        makeMockModel("streamed answer"),
        completeMemory
      )
    );
    for await (const _event of completeAgent.stream([
      new HumanMessage("hi"),
    ])) {
      // drain
    }

    const limitMemory = makeMockMemoryService();
    const partial = "partial streamed answer";
    const limitAgent = new DzupAgent({
      ...memoryAgentConfig(
        "parity-iteration-limit",
        makeAlwaysToolCallingModel(partial),
        limitMemory
      ),
      tools: [loopTool],
    });
    for await (const _event of limitAgent.stream([new HumanMessage("go")], {
      maxIterations: 2,
    })) {
      // drain
    }

    // stream() has always written back only on `complete`; generate() now
    // agrees, which is exactly the rule this suite pins.
    expect(completeMemory.put).toHaveBeenCalled();
    expect(limitMemory.put).not.toHaveBeenCalled();
  });
});
