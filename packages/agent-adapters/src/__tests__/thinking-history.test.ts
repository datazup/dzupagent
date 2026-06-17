import { describe, expect, it } from "vitest";

import { stripThinkingBlocks } from "../prompts/thinking-history.js";

describe("stripThinkingBlocks", () => {
  it("removes a single <think> block and trims surrounding whitespace", () => {
    const input =
      "<think>I should weigh the options.</think>\n\nThe answer is 42.";
    expect(stripThinkingBlocks(input)).toBe("The answer is 42.");
  });

  it("removes multiple <think> blocks", () => {
    const input = "<think>first</think>A<think>second</think>B";
    expect(stripThinkingBlocks(input)).toBe("AB");
  });

  it("removes a multi-line <think> block", () => {
    const input = "<think>\nline one\nline two\n</think>\nFinal output.";
    expect(stripThinkingBlocks(input)).toBe("Final output.");
  });

  it("drops an unterminated <think> block to end of string", () => {
    const input = "Visible.\n<think>still reasoning and never closed";
    expect(stripThinkingBlocks(input)).toBe("Visible.");
  });

  it("leaves text without think blocks unchanged", () => {
    expect(stripThinkingBlocks("Just the answer.")).toBe("Just the answer.");
  });

  it("returns an empty string when the whole message is a think block", () => {
    expect(stripThinkingBlocks("<think>only reasoning</think>")).toBe("");
  });

  it("is case-insensitive on the tag name", () => {
    expect(stripThinkingBlocks("<THINK>x</THINK>answer")).toBe("answer");
  });

  it("collapses the blank gap left between adjacent paragraphs", () => {
    const input = "Intro.\n\n<think>aside</think>\n\nConclusion.";
    expect(stripThinkingBlocks(input)).toBe("Intro.\n\nConclusion.");
  });
});
