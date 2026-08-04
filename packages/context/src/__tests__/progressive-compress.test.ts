import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  selectCompressionLevel,
  compressToLevel,
  compressToBudget,
  type CompressionLevel,
} from "../progressive-compress.js";
import { compressToHardBudget } from "../hard-budget-compress.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock BaseChatModel that returns a fixed response. */
function createMockModel(response: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
  } as unknown as BaseChatModel;
}

/** Create a mock model that rejects with an error. */
function createFailingModel(error: string): BaseChatModel {
  return {
    invoke: vi.fn().mockRejectedValue(new Error(error)),
  } as unknown as BaseChatModel;
}

/** Build a simple conversation of human/ai pairs. */
function makeConversation(pairs: number): BaseMessage[] {
  const msgs: BaseMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    msgs.push(new HumanMessage(`Question ${i}`));
    msgs.push(new AIMessage(`Answer ${i}`));
  }
  return msgs;
}

/** Build a message with a specific character length. */
function makeHumanMessage(charCount: number): HumanMessage {
  return new HumanMessage("x".repeat(charCount));
}

/** Create an AI message with tool_calls. */
function makeAIWithToolCalls(content: string, callId: string): AIMessage {
  return new AIMessage({
    content,
    tool_calls: [{ id: callId, name: "test_tool", args: {} }],
  });
}

/** Create a ToolMessage result. */
function makeToolMessage(callId: string, content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: callId, name: "test_tool" });
}

const exactCharacterCounter = {
  count: (text: string) => text.length,
  countDetailed: (text: string) => ({
    tokens: text.length,
    method: "exact" as const,
    model: "exact-character-counter",
  }),
};

/** Estimate tokens the same way the module does. */
function estimateTokens(messages: BaseMessage[], charsPerToken = 4): number {
  let totalChars = 0;
  for (const m of messages) {
    const content =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    totalChars += content.length;
  }
  return Math.ceil(totalChars / charsPerToken);
}

// ---------------------------------------------------------------------------
// selectCompressionLevel
// ---------------------------------------------------------------------------

