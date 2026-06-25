/**
 * Tool-loop exhaustion tests.
 *
 * Covers:
 * - Max iterations reached: loop stops after N tool calls
 * - Graceful stop: partial results collected before stop, not lost
 * - Partial result return: what was completed before exhaustion is returned
 * - Iteration counter increments correctly each iteration
 * - Iteration counter resets between independent runs
 * - Loop terminates naturally when LLM stops calling tools
 * - Max iterations = 1: single tool call allowed, then stops
 * - Max iterations = 0: immediate stop (no iterations run)
 * - Configurable max: max iterations configurable per-run
 * - Default-like behavior: large maxIterations completes normally
 * - Exhaustion stop reason: 'iteration_limit' on exhaustion
 * - hitIterationLimit flag behavior
 * - Partial toolStats on exhaustion: stats gathered before limit
 * - No-tool run: loop with no tools completes in 1 iteration
 * - Tool error counts toward iteration: failed call still increments counter
 * - onIteration callback fires each iteration
 * - Messages accumulate across exhausted iterations
 * - Multiple tool calls per iteration each decrement remaining budget
 * - Tool call counting across iterations
 * - Final message absent when exhausted (no final AI text)
 * - Exhaustion preserves all in-flight messages
 * - Large maxIterations: loop exits cleanly on natural LLM stop
 * - stuckError is undefined on iteration_limit (not stuck)
 * - LLM calls match iteration count on exhaustion
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { runToolLoop, type ToolLoopConfig } from "../agent/tool-loop.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal mock tool that records invocations. */
function mockTool(name: string, result = "ok") {
  const invokeFn = vi.fn(async (_args: Record<string, unknown>) => result);
  return {
    tool: {
      name,
      description: `Mock ${name}`,
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: invokeFn,
    } as unknown as StructuredToolInterface,
    invokeFn,
  };
}

