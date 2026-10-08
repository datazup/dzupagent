import { describe, it, expect, vi } from "vitest";
import type * as NodeModule from "node:module";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { estimateTokensByChars, measureTokenText } from "../token-lifecycle.js";
import { CharEstimateCounter } from "../char-estimate-counter.js";
import { TiktokenCounter, __internals } from "../tiktoken-counter.js";
import { autoCompress } from "../auto-compress.js";

/**
 * DZC-P2a: every chars-per-token fallback in this package must route through
 * one helper and agree on the count. The optional tokenizer backends are
 * forced absent (via `node:module`, as in tiktoken-counter-degradation) so
 * TiktokenCounter takes its heuristic path.
 */

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeModule>();
  return {
    ...actual,
    createRequire: () => (id: string) => {
      throw new Error(`Cannot find module '${id}'`);
    },
  };
});

const INPUTS = ["", "a", "abc", "abcd", "abcde", "x".repeat(7), "x".repeat(9), "😀", "😀😀a"];

describe("estimateTokensByChars", () => {
  it("is ceil(length / charsPerToken) on UTF-16 length with a default of 4", () => {
    for (const text of INPUTS) {
      expect(estimateTokensByChars(text)).toBe(Math.ceil(text.length / 4));
    }
    expect(estimateTokensByChars("x".repeat(7), 3)).toBe(3);
    expect(estimateTokensByChars("x".repeat(6), 3)).toBe(2);
  });
});

describe("chars-per-token parity across fallback sites", () => {
  it("measureTokenText, CharEstimateCounter and TiktokenCounter (no backend) agree with the helper", () => {
    __internals.resetCache();
    const tiktoken = new TiktokenCounter();
    const chars = new CharEstimateCounter();
    for (const text of INPUTS) {
      const expected = estimateTokensByChars(text);
      expect(measureTokenText(text).tokens).toBe(expected);
      expect(chars.countDetailed(text).tokens).toBe(expected);
      expect(tiktoken.countDetailed(text, "gpt-4o").tokens).toBe(expected);
    }
  });

  it("measureTokenText honours a configured charsPerToken through the helper", () => {
    for (const text of INPUTS) {
      expect(measureTokenText(text, undefined, undefined, 3).tokens).toBe(
        estimateTokensByChars(text, 3),
      );
    }
  });

  it("autoCompress no-tokenizer measurement matches the helper on the serialized messages", async () => {
    const messages: BaseMessage[] = [new HumanMessage("hello 😀 world"), new HumanMessage("x".repeat(9))];
    const model = { invoke: vi.fn() } as unknown as BaseChatModel;
    const result = await autoCompress(messages, null, model, { budget: 1_000_000 });
    expect(result.tokenMeasurement).toMatchObject({
      tokens: estimateTokensByChars(JSON.stringify(messages)),
      method: "heuristic",
      reason: "no tokenizer configured; used chars-per-token estimate",
    });
  });
});
