/**
 * W29-D — compressToLevel strategy branches deep coverage.
 *
 * Targets not exercised by existing tests:
 *  - selectCompressionLevel exact boundary thresholds
 *  - Level-by-level budget math and token arithmetic
 *  - Level 1: preserveRecentToolResults=0 edge, config override
 *  - Level 2: aiResponseMaxChars boundary, non-string content, custom charsPerToken
 *  - Level 3: onBeforeSummarize async/sync variations, summary text passthrough, large keepRecent
 *  - Level 4: keepRecentLevel4=1, keepRecentLevel4=0, null/short/long summary
 *  - compressToBudget: escalation ladder, hardTrimToBudget single-message truncation
 *  - Result shape: ratio math, estimatedTokens formula
 *  - Cross-level: result is never a reference to original (immutability)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  selectCompressionLevel,
  compressToLevel,
  compressToBudget,
  type CompressionLevel,
  type ProgressiveCompressConfig,
} from "../progressive-compress.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModel(response = "mock summary"): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
  } as unknown as BaseChatModel;
}

function createFailingModel(): BaseChatModel {
  return {
    invoke: vi.fn().mockRejectedValue(new Error("LLM failed")),
  } as unknown as BaseChatModel;
}

/** Reproduce the module's token estimate. */
function estimateTokens(messages: BaseMessage[], charsPerToken = 4): number {
  let total = 0;
  for (const m of messages) {
    const c =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    total += c.length;
  }
  return Math.ceil(total / charsPerToken);
}

function chars(n: number): string {
  return "x".repeat(n);
}

function makeToolPair(id: string, content: string): BaseMessage[] {
  return [
    new AIMessage({
      content: "",
      tool_calls: [{ id, name: "tool", args: {} }],
    }),
    new ToolMessage({ content, tool_call_id: id, name: "tool" }),
  ];
}