/** Mock tool that always throws. */
function failingTool(name: string, msg = "tool-error") {
  return {
    name,
    description: `Failing ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => {
      throw new Error(msg);
    }),
  } as unknown as StructuredToolInterface;
}

/** Build an AIMessage that carries tool_calls. */
function aiWithCalls(
  calls: Array<{ name: string; args?: Record<string, unknown> }>,
) {
  const msg = new AIMessage({ content: "" });
  (msg as AIMessage & { tool_calls: unknown[] }).tool_calls = calls.map(
    (c, i) => ({
      id: `call_${i}_${c.name}`,
      name: c.name,
      args: c.args ?? {},
    }),
  );
  return msg;
}

/**
 * Model that infinitely returns the same tool call.
 * Useful for testing exhaustion without worrying about response index.
 */
function infiniteToolModel(toolName: string): BaseChatModel {
  return {
    invoke: vi.fn(async () => aiWithCalls([{ name: toolName, args: {} }])),
  } as unknown as BaseChatModel;
}

/**
 * Model that returns responses[N] for the Nth call, then returns a final
 * no-tool AIMessage for any subsequent call.
 */
function sequentialModel(responses: AIMessage[]): BaseChatModel {
  let idx = 0;
  return {
    invoke: vi.fn(async () => {
      const r = responses[idx] ?? new AIMessage("done");
      idx++;
      return r;
    }),
  } as unknown as BaseChatModel;
}

// ---------------------------------------------------------------------------
// 1. Max iterations reached — loop stops after N tool calls
// ---------------------------------------------------------------------------

describe("Max iterations reached", () => {
  it("stops with iteration_limit when every LLM response has tool calls", async () => {
    const { tool } = mockTool("ping");
    const model = infiniteToolModel("ping");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 4,
    });

    expect(result.stopReason).toBe("iteration_limit");
  });

  it("hitIterationLimit is true when exhausted", async () => {
    const { tool } = mockTool("step");
    const m = infiniteToolModel("step");
    const r = await runToolLoop(m, [new HumanMessage("go")], [tool], {
      maxIterations: 3,
    });
    expect(r.hitIterationLimit).toBe(true);
  });

  it("llmCalls equals maxIterations when exhausted", async () => {
    const { tool } = mockTool("step");
    const model = infiniteToolModel("step");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 5,
    });

    expect(result.llmCalls).toBe(5);
  });

  it("stops at exactly maxIterations = 2", async () => {
    const { tool } = mockTool("work");
    const model = infiniteToolModel("work");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 2,
    });

    expect(result.stopReason).toBe("iteration_limit");
    expect(result.llmCalls).toBe(2);
  });

  it("stops at exactly maxIterations = 6", async () => {
    const { tool } = mockTool("op");
    const model = infiniteToolModel("op");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 6,
    });

    expect(result.stopReason).toBe("iteration_limit");
    expect(result.llmCalls).toBe(6);
  });

  it("tool is invoked exactly maxIterations times when model always returns one call", async () => {
    const { tool, invokeFn } = mockTool("fn");
    const model = infiniteToolModel("fn");

    await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 4,
    });

    expect(invokeFn).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// 2. Max iterations = 0 — immediate stop
// ---------------------------------------------------------------------------

describe("Max iterations = 0", () => {
  it("returns complete without any LLM call when maxIterations is 0", async () => {
    const { tool } = mockTool("noop");
    const model = sequentialModel([new AIMessage("will not be called")]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 0,
    });

    // Loop body never executes — for loop condition 0 < 0 is false immediately
    expect(result.llmCalls).toBe(0);
    expect(result.stopReason).toBe("complete"); // default, loop never ran
  });

  it("toolStats is empty when maxIterations is 0", async () => {
    const { tool } = mockTool("noop");
    const model = sequentialModel([]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 0,
    });

    expect(result.toolStats).toHaveLength(0);
  });

  it("messages equals initial messages when maxIterations is 0", async () => {
    const { tool } = mockTool("noop");
    const model = sequentialModel([]);
    const initial = [new SystemMessage("sys"), new HumanMessage("hi")];

    const result = await runToolLoop(model, initial, [tool], {
      maxIterations: 0,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!._getType()).toBe("system");
    expect(result.messages[1]!._getType()).toBe("human");
  });
});

// ---------------------------------------------------------------------------
// 3. Max iterations = 1
// ---------------------------------------------------------------------------

describe("Max iterations = 1", () => {
  it("returns iteration_limit when single iteration has a tool call", async () => {
    const { tool } = mockTool("solo");
    const model = sequentialModel([
      aiWithCalls([{ name: "solo" }]),
      new AIMessage("never"),
    ]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 1,
    });

    expect(result.stopReason).toBe("iteration_limit");
    expect(result.llmCalls).toBe(1);
  });

  it("returns complete when single iteration has no tool calls", async () => {
    const model = sequentialModel([new AIMessage("final answer")]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [], {
      maxIterations: 1,
    });

    expect(result.stopReason).toBe("complete");
    expect(result.llmCalls).toBe(1);
  });

  it("tool is invoked exactly once with maxIterations = 1", async () => {
    const { tool, invokeFn } = mockTool("once");
    const model = sequentialModel([aiWithCalls([{ name: "once" }])]);

    await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 1,
    });

    expect(invokeFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Graceful stop — partial results collected before stop are not lost
// ---------------------------------------------------------------------------

describe("Graceful stop: partial results not lost", () => {
  it("toolStats are populated with calls made before exhaustion", async () => {
    const { tool } = mockTool("compute");
    const model = infiniteToolModel("compute");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 3,
    });

    const stat = result.toolStats.find((s) => s.name === "compute");
    expect(stat).toBeDefined();
    expect(stat!.calls).toBe(3);
  });

  it("messages accumulate all tool results before exhaustion", async () => {
    const { tool } = mockTool("step", "step-result");
    const model = infiniteToolModel("step");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 3,
    });

    // Each iteration: AI message + ToolMessage = 2 messages per iteration
    // Plus initial HumanMessage = 1
    // Total = 1 + 3 * 2 = 7
    const toolMessages = result.messages.filter((m) => m._getType() === "tool");
    expect(toolMessages).toHaveLength(3);
  });

  it("tool result content is preserved in messages on exhaustion", async () => {
    const { tool } = mockTool("fetch", "fetched-data");
    const model = sequentialModel([
      aiWithCalls([{ name: "fetch" }]),
      aiWithCalls([{ name: "fetch" }]),
    ]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 2,
    });

    const toolMsgs = result.messages.filter(
      (m) =>
        m._getType() === "tool" &&
        typeof m.content === "string" &&
        m.content.includes("fetched-data"),
    );
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it("AI messages are preserved in messages on exhaustion", async () => {
    const { tool } = mockTool("action");
    const model = infiniteToolModel("action");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 3,
    });

    const aiMsgs = result.messages.filter((m) => m._getType() === "ai");
    expect(aiMsgs).toHaveLength(3);
  });

  it("initial messages are preserved when exhausted", async () => {
    const { tool } = mockTool("step");
    const model = infiniteToolModel("step");
    const initial = [
      new SystemMessage("Be helpful"),
      new HumanMessage("do work"),
    ];

    const result = await runToolLoop(model, initial, [tool], {
      maxIterations: 2,
    });

    expect(result.messages[0]!._getType()).toBe("system");
    expect(result.messages[1]!._getType()).toBe("human");
  });

  it("toolStats contain error count accumulated before exhaustion", async () => {
    const bad = failingTool("broken", "always fails");
    const model = infiniteToolModel("broken");

    const result = await runToolLoop(model, [new HumanMessage("go")], [bad], {
      maxIterations: 3,
    });

    const stat = result.toolStats.find((s) => s.name === "broken");
    expect(stat).toBeDefined();
    expect(stat!.errors).toBe(3);
    expect(stat!.calls).toBe(3);
  });

  it("toolStats avgMs is a non-negative number on exhaustion", async () => {
    const { tool } = mockTool("timer");
    const model = infiniteToolModel("timer");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 3,
    });

    const stat = result.toolStats.find((s) => s.name === "timer");
    expect(stat!.avgMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Iteration counter increments correctly
// ---------------------------------------------------------------------------

describe("Iteration counter increments", () => {
  it("onIteration fires for each tool-call iteration with 1-based index", async () => {
    const { tool } = mockTool("step");
    const model = sequentialModel([
      aiWithCalls([{ name: "step" }]),
      aiWithCalls([{ name: "step" }]),
      new AIMessage("done"),
    ]);

    const iterations: number[] = [];
    await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 10,
      onIteration: ({ iteration }) => iterations.push(iteration),
    });

    // onIteration passes `iteration + 1` (1-based). It fires only for iterations
    // that processed tool calls — the final text-only turn breaks BEFORE reaching
    // the onIteration call. Two tool iterations → [1, 2].
    expect(iterations).toEqual([1, 2]);
  });

  it("onIteration fires with increasing llmCalls count", async () => {
    const { tool } = mockTool("step");
    const model = sequentialModel([
      aiWithCalls([{ name: "step" }]),
      aiWithCalls([{ name: "step" }]),
      new AIMessage("done"),
    ]);

    const llmCallsSeen: number[] = [];
    await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 10,
      onIteration: ({ llmCalls }) => llmCallsSeen.push(llmCalls),
    });

    // Two tool iterations → onIteration fires twice with llmCalls 1 and 2
    expect(llmCallsSeen).toEqual([1, 2]);
  });

  it("onIteration fires on every exhausted iteration (1-based)", async () => {
    const { tool } = mockTool("step");
    const model = infiniteToolModel("step");
    const iterations: number[] = [];

    await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 4,
      onIteration: ({ iteration }) => iterations.push(iteration),
    });

    // 4 exhausted iterations, each fires onIteration with 1-based index
    expect(iterations).toEqual([1, 2, 3, 4]);
  });

  it("onIteration receives growing messages array across tool iterations", async () => {
    const { tool } = mockTool("a");
    const model = sequentialModel([
      aiWithCalls([{ name: "a" }]),
      aiWithCalls([{ name: "a" }]),
      new AIMessage("done"),
    ]);

    const msgCounts: number[] = [];
    await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 10,
      onIteration: ({ messages }) => msgCounts.push(messages.length),
    });

    // onIteration fires only for the two tool-call iterations (final text breaks first).
    // After iter 0: human(1) + ai(1) + tool(1) = 3
    // After iter 1: + ai(1) + tool(1) = 5
    expect(msgCounts).toHaveLength(2);
    expect(msgCounts[0]!).toBeLessThan(msgCounts[1]!);
  });

  it("onIteration does not fire when maxIterations = 0", async () => {
    const { tool } = mockTool("noop");
    const model = sequentialModel([]);
    const iterations: number[] = [];

    await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 0,
      onIteration: ({ iteration }) => iterations.push(iteration),
    });

    expect(iterations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Iteration counter resets between independent runs
// ---------------------------------------------------------------------------

describe("Iteration counter resets between independent runs", () => {
  it("second run starts iteration counter at 0", async () => {
    const { tool } = mockTool("step");

    const firstIterations: number[] = [];
    await runToolLoop(
      infiniteToolModel("step"),
      [new HumanMessage("r1")],
      [tool],
      {
        maxIterations: 3,
        onIteration: ({ iteration }) => firstIterations.push(iteration),
      },
    );

    const secondIterations: number[] = [];
    await runToolLoop(
      infiniteToolModel("step"),
      [new HumanMessage("r2")],
      [tool],
      {
        maxIterations: 3,
        onIteration: ({ iteration }) => secondIterations.push(iteration),
      },
    );

    // iteration is 1-based (iteration + 1 in the source)
    expect(firstIterations).toEqual([1, 2, 3]);
    expect(secondIterations).toEqual([1, 2, 3]);
  });

  it("second run has independent llmCalls count", async () => {
    const { tool } = mockTool("op");

    const r1 = await runToolLoop(
      infiniteToolModel("op"),
      [new HumanMessage("r1")],
      [tool],
      {
        maxIterations: 5,
      },
    );

    const r2 = await runToolLoop(
      infiniteToolModel("op"),
      [new HumanMessage("r2")],
      [tool],
      {
        maxIterations: 3,
      },
    );

    expect(r1.llmCalls).toBe(5);
    expect(r2.llmCalls).toBe(3);
  });

  it("second run with different maxIterations exhausts independently", async () => {
    const { tool } = mockTool("fn");

    const r1 = await runToolLoop(
      infiniteToolModel("fn"),
      [new HumanMessage("go")],
      [tool],
      {
        maxIterations: 2,
      },
    );
    const r2 = await runToolLoop(
      infiniteToolModel("fn"),
      [new HumanMessage("go")],
      [tool],
      {
        maxIterations: 7,
      },
    );

    expect(r1.stopReason).toBe("iteration_limit");
    expect(r2.stopReason).toBe("iteration_limit");
    expect(r1.llmCalls).toBe(2);
    expect(r2.llmCalls).toBe(7);
  });

  it("toolStats are independent between runs", async () => {
    const { tool } = mockTool("calc");

    const r1 = await runToolLoop(
      infiniteToolModel("calc"),
      [new HumanMessage("go")],
      [tool],
      {
        maxIterations: 3,
      },
    );
    const r2 = await runToolLoop(
      infiniteToolModel("calc"),
      [new HumanMessage("go")],
      [tool],
      {
        maxIterations: 5,
      },
    );

    const s1 = r1.toolStats.find((s) => s.name === "calc")!;
    const s2 = r2.toolStats.find((s) => s.name === "calc")!;
    expect(s1.calls).toBe(3);
    expect(s2.calls).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 7. Loop terminates naturally when LLM stops calling tools
// ---------------------------------------------------------------------------

describe("Natural termination when LLM stops calling tools", () => {
  it("returns complete when model returns final text on first call", async () => {
    const { tool } = mockTool("step");
    const model = sequentialModel([new AIMessage("I am done")]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 10,
    });

    expect(result.stopReason).toBe("complete");
    expect(result.hitIterationLimit).toBe(false);
  });

  it("returns complete after one tool call followed by final response", async () => {
    const { tool } = mockTool("lookup");
    const model = sequentialModel([
      aiWithCalls([{ name: "lookup" }]),
      new AIMessage("Final answer"),
    ]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 10,
    });

    expect(result.stopReason).toBe("complete");
    expect(result.llmCalls).toBe(2);
  });

  it("returns complete after multiple tool calls followed by final response", async () => {
    const { tool } = mockTool("compute");
    const model = sequentialModel([
      aiWithCalls([{ name: "compute" }]),
      aiWithCalls([{ name: "compute" }]),
      aiWithCalls([{ name: "compute" }]),
      new AIMessage("All computations done"),
    ]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 20,
    });

    expect(result.stopReason).toBe("complete");
    expect(result.llmCalls).toBe(4);
  });

  it("hitIterationLimit is false on natural termination", async () => {
    const { tool } = mockTool("step");
    const model = sequentialModel([
      aiWithCalls([{ name: "step" }]),
      new AIMessage("done"),
    ]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 10,
    });

    expect(result.hitIterationLimit).toBe(false);
  });

  it("final AI message is in result messages on natural termination", async () => {
    const { tool } = mockTool("step");
    const model = sequentialModel([
      aiWithCalls([{ name: "step" }]),
      new AIMessage("The task is complete"),
    ]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 10,
    });

    const lastMsg = result.messages[result.messages.length - 1]!;
    expect(lastMsg._getType()).toBe("ai");
    expect(typeof lastMsg.content === "string" && lastMsg.content).toContain(
      "The task is complete",
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Configurable max — different maxIterations per run
// ---------------------------------------------------------------------------

describe("Configurable maxIterations per run", () => {
  it("maxIterations: 10 allows 10 iterations before exhaustion", async () => {
    const { tool } = mockTool("step");
    const model = infiniteToolModel("step");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 10,
    });

    expect(result.llmCalls).toBe(10);
    expect(result.stopReason).toBe("iteration_limit");
  });

  it("maxIterations: 1 and maxIterations: 10 produce different tool call counts", async () => {
    const { tool } = mockTool("step");

    const r1 = await runToolLoop(
      infiniteToolModel("step"),
      [new HumanMessage("go")],
      [tool],
      {
        maxIterations: 1,
      },
    );
    const r10 = await runToolLoop(
      infiniteToolModel("step"),
      [new HumanMessage("go")],
      [tool],
      {
        maxIterations: 10,
      },
    );

    expect(r1.llmCalls).toBe(1);
    expect(r10.llmCalls).toBe(10);
  });

  it("maxIterations can be passed via spread config", async () => {
    const { tool } = mockTool("step");
    const baseConfig: Omit<ToolLoopConfig, "maxIterations"> = {};
    const model = infiniteToolModel("step");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      ...baseConfig,
      maxIterations: 3,
    });

    expect(result.llmCalls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 9. No-tool run completes in 1 iteration
// ---------------------------------------------------------------------------

describe("No-tool run", () => {
  it("completes in 1 LLM call when no tools are defined", async () => {
    const model = sequentialModel([new AIMessage("Immediate answer")]);

    const result = await runToolLoop(model, [new HumanMessage("hello")], [], {
      maxIterations: 10,
    });

    expect(result.llmCalls).toBe(1);
    expect(result.stopReason).toBe("complete");
  });

  it("toolStats is empty when no tools are defined", async () => {
    const model = sequentialModel([new AIMessage("No tools needed")]);

    const result = await runToolLoop(model, [new HumanMessage("hello")], [], {
      maxIterations: 10,
    });

    expect(result.toolStats).toHaveLength(0);
  });

  it("does not exhaust iterations when model returns final response with no tools", async () => {
    const model = sequentialModel([new AIMessage("Done immediately")]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [], {
      maxIterations: 1,
    });

    // Model returned no tool calls — exits normally
    expect(result.stopReason).toBe("complete");
    expect(result.hitIterationLimit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. Tool error counts toward iteration
// ---------------------------------------------------------------------------

describe("Tool error counts toward iteration", () => {
  it("failed tool call still increments the iteration counter", async () => {
    const bad = failingTool("always-fails");
    const model = infiniteToolModel("always-fails");
    const iterations: number[] = [];

    await runToolLoop(model, [new HumanMessage("go")], [bad], {
      maxIterations: 3,
      onIteration: ({ iteration }) => iterations.push(iteration),
    });

    expect(iterations).toHaveLength(3);
  });

  it("failed tool call does not prevent loop from reaching iteration_limit", async () => {
    const bad = failingTool("broken");
    const model = infiniteToolModel("broken");

    const result = await runToolLoop(model, [new HumanMessage("go")], [bad], {
      maxIterations: 3,
    });

    expect(result.stopReason).toBe("iteration_limit");
    expect(result.llmCalls).toBe(3);
  });

  it("toolStats errors count matches actual failures", async () => {
    const bad = failingTool("flaky");
    const model = infiniteToolModel("flaky");

    const result = await runToolLoop(model, [new HumanMessage("go")], [bad], {
      maxIterations: 4,
    });

    const stat = result.toolStats.find((s) => s.name === "flaky")!;
    expect(stat.calls).toBe(4);
    expect(stat.errors).toBe(4);
  });

  it("mixed success/failure tools: error iteration still counted", async () => {
    const { tool: good } = mockTool("good", "ok");
    const bad = failingTool("bad");

    // Alternating: first iteration calls good, second calls bad, third calls good
    const model = sequentialModel([
      aiWithCalls([{ name: "good" }]),
      aiWithCalls([{ name: "bad" }]),
      aiWithCalls([{ name: "good" }]),
    ]);

    const result = await runToolLoop(
      model,
      [new HumanMessage("go")],
      [good, bad],
      {
        maxIterations: 3,
      },
    );

    expect(result.stopReason).toBe("iteration_limit");
    expect(result.llmCalls).toBe(3);
    const badStat = result.toolStats.find((s) => s.name === "bad")!;
    expect(badStat.errors).toBe(1);
  });

  it("failing tool result is added to messages before exhaustion", async () => {
    const bad = failingTool("explode", "boom!");
    const model = sequentialModel([aiWithCalls([{ name: "explode" }])]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [bad], {
      maxIterations: 1,
    });

    const errorMsg = result.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("boom!"),
    );
    expect(errorMsg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 11. stuckError is undefined on iteration_limit
// ---------------------------------------------------------------------------

describe("stuckError on exhaustion", () => {
  it("stuckError is undefined when stopped by iteration_limit", async () => {
    const { tool } = mockTool("step");
    const model = infiniteToolModel("step");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 3,
    });

    expect(result.stopReason).toBe("iteration_limit");
    expect(result.stuckError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. Multiple tool calls per iteration
// ---------------------------------------------------------------------------

describe("Multiple tool calls per iteration", () => {
  it("multiple tool calls in a single response all count in the same iteration", async () => {
    const { tool: a } = mockTool("alpha");
    const { tool: b } = mockTool("beta");
    const model = sequentialModel([
      aiWithCalls([{ name: "alpha" }, { name: "beta" }]),
      new AIMessage("done"),
    ]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [a, b], {
      maxIterations: 10,
    });

    expect(result.llmCalls).toBe(2); // 1 tool iteration + 1 final
    expect(result.stopReason).toBe("complete");
    const alphaStat = result.toolStats.find((s) => s.name === "alpha")!;
    const betaStat = result.toolStats.find((s) => s.name === "beta")!;
    expect(alphaStat.calls).toBe(1);
    expect(betaStat.calls).toBe(1);
  });

  it("two calls per iteration for 3 iterations = 6 total tool invocations", async () => {
    const { tool: a, invokeFn: invA } = mockTool("a");
    const { tool: b, invokeFn: invB } = mockTool("b");
    const model = infiniteToolModel("a"); // will only call 'a' not 'b' in parallel
    // Override to return both each time
    const twoCallModel: BaseChatModel = {
      invoke: vi.fn(async () => aiWithCalls([{ name: "a" }, { name: "b" }])),
    } as unknown as BaseChatModel;

    await runToolLoop(twoCallModel, [new HumanMessage("go")], [a, b], {
      maxIterations: 3,
    });

    expect(invA).toHaveBeenCalledTimes(3);
    expect(invB).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 13. Message structure on exhaustion
// ---------------------------------------------------------------------------

describe("Message structure on exhaustion", () => {
  it("message count on exhaustion: 1 human + N*(ai+tool) = 1+2N", async () => {
    const N = 3;
    const { tool } = mockTool("step");
    const model = infiniteToolModel("step");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: N,
    });

    // 1 human + N ai + N tool = 1 + 2N
    expect(result.messages).toHaveLength(1 + 2 * N);
  });

  it("last message is a tool message on exhaustion (not final AI)", async () => {
    const { tool } = mockTool("step");
    const model = infiniteToolModel("step");

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 2,
    });

    // The loop appends AI message then tool messages. Last should be a tool message.
    const lastMsg = result.messages[result.messages.length - 1]!;
    expect(lastMsg._getType()).toBe("tool");
  });

  it("token counts are zero when no LLM calls made (maxIterations=0)", async () => {
    const { tool } = mockTool("noop");
    const model = sequentialModel([]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 0,
    });

    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 14. Large maxIterations — completes naturally well before limit
// ---------------------------------------------------------------------------

describe("Large maxIterations — natural exit before limit", () => {
  it("loop exits after 2 tool iterations when model stops, even with maxIterations=100", async () => {
    const { tool } = mockTool("work");
    const model = sequentialModel([
      aiWithCalls([{ name: "work" }]),
      aiWithCalls([{ name: "work" }]),
      new AIMessage("All done"),
    ]);

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 100,
    });

    expect(result.stopReason).toBe("complete");
    expect(result.llmCalls).toBe(3);
    expect(result.hitIterationLimit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. onIteration error tolerance
// ---------------------------------------------------------------------------

describe("onIteration error tolerance", () => {
  it("onIteration error does not abort the loop", async () => {
    const { tool } = mockTool("step");
    const model = sequentialModel([
      aiWithCalls([{ name: "step" }]),
      new AIMessage("done"),
    ]);
    let callCount = 0;

    const result = await runToolLoop(model, [new HumanMessage("go")], [tool], {
      maxIterations: 10,
      onIteration: () => {
        callCount++;
        throw new Error("snapshot write failed");
      },
    });

    // Loop should complete despite the error
    expect(result.stopReason).toBe("complete");
    expect(callCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 16. hitIterationLimit flag consistency
// ---------------------------------------------------------------------------

describe("hitIterationLimit flag consistency", () => {
  it("hitIterationLimit is true iff stopReason is iteration_limit", async () => {
    const { tool } = mockTool("step");

    // Exhausted run
    const exhausted = await runToolLoop(
      infiniteToolModel("step"),
      [new HumanMessage("go")],
      [tool],
      {
        maxIterations: 2,
      },
    );
    expect(exhausted.stopReason).toBe("iteration_limit");
    expect(exhausted.hitIterationLimit).toBe(true);

    // Natural completion run
    const natural = await runToolLoop(
      sequentialModel([new AIMessage("done")]),
      [new HumanMessage("go")],
      [tool],
      { maxIterations: 10 },
    );
    expect(natural.stopReason).toBe("complete");
    expect(natural.hitIterationLimit).toBe(false);
  });
});
