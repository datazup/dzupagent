import { describe, it, expect, vi } from "vitest";
import {
  HumanMessage,
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { autoCompress } from "../auto-compress.js";
import type {
  AutoCompressConfig,
  AutoCompressTokenizer,
} from "../auto-compress.js";
import type { OffloadSink } from "../context-eviction.js";

/**
 * Targeted coverage for `measureMessageTokens` and a handful of
 * `autoCompress` defensive branches (DZUPAGENT-TEST-C-15 floor work) left
 * unexercised by the broader extended/offload suites: the empty-message
 * tokenizer-model branch, a countDetailed() that throws, a count-only
 * tokenizer (no countDetailed), a non-Error thrown from an offload sink, and
 * structured (non-string) message content flowing through the memoryFrame
 * text-extraction path. Each of these is a place where the module falls
 * back to a weaker guarantee (heuristic measurement, String(error), etc.) —
 * if the fallback branch is never taken in tests, a regression that breaks
 * it silently produces a thrown error or a wrong "exact" claim instead.
 */

function createMockModel(response: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
  } as unknown as BaseChatModel;
}

function makeConversation(pairs: number): BaseMessage[] {
  const msgs: BaseMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    msgs.push(new HumanMessage(`Question ${i}`));
    msgs.push(new AIMessage(`Answer ${i}`));
  }
  return msgs;
}

describe("autoCompress — measureMessageTokens on an empty message array", () => {
  it("includes the tokenizer's model field on the zero-token result when a tokenizer with a model is configured", async () => {
    const tokenizerWithModel: AutoCompressTokenizer = {
      model: "gpt-4o",
      countTokens: (text) => text.length,
      countDetailed: (text) => ({
        tokens: text.length,
        method: "exact",
        model: "gpt-4o",
      }),
    };
    const result = await autoCompress([], null, createMockModel("unused"), {
      budget: 100,
      tokenizer: tokenizerWithModel,
    });

    expect(result.compressed).toBe(false);
    expect(result.tokenMeasurement).toEqual({
      tokens: 0,
      method: "exact",
      model: "gpt-4o",
    });
  });

  it("omits the model field on the zero-token result when the tokenizer has no model", async () => {
    const tokenizerNoModel: AutoCompressTokenizer = {
      countTokens: (text) => text.length,
      countDetailed: (text) => ({ tokens: text.length, method: "exact" }),
    };
    const result = await autoCompress([], null, createMockModel("unused"), {
      budget: 100,
      tokenizer: tokenizerNoModel,
    });

    expect(result.tokenMeasurement).toEqual({ tokens: 0, method: "exact" });
  });
});

describe("autoCompress — measureMessageTokens tokenizer degradation paths", () => {
  it("falls back to countTokens() and reports 'detailed token measurement failed' when countDetailed throws", async () => {
    const throwingTokenizer: AutoCompressTokenizer = {
      model: "flaky-model",
      countTokens: () => 5,
      countDetailed: () => {
        throw new Error("tokenizer crashed");
      },
    };
    const result = await autoCompress(
      makeConversation(1),
      null,
      createMockModel("unused"),
      {
        budget: 100,
        tokenizer: throwingTokenizer,
      }
    );

    expect(result.compressed).toBe(false);
    expect(result.tokenMeasurement).toMatchObject({
      tokens: 5,
      method: "heuristic",
      model: "flaky-model",
      reason: "detailed token measurement failed",
    });
  });

  it("uses countTokens() directly and reports 'tokenizer does not expose measurement provenance' for a count-only tokenizer", async () => {
    const countOnlyTokenizer: AutoCompressTokenizer = {
      countTokens: () => 5,
    };
    const result = await autoCompress(
      makeConversation(1),
      null,
      createMockModel("unused"),
      {
        budget: 100,
        tokenizer: countOnlyTokenizer,
      }
    );

    expect(result.compressed).toBe(false);
    expect(result.tokenMeasurement).toMatchObject({
      tokens: 5,
      method: "heuristic",
      reason: "tokenizer does not expose measurement provenance",
    });
  });

  it("supplies a synthesized reason when the tokenizer-degradation measurement omits one entirely", async () => {
    // measureMessageTokens's own count-only-tokenizer branch always sets a
    // `reason`, so the only way to reach the `autoCompress`-level
    // `hardBudgetMeasurement.reason ?? 'heuristic token measurement'`
    // default is a tokenizer whose countDetailed() itself returns
    // `method: 'heuristic'` with no `reason` field at all (`??` only
    // triggers on null/undefined, not on falsy values like '').
    const noReasonTokenizer: AutoCompressTokenizer = {
      countTokens: () => 5,
      countDetailed: () => ({ tokens: 5, method: "heuristic" as const }),
    };
    const result = await autoCompress(
      makeConversation(1),
      null,
      createMockModel("unused"),
      {
        budget: 100,
        tokenizer: noReasonTokenizer,
      }
    );

    expect(result.degradations?.[0]?.reason).toBe(
      "heuristic token measurement"
    );
  });
});

describe("autoCompress — offload sink throwing a non-Error value", () => {
  it("stringifies a non-Error throw instead of reading .message off it", async () => {
    const model = createMockModel("## Goal\nSummarized content");
    const msgs = makeConversation(16);
    const stringThrowingSink: OffloadSink = {
      async write() {
        throw "disk quota exceeded"; // eslint-disable-line @typescript-eslint/only-throw-error
      },
      async append() {
        throw "disk quota exceeded"; // eslint-disable-line @typescript-eslint/only-throw-error
      },
    };

    const result = await autoCompress(msgs, null, model, {
      offload: { sink: stringThrowingSink },
    });

    expect(result.compressed).toBe(true);
    expect(result.fallbackReason).toContain("disk quota exceeded");
    expect(result.degradations?.[0]).toMatchObject({
      stage: "offload",
      reason: "offload-failed: disk quota exceeded",
    });
  });
});

describe("autoCompress — structured (non-string) message content in the memoryFrame path", () => {
  it("stringifies non-string content before comparing against the memory frame instead of throwing", async () => {
    const { tableFromArrays } = await import("apache-arrow");
    const table = tableFromArrays({ text: ["Question 0", "Answer 0"] });

    const model = createMockModel("summary with structured content");
    const msgs: BaseMessage[] = [
      new HumanMessage({
        content: [
          { type: "text", text: "structured question" },
        ] as unknown as string,
      }),
      ...makeConversation(15),
    ];

    const result = await autoCompress(msgs, null, model, {
      memoryFrame: table,
    });

    expect(result.compressed).toBe(true);
  });
});

describe("autoCompress — hard budget: fits without truncation and without an offload failure", () => {
  it("returns tokenMeasurement with neither fallbackReason nor degradations set", async () => {
    const model = createMockModel("short");
    const generousTokenizer: AutoCompressTokenizer = {
      model: "generous",
      countTokens: (text) => Math.ceil(text.length / 100),
      countDetailed: (text) => ({
        tokens: Math.ceil(text.length / 100),
        method: "exact" as const,
        model: "generous",
      }),
    };
    const config: AutoCompressConfig = {
      budget: 1_000_000,
      tokenizer: generousTokenizer,
    };
    const result = await autoCompress(
      makeConversation(16),
      null,
      model,
      config
    );

    expect(result.compressed).toBe(true);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.degradations).toBeUndefined();
    expect(result.tokenMeasurement?.method).toBe("exact");
  });
});