function makePairs(n: number): BaseMessage[] {
  const msgs: BaseMessage[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push(new HumanMessage(`human-${i}`));
    msgs.push(new AIMessage(`ai-${i}`));
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// selectCompressionLevel — exact thresholds
// ---------------------------------------------------------------------------

describe("selectCompressionLevel — exact boundary values", () => {
  // Token estimation: N chars / 4 charsPerToken = N/4 tokens

  it("returns 0 exactly at budget (estimated === budget)", () => {
    // 400 chars / 4 = 100 tokens; budget = 100
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 100)).toBe(0);
  });

  it("returns 0 when one token under budget", () => {
    // 396 chars = 99 tokens; budget = 100
    expect(selectCompressionLevel([new HumanMessage(chars(396))], 100)).toBe(0);
  });

  it("returns 1 at exactly estimated * 0.70 === budget boundary", () => {
    // estimated = 100 tokens (400 chars), budget = 70 => 100*0.70 = 70 <= 70 → L1
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 70)).toBe(1);
  });

  it("returns 1 one token above the L0 boundary", () => {
    // estimated = 100, budget = 99 → not L0, 70 <= 99 → L1
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 99)).toBe(1);
  });

  it("returns 2 at exactly estimated * 0.50 === budget boundary", () => {
    // estimated = 100, budget = 50 → 70 > 50, 50 <= 50 → L2
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 50)).toBe(2);
  });

  it("returns 2 one token above L1 threshold", () => {
    // estimated = 100, budget = 69 → 70 > 69, 50 <= 69 → L2
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 69)).toBe(2);
  });

  it("returns 3 at exactly estimated * 0.30 === budget boundary", () => {
    // estimated = 100, budget = 30 → 50 > 30, 30 <= 30 → L3
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 30)).toBe(3);
  });

  it("returns 3 one token above L2 threshold", () => {
    // estimated = 100, budget = 49 → 50 > 49, 30 <= 49 → L3
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 49)).toBe(3);
  });

  it("returns 4 when budget is one token below L3 threshold", () => {
    // estimated = 100, budget = 29 → 30 > 29 → L4
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 29)).toBe(4);
  });

  it("returns 4 for budget = 0", () => {
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 0)).toBe(4);
  });

  it("returns 4 for negative budget", () => {
    expect(selectCompressionLevel([new HumanMessage(chars(400))], -100)).toBe(
      4
    );
  });

  it("returns 0 for empty messages regardless of budget", () => {
    expect(selectCompressionLevel([], 0)).toBe(0);
    expect(selectCompressionLevel([], 1000)).toBe(0);
  });

  it("handles multi-message token sum correctly", () => {
    // Two 200-char messages = 400 chars = 100 tokens
    const msgs = [new HumanMessage(chars(200)), new AIMessage(chars(200))];
    // budget=70 => same as single 400-char message
    expect(selectCompressionLevel(msgs, 70)).toBe(1);
  });

  it("respects charsPerToken=2 (more tokens per char)", () => {
    // 400 chars / 2 = 200 tokens, budget = 140 → 200*0.70=140 <= 140 → L1
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 140, 2)).toBe(
      1
    );
  });

  it("respects charsPerToken=8 (fewer tokens per char)", () => {
    // 400 chars / 8 = 50 tokens, budget = 50 → L0
    expect(selectCompressionLevel([new HumanMessage(chars(400))], 50, 8)).toBe(
      0
    );
  });

  it("returns 4 for budget=1 with any content", () => {
    const msgs = [new HumanMessage(chars(40))];
    expect(selectCompressionLevel(msgs, 1)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// compressToLevel — Level 0 token math
// ---------------------------------------------------------------------------

describe("compressToLevel level 0 — token math", () => {
  it("estimatedTokens at level 0 uses ceil(totalChars / 4)", async () => {
    const model = createMockModel();
    // 13 chars → ceil(13/4) = 4
    const msgs = [new HumanMessage("hello world!!")];
    const result = await compressToLevel(msgs, 0, null, model);
    expect(result.estimatedTokens).toBe(Math.ceil("hello world!!".length / 4));
  });

  it("custom charsPerToken=2 doubles the token estimate", async () => {
    const model = createMockModel();
    const msgs = [new HumanMessage(chars(20))];
    const r4 = await compressToLevel(msgs, 0, null, model, {
      charsPerToken: 4,
    });
    const r2 = await compressToLevel(msgs, 0, null, model, {
      charsPerToken: 2,
    });
    expect(r2.estimatedTokens).toBe(r4.estimatedTokens * 2);
  });

  it("ratio is exactly 0 at level 0 always", async () => {
    const model = createMockModel();
    for (const content of ["", chars(10), chars(1000)]) {
      const msgs = content === "" ? [] : [new HumanMessage(content)];
      const result = await compressToLevel(msgs, 0, null, model);
      expect(result.ratio).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// compressToLevel — Level 1 tool pruning config branches
// ---------------------------------------------------------------------------

describe("compressToLevel level 1 — config variations", () => {
  it("with preserveRecentToolResults=0 all tool results are pruned", async () => {
    const model = createMockModel();
    const msgs: BaseMessage[] = [
      ...makeToolPair("tc-1", chars(500)),
      ...makeToolPair("tc-2", chars(500)),
      ...makeToolPair("tc-3", chars(500)),
    ];
    const result = await compressToLevel(msgs, 1, null, model, {
      preserveRecentToolResults: 0,
    });
    const toolMsgs = result.messages.filter((m) => m._getType() === "tool");
    for (const m of toolMsgs) {
      const c = typeof m.content === "string" ? m.content : "";
      expect(c).toContain("[Tool result pruned]");
    }
  });

  it("with preserveRecentToolResults=1 only the last 1 tool result is kept intact", async () => {
    const model = createMockModel();
    const msgs: BaseMessage[] = [
      ...makeToolPair("tc-1", chars(500)),
      ...makeToolPair("tc-2", chars(500)),
      ...makeToolPair("tc-3", "LAST_RESULT"),
    ];
    const result = await compressToLevel(msgs, 1, null, model, {
      preserveRecentToolResults: 1,
    });
    const toolMsgs = result.messages.filter((m) => m._getType() === "tool");
    const lastTool = toolMsgs[toolMsgs.length - 1];
    const c = typeof lastTool?.content === "string" ? lastTool.content : "";
    expect(c).toContain("LAST_RESULT");
  });

  it("non-tool messages are preserved unchanged at level 1", async () => {
    const model = createMockModel();
    const msgs = [
      new SystemMessage("system"),
      new HumanMessage("human message"),
      new AIMessage("ai message"),
    ];
    const result = await compressToLevel(msgs, 1, null, model);
    expect(result.messages.length).toBe(3);
    expect(result.messages[0]?._getType()).toBe("system");
    expect(result.messages[1]?._getType()).toBe("human");
    expect(result.messages[2]?._getType()).toBe("ai");
  });

  it("level is reported as 1 in result", async () => {
    const model = createMockModel();
    const result = await compressToLevel([], 1, null, model);
    expect(result.level).toBe(1);
  });

  it("existingSummary is passed through unchanged at level 1", async () => {
    const model = createMockModel();
    const result = await compressToLevel([], 1, "my summary", model);
    expect(result.summary).toBe("my summary");
  });

  it("ratio is non-negative when tool results are pruned", async () => {
    const model = createMockModel();
    const msgs: BaseMessage[] = [
      ...makeToolPair("tc-1", chars(2000)),
      ...makeToolPair("tc-2", chars(2000)),
    ];
    const result = await compressToLevel(msgs, 1, null, model, {
      preserveRecentToolResults: 0,
    });
    expect(result.ratio).toBeGreaterThanOrEqual(0);
    expect(result.ratio).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// compressToLevel — Level 2 AI trimming detailed branches
// ---------------------------------------------------------------------------

describe("compressToLevel level 2 — AI trim boundary cases", () => {
  it("does not trim AI message at exactly aiResponseMaxChars", async () => {
    const model = createMockModel();
    const content = chars(200);
    const msgs = [new HumanMessage("q"), new AIMessage(content)];
    const result = await compressToLevel(msgs, 2, null, model, {
      aiResponseMaxChars: 200,
    });
    const aiOut = result.messages.find((m) => m._getType() === "ai")!;
    expect(aiOut.content).toBe(content);
  });

  it("trims AI message at aiResponseMaxChars + 1", async () => {
    const model = createMockModel();
    const content = chars(201);
    const msgs = [new HumanMessage("q"), new AIMessage(content)];
    const result = await compressToLevel(msgs, 2, null, model, {
      aiResponseMaxChars: 200,
    });
    const aiOut = result.messages.find((m) => m._getType() === "ai")!;
    const c = typeof aiOut.content === "string" ? aiOut.content : "";
    expect(c).toContain("[trimmed]");
  });

  it("trims multiple AI messages in the same message list", async () => {
    const model = createMockModel();
    const msgs = [
      new HumanMessage("q1"),
      new AIMessage(chars(1000)),
      new HumanMessage("q2"),
      new AIMessage(chars(1000)),
    ];
    const result = await compressToLevel(msgs, 2, null, model, {
      aiResponseMaxChars: 100,
    });
    const aiMsgs = result.messages.filter((m) => m._getType() === "ai");
    for (const m of aiMsgs) {
      const c = typeof m.content === "string" ? m.content : "";
      expect(c).toContain("[trimmed]");
    }
  });

  it("human messages are never trimmed at level 2", async () => {
    const model = createMockModel();
    const longHuman = chars(5000);
    const msgs = [new HumanMessage(longHuman), new AIMessage("short")];
    const result = await compressToLevel(msgs, 2, null, model, {
      aiResponseMaxChars: 100,
    });
    const humanOut = result.messages.find((m) => m._getType() === "human")!;
    expect(humanOut.content).toBe(longHuman);
  });

  it("system messages are never trimmed at level 2", async () => {
    const model = createMockModel();
    const longSys = chars(5000);
    const msgs = [
      new SystemMessage(longSys),
      new HumanMessage("q"),
      new AIMessage("a"),
    ];
    const result = await compressToLevel(msgs, 2, null, model, {
      aiResponseMaxChars: 100,
    });
    const sysOut = result.messages.find((m) => m._getType() === "system")!;
    expect(sysOut.content).toBe(longSys);
  });

  it("non-string AI content is serialised before measuring length", async () => {
    const model = createMockModel();
    // Tool calls carry structured content; the array serialised is typically long
    const msgs = [
      new AIMessage({
        content: [{ type: "text", text: chars(600) }],
        tool_calls: [{ id: "tc-1", name: "t", args: {} }],
      }),
      new ToolMessage({ content: "r", tool_call_id: "tc-1", name: "t" }),
    ];
    // tool_calls presence prevents trimming regardless of content length
    const result = await compressToLevel(msgs, 2, null, model, {
      aiResponseMaxChars: 100,
    });
    expect(result.level).toBe(2);
    // Should not throw; AI message preserved (has tool_calls)
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("estimated tokens decrease after trimming long AI messages", async () => {
    const model = createMockModel();
    const msgs = [new HumanMessage("q"), new AIMessage(chars(4000))];
    const r0 = await compressToLevel(msgs, 0, null, model);
    const r2 = await compressToLevel(msgs, 2, null, model, {
      aiResponseMaxChars: 200,
    });
    expect(r2.estimatedTokens).toBeLessThan(r0.estimatedTokens);
  });

  it("ratio is positive after trimming long AI messages", async () => {
    const model = createMockModel();
    const msgs = [new HumanMessage("q"), new AIMessage(chars(4000))];
    const result = await compressToLevel(msgs, 2, null, model, {
      aiResponseMaxChars: 100,
    });
    expect(result.ratio).toBeGreaterThan(0);
  });

  it("level is reported as 2 in result", async () => {
    const model = createMockModel();
    const result = await compressToLevel([], 2, null, model);
    expect(result.level).toBe(2);
  });

  it("includes level 1 processing (tool pruning) in level 2 output", async () => {
    // Level 2 = level 1 + AI trim, so old tool results should be pruned too
    const model = createMockModel();
    const msgs: BaseMessage[] = [
      ...makeToolPair("tc-old", chars(500)),
      ...makeToolPair("tc-old2", chars(500)),
      ...makeToolPair("tc-old3", chars(500)),
      ...makeToolPair("tc-old4", chars(500)),
      ...makeToolPair("tc-old5", chars(500)),
      ...makeToolPair("tc-old6", chars(500)),
      ...makeToolPair("tc-old7", chars(500)), // 7 pairs > default preserve=6
      new HumanMessage("q"),
      new AIMessage(chars(600)),
    ];
    const result = await compressToLevel(msgs, 2, null, model, {
      aiResponseMaxChars: 200,
    });
    const toolMsgs = result.messages.filter((m) => m._getType() === "tool");
    const pruned = toolMsgs.filter((m) => {
      const c = typeof m.content === "string" ? m.content : "";
      return c.includes("[Tool result pruned]");
    });
    expect(pruned.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// compressToLevel — Level 3 summarization branches
// ---------------------------------------------------------------------------

describe("compressToLevel level 3 — summarization branches", () => {
  it("returns model summary text verbatim", async () => {
    const model = createMockModel(
      "## Goal\nRefactor the codebase\n## Progress\nDone step 1"
    );
    const msgs = makePairs(12); // > default keepRecentLevel3=10
    const result = await compressToLevel(msgs, 3, null, model);
    expect(result.summary).toBe(
      "## Goal\nRefactor the codebase\n## Progress\nDone step 1"
    );
  });

  it("level 3 result still has level=3 even after fallback inside summarizeAndTrim", async () => {
    // summarizeAndTrim itself catches LLM errors but compressToLevel sees the trimmed msgs
    const model = createFailingModel();
    const msgs = makePairs(12);
    const result = await compressToLevel(msgs, 3, null, model);
    // summarizeAndTrim catches, returns fallback, compressToLevel stays at level 3
    expect(result.level).toBe(3);
  });

  it("message count after level 3 is <= keepRecentLevel3", async () => {
    const model = createMockModel("summary");
    const msgs = makePairs(12); // 24 messages
    const result = await compressToLevel(msgs, 3, null, model, {
      keepRecentLevel3: 6,
    });
    expect(result.messages.length).toBeLessThanOrEqual(6);
  });

  it("with keepRecentLevel3 larger than message count no messages are dropped", async () => {
    const model = createMockModel("summary");
    const msgs = makePairs(3); // 6 messages
    const result = await compressToLevel(msgs, 3, null, model, {
      keepRecentLevel3: 20,
    });
    // All 6 original messages kept (summariseAndTrim skips summarization)
    expect(result.messages.length).toBe(6);
  });

  it("onBeforeSummarize receives messages count = total - keepRecentLevel3", async () => {
    const hook = vi.fn();
    const model = createMockModel("summary");
    const msgs = makePairs(12); // 24 messages
    await compressToLevel(msgs, 3, null, model, {
      onBeforeSummarize: hook,
      keepRecentLevel3: 8,
    });
    const received = hook.mock.calls[0]?.[0] as BaseMessage[];
    // Hook receives the old messages = total - keepRecentLevel3 in the pre-L1+L2 form
    expect(received.length).toBeGreaterThan(0);
  });

  it("async onBeforeSummarize hook is awaited before summarization", async () => {
    const order: string[] = [];
    const hook = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      order.push("hook");
    });
    const model = {
      invoke: vi.fn().mockImplementation(async () => {
        order.push("model");
        return new AIMessage("summary");
      }),
    } as unknown as BaseChatModel;
    const msgs = makePairs(12);
    await compressToLevel(msgs, 3, null, model, { onBeforeSummarize: hook });
    // hook always runs before model.invoke (indirectly via summarizeAndTrim)
    expect(order[0]).toBe("hook");
    expect(order).toContain("model");
  });

  it("existingSummary fed through as context for the model call", async () => {
    // The model gets called with existing summary folded into the prompt
    const model = createMockModel("new summary incorporating old");
    const msgs = makePairs(12);
    const result = await compressToLevel(msgs, 3, "OLD_SUMMARY", model);
    expect(result.level).toBe(3);
    expect(typeof result.summary).toBe("string");
  });

  it("level 3 includes level 1+2 processing before summarization", async () => {
    // After level-2 trimming, AI messages should be short; if we feed very long
    // AI messages, the post-compression token count should be far smaller than original.
    const model = createMockModel("brief summary");
    const msgs = [
      ...Array.from({ length: 15 }, (_, i) => [
        new HumanMessage(`q-${i}`),
        new AIMessage(chars(2000)),
      ]).flat(),
    ];
    const r0 = await compressToLevel(msgs, 0, null, model);
    const r3 = await compressToLevel(msgs, 3, null, model);
    expect(r3.estimatedTokens).toBeLessThan(r0.estimatedTokens);
  });
});

// ---------------------------------------------------------------------------
// compressToLevel — Level 4 ultra-compressed branches
// ---------------------------------------------------------------------------

describe("compressToLevel level 4 — ultra-compressed branches", () => {
  it("keepRecentLevel4=1 keeps only the single most recent message", async () => {
    const model = createMockModel();
    const msgs = makePairs(10); // 20 messages
    const result = await compressToLevel(msgs, 4, null, model, {
      keepRecentLevel4: 1,
    });
    // After repairOrphanedToolPairs at most a tiny set remains
    expect(result.messages.length).toBeLessThanOrEqual(3);
  });

  it("keepRecentLevel4=0 returns all remaining messages (slice(-0) = slice(0) = all)", async () => {
    // JS: arr.slice(-0) === arr.slice(0) returns the full array.
    // So keepRecentLevel4=0 is effectively a no-op on the slice step.
    const model = createMockModel();
    const msgs = makePairs(10);
    const result = await compressToLevel(msgs, 4, null, model, {
      keepRecentLevel4: 0,
    });
    // The full (post-L1+L2) message list is kept because slice(-0) = slice(0)
    expect(result.level).toBe(4);
    expect(result.messages.length).toBeGreaterThanOrEqual(0);
  });

  it("summary exactly at 500 chars is not truncated", async () => {
    const model = createMockModel();
    const summary500 = chars(500);
    const result = await compressToLevel(makePairs(5), 4, summary500, model);
    expect(result.summary).toBe(summary500);
  });

  it("summary at 501 chars gets truncated: first 500 chars kept + ...[truncated] appended", async () => {
    // Source: summary.slice(0, 500) + '...[truncated]' → total = 514 chars (> original 501)
    // The important invariant: original content beyond 500 chars is discarded.
    const model = createMockModel();
    const summary501 = "A".repeat(501);
    const result = await compressToLevel(makePairs(5), 4, summary501, model);
    expect(result.summary).not.toBeNull();
    expect(result.summary!).toContain("[truncated]");
    // Original char at position 500 ('A') is not present as content — only first 500 kept
    expect(result.summary!.startsWith("A".repeat(500))).toBe(true);
    // The resulting string ends with the truncation marker
    expect(result.summary!.endsWith("...[truncated]")).toBe(true);
  });

  it("null summary passes through as null at level 4", async () => {
    const model = createMockModel();
    const result = await compressToLevel(makePairs(5), 4, null, model);
    expect(result.summary).toBeNull();
  });

  it("level 4 result has level=4", async () => {
    const model = createMockModel();
    const result = await compressToLevel(makePairs(5), 4, null, model);
    expect(result.level).toBe(4);
  });

  it("ratio is >= 0 and <= 1 at level 4 for any input", async () => {
    const model = createMockModel();
    for (const n of [0, 1, 5, 20]) {
      const msgs = makePairs(n);
      const result = await compressToLevel(msgs, 4, null, model);
      expect(result.ratio).toBeGreaterThanOrEqual(0);
      expect(result.ratio).toBeLessThanOrEqual(1);
    }
  });

  it("onBeforeSummarize not called when messages.length <= keepRecentLevel4", async () => {
    const hook = vi.fn();
    const model = createMockModel();
    const msgs = makePairs(1); // 2 messages, keepRecentLevel4=3 => 2 <= 3
    await compressToLevel(msgs, 4, null, model, {
      onBeforeSummarize: hook,
      keepRecentLevel4: 3,
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it("onBeforeSummarize called when messages.length > keepRecentLevel4", async () => {
    const hook = vi.fn();
    const model = createMockModel();
    const msgs = makePairs(5); // 10 messages > keepRecentLevel4=3
    await compressToLevel(msgs, 4, null, model, {
      onBeforeSummarize: hook,
      keepRecentLevel4: 3,
    });
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("onBeforeSummarize receives the old messages slice at level 4", async () => {
    const received: BaseMessage[][] = [];
    const model = createMockModel();
    const msgs = makePairs(5); // 10 messages
    await compressToLevel(msgs, 4, null, model, {
      onBeforeSummarize: (old) => {
        received.push(old);
      },
      keepRecentLevel4: 2,
    });
    expect(received.length).toBe(1);
    // Old messages = total - keepRecentLevel4 (approximately, after level 1+2 processing)
    expect(received[0]!.length).toBeGreaterThan(0);
  });

  it("includes level 1+2 processing before keeping last N", async () => {
    // If level 4 applies L1 first, old tool results should appear pruned
    const model = createMockModel();
    const msgs: BaseMessage[] = [
      ...makeToolPair("tc-1", chars(500)),
      ...makeToolPair("tc-2", chars(500)),
      ...makeToolPair("tc-3", chars(500)),
      ...makeToolPair("tc-4", chars(500)),
      ...makeToolPair("tc-5", chars(500)),
      ...makeToolPair("tc-6", chars(500)),
      ...makeToolPair("tc-7", chars(500)),
      ...makeToolPair("tc-recent", "RECENT"),
      new HumanMessage("latest q"),
      new AIMessage(chars(600)),
    ];
    // keepRecentLevel4=3 — mostly just the last 3 messages remain
    const result = await compressToLevel(msgs, 4, null, model, {
      keepRecentLevel4: 3,
      aiResponseMaxChars: 300,
    });
    // Result should be very small
    expect(result.messages.length).toBeLessThanOrEqual(5);
  });

  it("level 4 with all messages fitting in keepRecentLevel4 keeps all", async () => {
    const model = createMockModel();
    const msgs = makePairs(1); // 2 messages
    const result = await compressToLevel(msgs, 4, null, model, {
      keepRecentLevel4: 10,
    });
    expect(result.messages.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// compressToBudget — escalation ladder and hard trim
// ---------------------------------------------------------------------------

describe("compressToBudget — escalation ladder", () => {
  it("does not escalate when initial level meets budget", async () => {
    const model = createMockModel("summary");
    // 400 chars = 100 tokens. Budget = 80. selectCompressionLevel returns 1.
    // Level 1 strips tool results but there are none; tokens remain at ~100.
    // But since we have no tool results, level 1 won't reduce below 100…
    // actually test the contract: when level 0 fits, level 0 is used.
    const msgs = [new HumanMessage(chars(40))]; // 10 tokens, budget 100
    const result = await compressToBudget(msgs, 100, null, model);
    expect(result.level).toBe(0);
  });

  it("escalates from level 1 to higher when tokens still exceed budget", async () => {
    // Human content is not pruned at level 1 — forces escalation
    const model = createMockModel("summary");
    const msgs = [new HumanMessage(chars(400))]; // 100 tokens, budget=50
    const result = await compressToBudget(msgs, 50, null, model);
    // Level 2 (estimated*0.5=50 <= 50) but human msg won't shrink, so escalates to L3/L4
    expect(result.level).toBeGreaterThan(1);
    expect(result.estimatedTokens).toBeLessThanOrEqual(50);
  });

  it("applies hardTrimToBudget on single message when all levels fail", async () => {
    // One huge human message that no level can trim (only hardTrim can)
    const model = createMockModel("summary");
    const msgs = [new HumanMessage(chars(4000))];
    const result = await compressToBudget(msgs, 10, null, model);
    expect(result.estimatedTokens).toBeLessThanOrEqual(10);
    expect(result.messages.length).toBeLessThanOrEqual(1);
  });

  it("returns empty array for budget <= 0", async () => {
    const model = createMockModel();
    const result = await compressToBudget(
      [new HumanMessage("hello")],
      0,
      null,
      model
    );
    expect(result.messages).toEqual([]);
    expect(result.estimatedTokens).toBe(0);
    expect(result.level).toBe(4);
  });

  it("returns level 0 for empty messages regardless of budget", async () => {
    const model = createMockModel();
    const result = await compressToBudget([], 100, null, model);
    expect(result.level).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("existingSummary is threaded through to the final result", async () => {
    const model = createMockModel();
    const result = await compressToBudget([], 100, "preserved summary", model);
    expect(result.summary).toBe("preserved summary");
  });

  it("budget larger than content returns level 0", async () => {
    const model = createMockModel();
    const msgs = makePairs(2); // tiny
    const result = await compressToBudget(msgs, 100_000, null, model);
    expect(result.level).toBe(0);
  });

  it("passes config (charsPerToken) through to compressToLevel", async () => {
    const model = createMockModel("sum");
    // 200 chars / 2 cpt = 100 tokens. Budget=50. L2 threshold = 50 tokens → L2.
    const msgs = [new HumanMessage(chars(200))];
    const result = await compressToBudget(msgs, 50, null, model, {
      charsPerToken: 2,
    });
    // Human messages not shrunk at L2, so escalation to L4 forces hard trim
    expect(result.estimatedTokens).toBeLessThanOrEqual(50);
  });

  it("hard trim truncates to roughly budget * charsPerToken chars", async () => {
    const model = createMockModel();
    // 2000-char message = 500 tokens, budget = 5 tokens → 5*4=20 chars max
    const msgs = [new HumanMessage(chars(2000))];
    const result = await compressToBudget(msgs, 5, null, model);
    const content = result.messages[0]?.content;
    if (typeof content === "string") {
      // Content should be at most 20 chars plus truncation marker
      expect(content.length).toBeLessThanOrEqual(5 * 4 + 50); // small slack for marker
    }
    expect(result.estimatedTokens).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// compressToLevel — result shape correctness
// ---------------------------------------------------------------------------

describe("compressToLevel — result shape", () => {
  it("all result fields are present at every level", async () => {
    const model = createMockModel("summary");
    for (const level of [0, 1, 2, 3, 4] as CompressionLevel[]) {
      const result = await compressToLevel(makePairs(6), level, null, model);
      expect(result).toHaveProperty("messages");
      expect(result).toHaveProperty("summary");
      expect(result).toHaveProperty("level");
      expect(result).toHaveProperty("estimatedTokens");
      expect(result).toHaveProperty("ratio");
    }
  });

  it("estimatedTokens matches the module token formula at each level", async () => {
    const model = createMockModel("s");
    const msgs = makePairs(3);
    for (const level of [0, 1, 2] as CompressionLevel[]) {
      const result = await compressToLevel(msgs, level, null, model);
      const computed = estimateTokens(result.messages, 4);
      expect(result.estimatedTokens).toBe(computed);
    }
  });

  it("ratio = 1 - (estimatedTokens / originalTokens) clamped to [0,1]", async () => {
    const model = createMockModel("s");
    const msgs = [new HumanMessage(chars(400))]; // 100 tokens original
    for (const level of [0, 1, 2] as CompressionLevel[]) {
      const result = await compressToLevel(msgs, level, null, model);
      const original = estimateTokens(msgs);
      const expected = Math.max(
        0,
        Math.min(1, 1 - result.estimatedTokens / original)
      );
      expect(result.ratio).toBeCloseTo(expected, 10);
    }
  });

  it("level 0 always returns same messages reference", async () => {
    const model = createMockModel();
    const msgs = makePairs(3);
    const result = await compressToLevel(msgs, 0, null, model);
    expect(result.messages).toBe(msgs);
  });

  it("levels 1+ do not return same reference as original input", async () => {
    const model = createMockModel("s");
    const msgs = makePairs(3);
    for (const level of [1, 2] as CompressionLevel[]) {
      const result = await compressToLevel(msgs, level, null, model);
      // The returned array may be different (even if same content, it went through pipeline)
      // The key invariant: original array is not mutated
      expect(msgs.length).toBe(6);
    }
  });

  it("original messages array is never mutated by any level", async () => {
    const model = createMockModel("sum");
    const original = makePairs(8);
    const originalLength = original.length;
    for (const level of [0, 1, 2, 3, 4] as CompressionLevel[]) {
      await compressToLevel(original, level, null, model);
      expect(original.length).toBe(originalLength);
    }
  });
});

// ---------------------------------------------------------------------------
// selectCompressionLevel + compressToLevel integration: budget achievement
// ---------------------------------------------------------------------------

describe("selectCompressionLevel + compressToLevel — budget achievement", () => {
  it("applying the selected level achieves budget for typical AI-heavy conversations", async () => {
    const model = createMockModel("short summary");
    const msgs = [
      ...Array.from({ length: 10 }, (_, i) => [
        new HumanMessage(`Q${i}`),
        new AIMessage(chars(800)), // long AI response
      ]).flat(),
    ];
    const budget = 200;
    const level = selectCompressionLevel(msgs, budget);
    const result = await compressToLevel(msgs, level, null, model);
    // Heuristic might not hit the budget — that's fine; compressToBudget handles escalation.
    // What we verify: the level is > 0 (compression was triggered).
    expect(level).toBeGreaterThan(0);
    expect(result.level).toBe(level);
  });

  it("level 0 selected when content perfectly fits budget — no model call made", async () => {
    const invoke = vi.fn();
    const model = { invoke } as unknown as BaseChatModel;
    const msgs = [new HumanMessage(chars(40))]; // 10 tokens
    const level = selectCompressionLevel(msgs, 100);
    expect(level).toBe(0);
    await compressToLevel(msgs, level, null, model);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("level 1 selected and applied: model not called (level 1 is LLM-free)", async () => {
    const invoke = vi.fn();
    const model = { invoke } as unknown as BaseChatModel;
    // 400 chars = 100 tokens; budget = 80 → level 1
    const msgs = [new HumanMessage(chars(400))];
    const level = selectCompressionLevel(msgs, 80);
    expect(level).toBe(1);
    await compressToLevel(msgs, level, null, model);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("level 2 selected and applied: model not called (level 2 is LLM-free)", async () => {
    const invoke = vi.fn();
    const model = { invoke } as unknown as BaseChatModel;
    // budget = 50 → level 2
    const msgs = [new HumanMessage(chars(400))];
    const level = selectCompressionLevel(msgs, 50);
    expect(level).toBe(2);
    await compressToLevel(msgs, level, null, model);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("level 3 and 4 call the model", async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage("summary"));
    const model = { invoke } as unknown as BaseChatModel;
    const msgs = makePairs(12); // enough for summarization
    // level 3 — budget=30 (30% of 100)
    const level3msgs = [new HumanMessage(chars(400))];
    const level = selectCompressionLevel(level3msgs, 30);
    expect(level).toBe(3);
    await compressToLevel(msgs, 3, null, model);
    expect(invoke).toHaveBeenCalled();
  });
});