describe("selectCompressionLevel", () => {
  it("returns 0 when estimated tokens are under budget", () => {
    // 2 messages, ~5 tokens each => ~10 tokens total, budget=100
    const msgs = [new HumanMessage("hello"), new AIMessage("world")];
    expect(selectCompressionLevel(msgs, 100)).toBe(0);
  });

  it("returns 1 when 70% of estimated tokens fits budget", () => {
    // estimated = 100, budget = 80 => 100 > 80 (not L0), 100*0.70=70 <= 80 (L1)
    const msgs = [makeHumanMessage(400)]; // 400 chars / 4 = 100 tokens
    expect(selectCompressionLevel(msgs, 80)).toBe(1);
  });

  it("returns 2 when 50% of estimated tokens fits budget", () => {
    // estimated = 100, budget = 55 => 70 > 55, 50 <= 55 (L2)
    const msgs = [makeHumanMessage(400)];
    expect(selectCompressionLevel(msgs, 55)).toBe(2);
  });

  it("returns 3 when 30% of estimated tokens fits budget", () => {
    // estimated = 100, budget = 35 => 50 > 35, 30 <= 35 (L3)
    const msgs = [makeHumanMessage(400)];
    expect(selectCompressionLevel(msgs, 35)).toBe(3);
  });

  it("returns 4 when even 30% exceeds budget", () => {
    // estimated = 100, budget = 10 => 30 > 10 (L4)
    const msgs = [makeHumanMessage(400)];
    expect(selectCompressionLevel(msgs, 10)).toBe(4);
  });

  it("respects custom charsPerToken", () => {
    // 400 chars / 2 charsPerToken = 200 tokens, budget = 150
    // 200 > 150 (not L0), 200*0.70=140 <= 150 (L1)
    const msgs = [makeHumanMessage(400)];
    expect(selectCompressionLevel(msgs, 150, 2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// compressToLevel — Level 0
// ---------------------------------------------------------------------------

describe("compressToLevel", () => {
  let mockModel: BaseChatModel;

  beforeEach(() => {
    mockModel = createMockModel("## Summary\nTest summary");
  });

  describe("level 0 — no compression", () => {
    it("returns messages unchanged", async () => {
      const msgs = makeConversation(5);
      const result = await compressToLevel(msgs, 0, null, mockModel);

      expect(result.level).toBe(0);
      expect(result.messages).toBe(msgs); // same reference
      expect(result.summary).toBeNull();
      expect(result.ratio).toBe(0);
      expect(result.estimatedTokens).toBe(estimateTokens(msgs));
    });

    it("preserves existing summary at level 0", async () => {
      const msgs = makeConversation(2);
      const result = await compressToLevel(msgs, 0, "prior summary", mockModel);

      expect(result.summary).toBe("prior summary");
    });
  });

  // -------------------------------------------------------------------------
  // Level 1 — tool result pruning + orphan repair
  // -------------------------------------------------------------------------

  describe("level 1 — tool result pruning", () => {
    it("prunes old tool results", async () => {
      const msgs: BaseMessage[] = [
        new HumanMessage("start"),
        makeAIWithToolCalls("calling tool", "call-1"),
        makeToolMessage("call-1", "A".repeat(200)),
        makeAIWithToolCalls("calling again", "call-2"),
        makeToolMessage("call-2", "B".repeat(200)),
        // Recent tool results (within default preserveRecentToolResults=6)
        ...Array.from({ length: 6 }, (_, i) => {
          const id = `recent-${i}`;
          return [
            makeAIWithToolCalls(`recent call ${i}`, id),
            makeToolMessage(id, `recent result ${i}`),
          ];
        }).flat(),
      ];

      const result = await compressToLevel(msgs, 1, null, mockModel);

      expect(result.level).toBe(1);
      // The first two tool results should be pruned (placeholder content)
      const toolMsgs = result.messages.filter((m) => m._getType() === "tool");
      const prunedOnes = toolMsgs.filter((m) => {
        const content = typeof m.content === "string" ? m.content : "";
        return content.includes("[Tool result pruned]");
      });
      expect(prunedOnes.length).toBeGreaterThan(0);
    });

    it("repairs orphaned tool pairs", async () => {
      // ToolMessage without matching AIMessage tool_call
      const msgs: BaseMessage[] = [
        new HumanMessage("start"),
        new ToolMessage({
          content: "orphan",
          tool_call_id: "no-parent",
          name: "ghost",
        }),
        new AIMessage("end"),
      ];

      const result = await compressToLevel(msgs, 1, null, mockModel);

      // Orphaned tool message should be removed
      const toolMsgs = result.messages.filter((m) => m._getType() === "tool");
      const orphans = toolMsgs.filter((m) => {
        const tm = m as ToolMessage;
        return tm.tool_call_id === "no-parent";
      });
      expect(orphans.length).toBe(0);
    });

    it("inserts stub for unanswered tool calls", async () => {
      const msgs: BaseMessage[] = [
        new HumanMessage("start"),
        makeAIWithToolCalls("calling", "unanswered-call"),
        // No ToolMessage for 'unanswered-call'
        new AIMessage("moving on"),
      ];

      const result = await compressToLevel(msgs, 1, null, mockModel);

      const toolMsgs = result.messages.filter((m) => m._getType() === "tool");
      expect(toolMsgs.length).toBe(1);
      const stub = toolMsgs[0] as ToolMessage;
      expect(stub.tool_call_id).toBe("unanswered-call");
      expect(
        typeof stub.content === "string" && stub.content.includes("unavailable")
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Level 2 — trim verbose AI responses
  // -------------------------------------------------------------------------

  describe("level 2 — trim verbose AI responses", () => {
    it("trims AI messages longer than 500 chars (default)", async () => {
      const longContent = "A".repeat(800);
      const msgs: BaseMessage[] = [
        new HumanMessage("question"),
        new AIMessage(longContent),
      ];

      const result = await compressToLevel(msgs, 2, null, mockModel);

      expect(result.level).toBe(2);
      const aiMsg = result.messages.find((m) => m._getType() === "ai")!;
      const content = typeof aiMsg.content === "string" ? aiMsg.content : "";
      expect(content.length).toBeLessThan(longContent.length);
      expect(content).toContain("...[trimmed]...");
    });

    it("preserves short AI messages unchanged", async () => {
      const shortContent = "Short reply";
      const msgs: BaseMessage[] = [
        new HumanMessage("question"),
        new AIMessage(shortContent),
      ];

      const result = await compressToLevel(msgs, 2, null, mockModel);

      const aiMsg = result.messages.find((m) => m._getType() === "ai")!;
      expect(aiMsg.content).toBe(shortContent);
    });

    it("preserves AI messages with tool_calls even if long", async () => {
      const longContent = "X".repeat(800);
      const msgs: BaseMessage[] = [
        new HumanMessage("do something"),
        new AIMessage({
          content: longContent,
          tool_calls: [{ id: "tc-1", name: "my_tool", args: { a: 1 } }],
        }),
        makeToolMessage("tc-1", "result"),
      ];

      const result = await compressToLevel(msgs, 2, null, mockModel);

      const aiMsg = result.messages.find((m) => m._getType() === "ai")!;
      const content = typeof aiMsg.content === "string" ? aiMsg.content : "";
      // Should NOT be trimmed because it has tool_calls
      expect(content).toBe(longContent);
    });

    it("uses head+tail trimming", async () => {
      // Default: head=300 (min(300, 500*0.75=375)), tail=100 (min(100, 500-300=200))
      const content = "H".repeat(300) + "M".repeat(400) + "T".repeat(200);
      const msgs: BaseMessage[] = [
        new HumanMessage("q"),
        new AIMessage(content),
      ];

      const result = await compressToLevel(msgs, 2, null, mockModel);

      const aiMsg = result.messages.find((m) => m._getType() === "ai")!;
      const trimmed = typeof aiMsg.content === "string" ? aiMsg.content : "";
      // Starts with head portion
      expect(trimmed.startsWith("H".repeat(300))).toBe(true);
      // Contains trimmed marker
      expect(trimmed).toContain("...[trimmed]...");
      // Ends with tail portion from original
      expect(trimmed.endsWith("T".repeat(100))).toBe(true);
    });

    it("respects custom aiResponseMaxChars", async () => {
      const msgs: BaseMessage[] = [
        new HumanMessage("q"),
        new AIMessage("A".repeat(300)),
      ];

      // With maxChars=200, the 300-char message should be trimmed
      const result = await compressToLevel(msgs, 2, null, mockModel, {
        aiResponseMaxChars: 200,
      });

      const aiMsg = result.messages.find((m) => m._getType() === "ai")!;
      const content = typeof aiMsg.content === "string" ? aiMsg.content : "";
      expect(content).toContain("...[trimmed]...");
    });
  });

  // -------------------------------------------------------------------------
  // Level 3 — structured summarization
  // -------------------------------------------------------------------------

  describe("level 3 — structured summarization", () => {
    it("calls summarizeAndTrim via the model", async () => {
      const summaryText = "## Goal\nTest goal\n## Progress\nDone stuff";
      const model = createMockModel(summaryText);

      // Need enough messages so summarizeAndTrim actually summarizes (> keepRecentLevel3=10)
      const msgs = makeConversation(8); // 16 messages
      const result = await compressToLevel(msgs, 3, null, model);

      expect(result.level).toBe(3);
      expect(result.summary).toBe(summaryText);
      expect(model.invoke as ReturnType<typeof vi.fn>).toHaveBeenCalled();
      // Should have fewer messages than the original
      expect(result.messages.length).toBeLessThanOrEqual(10);
    });

    it("gracefully handles LLM failure without crashing", async () => {
      const model = createFailingModel("LLM is down");
      const msgs = makeConversation(8);

      const result = await compressToLevel(msgs, 3, null, model);

      // A failed summary cannot cover discarded messages, so level 3 must
      // genuinely fall back to the non-destructive level-2 result.
      expect(result.level).toBe(2);
      expect(result.summary).toBeNull();
      expect(result.messages).toHaveLength(msgs.length);
      expect(result.degradations?.[0]?.adoptionSafe).toBe(false);
    });

    it("preserves existing summary on LLM failure", async () => {
      const model = createFailingModel("timeout");
      const msgs = makeConversation(8);

      const result = await compressToLevel(msgs, 3, "old summary", model);

      expect(result.level).toBe(2);
      expect(result.summary).toBe("old summary");
      expect(result.degradedFrom?.requested).toBe(3);
    });

    it("calls onBeforeSummarize hook before summarization", async () => {
      const hook = vi.fn();
      const model = createMockModel("summary");
      const msgs = makeConversation(8); // 16 msgs, keepRecentLevel3=10 => 6 old

      await compressToLevel(msgs, 3, null, model, { onBeforeSummarize: hook });

      expect(hook).toHaveBeenCalledTimes(1);
      // Hook receives the old messages (those being summarized)
      const oldMsgs = hook.mock.calls[0]![0] as BaseMessage[];
      expect(oldMsgs.length).toBeGreaterThan(0);
    });

    it("does not call onBeforeSummarize if messages <= keepRecentLevel3", async () => {
      const hook = vi.fn();
      const model = createMockModel("summary");
      const msgs = makeConversation(3); // 6 messages, keepRecentLevel3=10

      await compressToLevel(msgs, 3, null, model, { onBeforeSummarize: hook });

      // 6 messages <= 10, so no old messages to summarize, hook not called
      expect(hook).not.toHaveBeenCalled();
    });

    it("continues compression even if onBeforeSummarize hook throws", async () => {
      const hook = vi.fn().mockRejectedValue(new Error("hook failed"));
      const model = createMockModel("summary after hook error");
      const msgs = makeConversation(8);

      const result = await compressToLevel(msgs, 3, null, model, {
        onBeforeSummarize: hook,
      });

      // Should still succeed
      expect(result.level).toBe(3);
      expect(result.summary).toBe("summary after hook error");
    });
  });

  // -------------------------------------------------------------------------
  // Level 4 — ultra-compressed
  // -------------------------------------------------------------------------

  describe("level 4 — ultra-compressed", () => {
    it("keeps only the last 3 messages by default", async () => {
      const msgs = makeConversation(10); // 20 messages

      const result = await compressToLevel(msgs, 4, null, mockModel);

      expect(result.level).toBe(4);
      // Default keepRecentLevel4=3
      // repairOrphanedToolPairs may add stubs, but base count should be ~3
      expect(result.messages.length).toBeLessThanOrEqual(5); // some tolerance for repair
    });

    it("truncates long existing summaries to 500 chars", async () => {
      const longSummary = "S".repeat(800);
      const msgs = makeConversation(5);

      const result = await compressToLevel(msgs, 4, longSummary, mockModel);

      expect(result.summary).not.toBeNull();
      expect(result.summary!.length).toBeLessThanOrEqual(520); // 500 + "...[truncated]" (14)
      expect(result.summary!).toContain("...[truncated]");
    });

    it("preserves short existing summaries as-is", async () => {
      const shortSummary = "Brief summary";
      const msgs = makeConversation(5);

      const result = await compressToLevel(msgs, 4, shortSummary, mockModel);

      expect(result.summary).toBe(shortSummary);
    });

    it("calls onBeforeSummarize hook at level 4", async () => {
      const hook = vi.fn();
      const msgs = makeConversation(5); // 10 messages, keepRecentLevel4=3 => 7 old

      await compressToLevel(msgs, 4, null, mockModel, {
        onBeforeSummarize: hook,
      });

      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("respects custom keepRecentLevel4", async () => {
      const msgs = makeConversation(10); // 20 messages

      const result = await compressToLevel(msgs, 4, null, mockModel, {
        keepRecentLevel4: 6,
      });

      // Should keep about 6 messages (may have a few more from repair)
      expect(result.messages.length).toBeGreaterThanOrEqual(6);
      expect(result.messages.length).toBeLessThanOrEqual(10);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-level properties
  // -------------------------------------------------------------------------

  describe("cross-level properties", () => {
    it("estimatedTokens decreases or stays equal with higher levels", async () => {
      const msgs = makeConversation(10); // 20 messages
      const model = createMockModel("## Goal\nShort summary");

      const results: Record<CompressionLevel, number> = {
        0: 0,
        1: 0,
        2: 0,
        3: 0,
        4: 0,
      };

      for (const level of [0, 1, 2, 3, 4] as CompressionLevel[]) {
        const result = await compressToLevel(msgs, level, null, model);
        results[level] = result.estimatedTokens;
      }

      // Each level's tokens should be <= the previous level's
      expect(results[1]).toBeLessThanOrEqual(results[0]);
      expect(results[2]).toBeLessThanOrEqual(results[1]);
      expect(results[3]).toBeLessThanOrEqual(results[2]);
      expect(results[4]).toBeLessThanOrEqual(results[3]);
    });

    it("ratio increases with higher levels", async () => {
      // Build messages with long AI responses so compression is effective
      const msgs: BaseMessage[] = [];
      for (let i = 0; i < 15; i++) {
        msgs.push(new HumanMessage(`Question ${i}`));
        msgs.push(new AIMessage("A".repeat(600)));
      }
      const model = createMockModel("Short summary");

      const results: Record<CompressionLevel, number> = {
        0: 0,
        1: 0,
        2: 0,
        3: 0,
        4: 0,
      };

      for (const level of [0, 1, 2, 3, 4] as CompressionLevel[]) {
        const result = await compressToLevel(msgs, level, null, model);
        results[level] = result.ratio;
      }

      // Ratio should generally increase (0 = no compression, 1 = maximum)
      expect(results[0]).toBe(0);
      expect(results[2]).toBeGreaterThanOrEqual(results[1]);
      expect(results[4]).toBeGreaterThan(results[2]);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty messages at level 0", async () => {
      const result = await compressToLevel([], 0, null, mockModel);

      expect(result.level).toBe(0);
      expect(result.messages).toEqual([]);
      expect(result.estimatedTokens).toBe(0);
      expect(result.ratio).toBe(0);
    });

    it("handles empty messages at all levels", async () => {
      for (const level of [0, 1, 2, 3, 4] as CompressionLevel[]) {
        const result = await compressToLevel([], level, null, mockModel);
        expect(result.messages.length).toBe(0);
      }
    });

    it("handles single message", async () => {
      const msgs = [new HumanMessage("only one")];
      const result = await compressToLevel(msgs, 2, null, mockModel);

      expect(result.messages.length).toBe(1);
    });

    it("ratio is clamped between 0 and 1", async () => {
      const msgs = makeConversation(5);
      for (const level of [0, 1, 2, 3, 4] as CompressionLevel[]) {
        const result = await compressToLevel(msgs, level, null, mockModel);
        expect(result.ratio).toBeGreaterThanOrEqual(0);
        expect(result.ratio).toBeLessThanOrEqual(1);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// compressToBudget
// ---------------------------------------------------------------------------

describe("compressToBudget", () => {
  let mockModel: BaseChatModel;

  beforeEach(() => {
    mockModel = createMockModel("Budget summary");
  });

  it("auto-selects level and compresses", async () => {
    // 800 chars / 4 = 200 tokens, budget = 130 => should pick level 2.
    // Level 2 trims the verbose AI response enough to stay within budget.
    const msgs = [new AIMessage("A".repeat(800))];

    const result = await compressToBudget(msgs, 130, null, mockModel);

    expect(result.level).toBe(2);
    expect(result.estimatedTokens).toBeLessThanOrEqual(130);
  });

  it("returns level 0 when messages are within budget", async () => {
    const msgs = [new HumanMessage("tiny")];

    const result = await compressToBudget(msgs, 10000, null, mockModel);

    expect(result.level).toBe(0);
  });

  it("uses the highest level when budget is very tight", async () => {
    const msgs = makeConversation(20);

    const result = await compressToBudget(msgs, 1, null, mockModel);

    expect(result.level).toBe(4);
  });

  it("escalates when the selected heuristic level still exceeds budget", async () => {
    // Human content is not affected by level-2 AI trimming, so the initial
    // level-2 heuristic would remain over budget without escalation.
    const msgs = [makeHumanMessage(400)];

    const result = await compressToBudget(msgs, 55, null, mockModel);

    expect(result.level).toBe(4);
    expect(result.estimatedTokens).toBeLessThanOrEqual(55);
    expect(typeof result.messages[0]?.content).toBe("string");
    expect((result.messages[0]?.content as string).length).toBeLessThanOrEqual(
      55 * 4
    );
  });

  it("returns an empty message set for non-positive budgets", async () => {
    const msgs = [makeHumanMessage(100)];

    const result = await compressToBudget(
      msgs,
      0,
      "existing summary",
      mockModel
    );

    expect(result.level).toBe(4);
    expect(result.messages).toEqual([]);
    expect(result.summary).toBe("existing summary");
    expect(result.estimatedTokens).toBe(0);
  });

  it("passes config through to compressToLevel", async () => {
    const hook = vi.fn();
    const msgs = makeConversation(8); // enough messages for summarization

    // Budget tight enough to trigger level 3 or 4
    await compressToBudget(msgs, 5, null, mockModel, {
      onBeforeSummarize: hook,
    });

    // Hook should have been called at level 3 or 4
    expect(hook).toHaveBeenCalled();
  });

  it("respects custom charsPerToken", async () => {
    // 100 chars / 2 charsPerToken = 50 tokens, budget = 40
    // The custom ratio drives the budget estimate and hard-trim size.
    const msgs = [makeHumanMessage(100)];

    const result = await compressToBudget(msgs, 40, null, mockModel, {
      charsPerToken: 2,
    });

    expect(result.level).toBe(4);
    expect(result.estimatedTokens).toBeLessThanOrEqual(40);
    expect((result.messages[0]?.content as string).length).toBeLessThanOrEqual(
      80
    );
  });
});

// ---------------------------------------------------------------------------
// A summarizer outage must not look like a successful compaction
// ---------------------------------------------------------------------------

describe("compressToLevel — summarizer failure is reported", () => {
  it("flags degradedFrom when the summarizer fails at level 3", async () => {
    const model = createFailingModel("summarizer offline");
    const result = await compressToLevel(makeConversation(20), 3, null, model);

    expect(result.level).toBe(2);
    expect(result.degradedFrom?.requested).toBe(3);
    expect(result.degradedFrom?.reason).toContain("summarizer offline");
    expect(result.degradations?.[0]?.stage).toBe("summary-invocation");
  });

  it("preserves the existing summary and still flags the failure", async () => {
    const model = createFailingModel("LLM is down");
    const result = await compressToLevel(
      makeConversation(20),
      3,
      "old summary",
      model
    );

    expect(result.summary).toBe("old summary");
    expect(result.degradedFrom).toBeDefined();
    expect(result.level).toBe(2);
  });

  it("leaves degradedFrom unset when summarization succeeds", async () => {
    const model = createMockModel("a fresh summary");
    const result = await compressToLevel(makeConversation(20), 3, null, model);

    expect(result.level).toBe(3);
    expect(result.degradedFrom).toBeUndefined();
  });

  it("leaves degradedFrom unset for a level the model is not consulted for", async () => {
    const model = createFailingModel("should never be called");
    const result = await compressToLevel(makeConversation(20), 2, null, model);

    expect(result.level).toBe(2);
    expect(result.degradedFrom).toBeUndefined();
  });
});

describe("progressive compression token provenance", () => {
  it("labels the legacy chars-per-token path as heuristic", async () => {
    const result = await compressToLevel(
      [new HumanMessage("abcdefgh")],
      0,
      null,
      createMockModel("unused")
    );

    expect(result.tokenMeasurement).toMatchObject({
      tokens: 2,
      method: "heuristic",
    });
  });

  it("propagates tokenizer-backed measurements through budget trimming", async () => {
    const tokenCounter = {
      count: (text: string) => Math.ceil(text.length / 2),
      countDetailed: (text: string) => ({
        tokens: Math.ceil(text.length / 2),
        method: "exact" as const,
        model: "test-model",
      }),
    };
    const result = await compressToBudget(
      [makeHumanMessage(100)],
      20,
      null,
      createMockModel("unused"),
      { tokenCounter, model: "test-model" }
    );

    expect(result.estimatedTokens).toBeLessThanOrEqual(20);
    expect(result.tokenMeasurement).toMatchObject({
      method: "exact",
      model: "test-model",
    });
  });
});

describe("compressToHardBudget", () => {
  it("rejects heuristic provenance without changing the transcript", async () => {
    const messages = [makeHumanMessage(100)];
    const model = createMockModel("unused");

    const result = await compressToHardBudget(messages, 20, null, model);

    expect(result.messages).toBe(messages);
    expect(result.hardBudget).toMatchObject({
      limit: 20,
      satisfied: false,
      adoptionSafe: false,
      markerIncluded: false,
    });
    expect(result.degradations).toEqual([
      expect.objectContaining({
        stage: "token-measurement",
        adoptionSafe: false,
      }),
    ]);
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it("accepts tokenizer-backed output already inside the ceiling", async () => {
    const messages = [new HumanMessage("small")];
    const result = await compressToHardBudget(
      messages,
      10,
      null,
      createMockModel("unused"),
      { tokenCounter: exactCharacterCounter }
    );

    expect(result.messages).toBe(messages);
    expect(result.tokenMeasurement.method).toBe("exact");
    expect(result.hardBudget).toEqual({
      limit: 10,
      satisfied: true,
      adoptionSafe: true,
      truncated: false,
      markerIncluded: false,
    });
  });

  it("treats an empty payload as exactly zero without requiring a tokenizer", async () => {
    const result = await compressToHardBudget(
      [],
      0,
      null,
      createMockModel("unused")
    );

    expect(result.tokenMeasurement).toMatchObject({
      tokens: 0,
      method: "exact",
    });
    expect(result.hardBudget.satisfied).toBe(true);
  });

  it("reserves the full marker before destructive hard trimming", async () => {
    const result = await compressToHardBudget(
      [makeHumanMessage(200)],
      60,
      null,
      createMockModel("unused"),
      { tokenCounter: exactCharacterCounter }
    );

    expect(result.estimatedTokens).toBeLessThanOrEqual(60);
    expect(result.hardBudget).toMatchObject({
      satisfied: true,
      adoptionSafe: true,
      truncated: true,
      markerIncluded: true,
    });
    expect(result.messages[0]?._getType()).toBe("system");
    expect(result.messages[0]?.content).toContain(
      "truncated to fit context budget"
    );
  });

  it("fails closed when a tiny budget cannot reserve the marker", async () => {
    const messages = [makeHumanMessage(200)];
    const result = await compressToHardBudget(
      messages,
      1,
      null,
      createMockModel("unused"),
      { tokenCounter: exactCharacterCounter }
    );

    expect(result.messages).toBe(messages);
    expect(result.hardBudget).toMatchObject({
      satisfied: false,
      adoptionSafe: false,
      truncated: false,
      markerIncluded: false,
    });
    expect(result.degradations?.[0]).toMatchObject({
      stage: "hard-budget-marker",
      adoptionSafe: false,
    });
  });

  it("does not bypass an adoption-unsafe summarizer failure", async () => {
    const messages = makeConversation(20);
    const result = await compressToHardBudget(
      messages,
      125,
      null,
      createFailingModel("summarizer unavailable"),
      { tokenCounter: exactCharacterCounter }
    );

    expect(result.messages).toBe(messages);
    expect(result.hardBudget.adoptionSafe).toBe(false);
    expect(result.degradations?.[0]).toMatchObject({
      stage: "summary-invocation",
      adoptionSafe: false,
    });
  });

  it("skips model summarization when a runtime gate disables hidden calls", async () => {
    const model = createMockModel("must not be used");
    const result = await compressToHardBudget(
      makeConversation(20),
      125,
      null,
      model,
      {
        tokenCounter: exactCharacterCounter,
        allowModelSummarization: false,
      }
    );

    expect(model.invoke).not.toHaveBeenCalled();
    expect(result.hardBudget).toMatchObject({
      satisfied: true,
      adoptionSafe: true,
    });
  });

  it("accepts encoding-fallback provenance and rejects invalid limits", async () => {
    const fallbackCounter = {
      count: exactCharacterCounter.count,
      countDetailed: (text: string) => ({
        tokens: text.length,
        method: "encoding-fallback" as const,
        encoding: "fallback-test",
      }),
    };
    const result = await compressToHardBudget(
      [new HumanMessage("ok")],
      2,
      null,
      createMockModel("unused"),
      { tokenCounter: fallbackCounter }
    );

    expect(result.hardBudget.satisfied).toBe(true);
    expect(result.tokenMeasurement.method).toBe("encoding-fallback");
    await expect(
      compressToHardBudget([], -1, null, createMockModel("unused"), {
        tokenCounter: exactCharacterCounter,
      })
    ).rejects.toThrow(RangeError);
  });

  // -------------------------------------------------------------------------
  // Additional branch coverage (DZUPAGENT-TEST-C-15 floor work): the tests
  // above prove the module's headline behaviors (heuristic rejection, budget
  // fit, marker reservation, unsafe-degradation short-circuit) but leave
  // several defensive branches unexercised — each one guards against a
  // measurement provenance regression silently downgrading a "hard" budget
  // guarantee to a heuristic one without the caller finding out.
  // -------------------------------------------------------------------------

  it("serializes non-string message content before measuring it", async () => {
    // getContent()'s `JSON.stringify` branch only fires for non-string
    // content (e.g. a multimodal content-block array). A regression that
    // always took the string branch would crash (or silently mis-measure)
    // on any message shaped like this.
    const structuredMessage = new HumanMessage({
      content: [{ type: "text", text: "hello" }] as unknown as string,
    });
    const result = await compressToHardBudget(
      [structuredMessage],
      1000,
      null,
      createMockModel("unused"),
      { tokenCounter: exactCharacterCounter }
    );
    expect(result.hardBudget.satisfied).toBe(true);
    // The measured length must reflect the stringified JSON, not "[object Object]"
    // or a thrown error — proves JSON.stringify actually ran on the content.
    expect(result.tokenMeasurement.tokens).toBe(
      JSON.stringify([{ type: "text", text: "hello" }]).length
    );
  });

  it("fails closed when the truncation-marker measurement itself is heuristic", async () => {
    // A tokenCounter that is exact for ordinary content but reports itself
    // as heuristic specifically for the truncation marker text simulates a
    // tokenizer that can't score a system message reliably. Without this
    // branch, a caller could silently adopt a "hard" budget result whose
    // truncation marker was never actually measured.
    const markerBlindCounter = {
      count: (text: string) => text.length,
      countDetailed: (text: string) =>
        text.includes("truncated to fit context budget")
          ? {
              tokens: Math.ceil(text.length / 4),
              method: "heuristic" as const,
              reason: "marker text cannot be tokenized exactly",
            }
          : {
              tokens: text.length,
              method: "exact" as const,
              model: "exact-character-counter",
            },
    };
    const messages = [makeHumanMessage(500)];
    const result = await compressToHardBudget(
      messages,
      50,
      null,
      createMockModel("unused"),
      { tokenCounter: markerBlindCounter }
    );

    expect(result.messages).toBe(messages);
    expect(result.hardBudget).toMatchObject({
      satisfied: false,
      adoptionSafe: false,
      truncated: false,
      markerIncluded: false,
    });
    expect(result.degradations?.[0]).toMatchObject({
      stage: "token-measurement",
      reason: "marker text cannot be tokenized exactly",
      adoptionSafe: false,
    });
  });

  it("fails closed when a mid-loop hard-trim candidate measurement turns heuristic", async () => {
    // Exact for the marker alone (short text, so the hard-budget-marker gate
    // passes) and exact for plain retained-message content on its own, but
    // heuristic once the *candidate* text combines the marker with any
    // retained message — modeling a tokenizer that can't score the combined
    // multi-message payload the while loop builds, distinct from "no
    // tokenizer at all" (which fails earlier, before the loop is reached).
    const combinedBlindCounter = {
      count: (text: string) => text.length,
      countDetailed: (text: string) => {
        const hasMarker = text.includes("truncated to fit context budget");
        const hasRetained = text.includes("RETAINED-MESSAGE-MARKER");
        if (hasMarker && hasRetained) {
          return {
            tokens: Math.ceil(text.length / 4),
            method: "heuristic" as const,
            reason: "combined candidate measurement degraded to heuristic",
          };
        }
        return {
          tokens: text.length,
          method: "exact" as const,
          model: "exact-character-counter",
        };
      },
    };
    const messages = [
      new HumanMessage("RETAINED-MESSAGE-MARKER " + "x".repeat(400)),
    ];
    const result = await compressToHardBudget(
      messages,
      50,
      null,
      createMockModel("unused"),
      { tokenCounter: combinedBlindCounter }
    );

    expect(result.messages).toBe(messages);
    expect(result.hardBudget.adoptionSafe).toBe(false);
    expect(result.degradations?.[0]).toMatchObject({
      stage: "token-measurement",
      reason: "combined candidate measurement degraded to heuristic",
      adoptionSafe: false,
    });
  });

  it("retains a partial tail of messages when only the oldest ones must be dropped to fit the marker", async () => {
    // Two messages: dropping just the older (first) one lets the marker +
    // the newer message fit the budget, so the while loop's mid-iteration
    // success return (candidate fits after one `retained.slice(1)`) fires —
    // distinct from both "everything fits on the first try" (already
    // covered) and "nothing fits, fall through to marker-only" (also
    // already covered).
    // The marker itself is 41 chars, so a budget of 65 clears the
    // hard-budget-marker gate (marker alone fits) but marker + older
    // (100 chars) does not, while marker + newer (20 chars) does.
    const older = new HumanMessage("o".repeat(100));
    const newer = new HumanMessage("n".repeat(20));
    const result = await compressToHardBudget(
      [older, newer],
      65,
      null,
      createMockModel("unused"),
      { tokenCounter: exactCharacterCounter }
    );

    expect(result.hardBudget).toMatchObject({
      satisfied: true,
      adoptionSafe: true,
      truncated: true,
      markerIncluded: true,
    });
    // The older message must be gone and the newer one retained alongside
    // the marker — proves the loop dropped from the front, not the back.
    const contents = result.messages.map((m) =>
      typeof m.content === "string" ? m.content : ""
    );
    expect(contents.some((c) => c.includes("o".repeat(100)))).toBe(false);
    expect(contents.some((c) => c.includes("n".repeat(20)))).toBe(true);
  });

  it("escalates past a skipped level 3 to level 4 and returns from inside the escalation loop", async () => {
    // Long human messages barely shrink under level 1 (tool pruning) or
    // level 2 (AI-response trimming, which never touches human content), so
    // selectCompressionLevel's cheap ratio heuristic under-predicts the
    // level actually needed. With allowModelSummarization: false, level 3
    // is skipped (continue) inside the escalation for-loop, and level 4
    // (destructive trim) is the one that finally satisfies the budget and
    // returns from within that loop — a different code path than the
    // "gate disables the initial level-3 selection" case already covered
    // above.
    // 10 human/AI pairs (20 messages) of ~50 chars each, total ~1000 chars.
    // exactCharacterCounter measures 1 token/char: 1000 > 550 (not level 0),
    // 700 > 550 (not level 1), 500 <= 550 (level 2 selected). Every AI
    // message is under the 500-char default `aiResponseMaxChars`, so level
    // 2's trim is a no-op and the post-compression size is still ~1000 —
    // over the 550 budget, forcing escalation through the level-3-skipped
    // branch to level 4. Level 4 keeps only the last `keepRecentLevel4`
    // (default 3) messages, which is ~150 tokens here — comfortably under
    // 550 without needing the destructive hard-trim-with-marker fallback,
    // so the escalation loop's own `result.estimatedTokens <= tokenBudget`
    // check (not the post-loop hard-trim) is what satisfies the budget.
    const messages: BaseMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(new HumanMessage(`question number ${i} `.padEnd(50, "q")));
      messages.push(new AIMessage(`answer number ${i} `.padEnd(50, "a")));
    }
    const model = createMockModel("must not be used");
    const result = await compressToHardBudget(messages, 550, null, model, {
      tokenCounter: exactCharacterCounter,
      allowModelSummarization: false,
    });

    expect(model.invoke).not.toHaveBeenCalled();
    expect(result.level).toBe(4);
    expect(result.hardBudget).toMatchObject({
      satisfied: true,
      adoptionSafe: true,
      truncated: false,
      markerIncluded: false,
    });
  });

  it("fails closed when the compressed (pre-hard-trim) output measurement turns heuristic", async () => {
    // Exact for the original transcript and the truncation marker, but
    // heuristic specifically for content containing the level-2 "[trimmed]"
    // marker — i.e. the tokenizer can score raw input but not the module's
    // own compressed output. This is the `!isHardBudgetMeasurement(compressed.tokenMeasurement)`
    // branch, reached only after compression succeeds without an
    // adoption-unsafe degradation.
    const trimBlindCounter = {
      count: (text: string) => text.length,
      countDetailed: (text: string) =>
        text.includes("[trimmed]")
          ? {
              tokens: Math.ceil(text.length / 4),
              method: "heuristic" as const,
              reason: "compressed output cannot be tokenized exactly",
            }
          : {
              tokens: text.length,
              method: "exact" as const,
              model: "exact-character-counter",
            },
    };
    const messages = [new AIMessage("a".repeat(2000))];
    const result = await compressToHardBudget(
      messages,
      100,
      null,
      createMockModel("unused"),
      { tokenCounter: trimBlindCounter }
    );

    expect(result.messages).toBe(messages);
    expect(result.hardBudget).toMatchObject({
      satisfied: false,
      adoptionSafe: false,
    });
    expect(result.degradations?.[0]).toMatchObject({
      stage: "token-measurement",
      reason: "compressed output cannot be tokenized exactly",
      adoptionSafe: false,
    });
  });

  it("falls back to a default reason when a heuristic compressed-output measurement omits one", async () => {
    // Same heuristic-after-compression scenario as above, but the
    // TokenMeasurementResult itself carries no `reason` field — exercises
    // the `compressed.tokenMeasurement.reason ?? 'compressed output
    // measurement is heuristic'` default rather than a supplied reason.
    const trimBlindCounterNoReason = {
      count: (text: string) => text.length,
      countDetailed: (text: string) =>
        text.includes("[trimmed]")
          ? { tokens: Math.ceil(text.length / 4), method: "heuristic" as const }
          : {
              tokens: text.length,
              method: "exact" as const,
              model: "exact-character-counter",
            },
    };
    const messages = [new AIMessage("a".repeat(2000))];
    const result = await compressToHardBudget(
      messages,
      100,
      null,
      createMockModel("unused"),
      { tokenCounter: trimBlindCounterNoReason }
    );

    expect(result.degradations?.[0]).toMatchObject({
      stage: "token-measurement",
      reason: "compressed output measurement is heuristic",
      adoptionSafe: false,
    });
  });
});
