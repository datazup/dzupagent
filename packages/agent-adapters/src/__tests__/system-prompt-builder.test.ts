import { describe, expect, it } from "vitest";

import {
  SystemPromptBuilder,
  type ClaudeAppendPayload,
  type CodexPromptPayload,
} from "../prompts/system-prompt-builder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBuilder(
  text = "Be concise.",
  opts?: ConstructorParameters<typeof SystemPromptBuilder>[1]
) {
  return new SystemPromptBuilder(text, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SystemPromptBuilder", () => {
  describe("constructor", () => {
    it("stores system prompt text", () => {
      const b = makeBuilder("Hello world");
      expect(b.rawText).toBe("Hello world");
    });

    it("throws when systemPrompt is empty string", () => {
      expect(() => new SystemPromptBuilder("")).toThrow("non-empty string");
    });

    it("throws when systemPrompt is only whitespace", () => {
      expect(() => new SystemPromptBuilder("   ")).toThrow("non-empty string");
    });
  });

  describe('buildFor("claude") — default append mode', () => {
    it("returns a preset append object", () => {
      const payload = makeBuilder().buildFor("claude") as ClaudeAppendPayload;
      expect(payload).toEqual({
        type: "preset",
        preset: "claude_code",
        append: "Be concise.",
      });
    });

    it("buildForClaude() returns same value", () => {
      const b = makeBuilder("Short answers.");
      expect(b.buildForClaude()).toEqual(b.buildFor("claude"));
    });

    it("explicit claudeMode append produces preset object", () => {
      const payload = makeBuilder("Test.", { claudeMode: "append" }).buildFor(
        "claude"
      ) as ClaudeAppendPayload;
      expect(payload.type).toBe("preset");
      expect(payload.preset).toBe("claude_code");
      expect(payload.append).toBe("Test.");
    });
  });

  describe('buildFor("claude") — replace mode', () => {
    it("returns raw string when claudeMode is replace", () => {
      const payload = makeBuilder("Custom system.", {
        claudeMode: "replace",
      }).buildFor("claude");
      expect(payload).toBe("Custom system.");
    });
  });

  describe('buildFor("codex")', () => {
    it("returns instructions-only object", () => {
      const payload = makeBuilder().buildFor("codex") as CodexPromptPayload;
      expect(payload).toEqual({ instructions: "Be concise." });
    });

    it("includes developer_instructions when option is set", () => {
      const payload = makeBuilder("User instructions.", {
        codexDeveloperInstructions: "Use JSON output.",
      }).buildFor("codex") as CodexPromptPayload;
      expect(payload.instructions).toBe("User instructions.");
      expect(payload.developer_instructions).toBe("Use JSON output.");
    });

    it("does not include developer_instructions when option is empty", () => {
      const payload = makeBuilder().buildFor("codex") as CodexPromptPayload;
      expect(payload.developer_instructions).toBeUndefined();
    });

    it('buildForCodex() returns same value as buildFor("codex")', () => {
      const b = makeBuilder("Prompt.");
      expect(b.buildForCodex()).toEqual(b.buildFor("codex"));
    });
  });

  describe("buildFor — generic providers (plain string)", () => {
    const PLAIN_STRING_PROVIDERS = [
      "gemini",
      "gemini-sdk",
      "qwen",
      "crush",
      "goose",
      "openrouter",
    ] as const;

    for (const provider of PLAIN_STRING_PROVIDERS) {
      it(`returns raw string for provider "${provider}"`, () => {
        const payload = makeBuilder("Short.").buildFor(provider);
        expect(payload).toBe("Short.");
      });
    }
  });

  describe('buildFor("qwen") — reasoning soft switch', () => {
    it('appends /no_think when qwenReasoning is "off"', () => {
      const payload = makeBuilder("Be concise.", {
        qwenReasoning: "off",
      }).buildFor("qwen");
      expect(payload).toBe("Be concise.\n\n/no_think");
    });

    it('appends /think when qwenReasoning is "on"', () => {
      const payload = makeBuilder("Be concise.", {
        qwenReasoning: "on",
      }).buildFor("qwen");
      expect(payload).toBe("Be concise.\n\n/think");
    });

    it("leaves the prompt unchanged when qwenReasoning is unset", () => {
      const payload = makeBuilder("Be concise.").buildFor("qwen");
      expect(payload).toBe("Be concise.");
    });

    it("does not apply the soft switch to non-qwen providers", () => {
      const payload = makeBuilder("Be concise.", {
        qwenReasoning: "off",
      }).buildFor("gemini");
      expect(payload).toBe("Be concise.");
    });
  });

  describe("rawText", () => {
    it("returns the original system prompt text", () => {
      expect(makeBuilder("Original text.").rawText).toBe("Original text.");
    });
  });

  // -------------------------------------------------------------------------
  // Phase 5.1 — normalized reasoning dimension (REQ-PREP-2)
  // -------------------------------------------------------------------------

  describe("normalized reasoning → qwen soft switch", () => {
    it('maps reasoning "low" to /no_think for qwen', () => {
      const payload = makeBuilder("Be concise.", { reasoning: "low" }).buildFor(
        "qwen"
      );
      expect(payload).toBe("Be concise.\n\n/no_think");
    });

    it('maps reasoning "high" to /think for qwen', () => {
      const payload = makeBuilder("Be concise.", {
        reasoning: "high",
      }).buildFor("qwen");
      expect(payload).toBe("Be concise.\n\n/think");
    });

    it('maps reasoning "medium" to /think for qwen', () => {
      const payload = makeBuilder("Be concise.", {
        reasoning: "medium",
      }).buildFor("qwen");
      expect(payload).toBe("Be concise.\n\n/think");
    });

    it("explicit qwenReasoning overrides the normalized reasoning mapping", () => {
      const payload = makeBuilder("Be concise.", {
        reasoning: "high",
        qwenReasoning: "off",
      }).buildFor("qwen");
      expect(payload).toBe("Be concise.\n\n/no_think");
    });
  });

  describe("normalized reasoning → gemini lean directive", () => {
    it('appends a silent-thinking directive on reasoning "low" (latency/lean)', () => {
      const payload = makeBuilder("Answer the question.", {
        reasoning: "low",
      }).buildFor("gemini");
      expect(payload).toBe(
        "Answer the question.\n\nThink silently; keep reasoning brief."
      );
    });

    it('does NOT pad gemini on reasoning "high" (let thinking work — §3.3)', () => {
      const payload = makeBuilder("Answer the question.", {
        reasoning: "high",
      }).buildFor("gemini");
      expect(payload).toBe("Answer the question.");
    });

    it('does NOT pad gemini on reasoning "medium"', () => {
      const payload = makeBuilder("Answer the question.", {
        reasoning: "medium",
      }).buildFor("gemini");
      expect(payload).toBe("Answer the question.");
    });

    it("leaves gemini unchanged when reasoning is unset", () => {
      const payload = makeBuilder("Answer the question.").buildFor("gemini");
      expect(payload).toBe("Answer the question.");
    });
  });

  describe("reasoning does not alter the claude/codex system payload", () => {
    it("claude append payload is unchanged by reasoning (effort is an API knob)", () => {
      const payload = makeBuilder("Be careful.", {
        reasoning: "high",
      }).buildFor("claude") as ClaudeAppendPayload;
      expect(payload).toEqual({
        type: "preset",
        preset: "claude_code",
        append: "Be careful.",
      });
    });

    it("codex instructions are unchanged by reasoning", () => {
      const payload = makeBuilder("Be careful.", { reasoning: "low" }).buildFor(
        "codex"
      ) as CodexPromptPayload;
      expect(payload).toEqual({ instructions: "Be careful." });
    });
  });

  describe("reasoningEffort(providerId) — normalized → provider effort value", () => {
    it("returns undefined when reasoning is unset", () => {
      expect(makeBuilder("x").reasoningEffort("claude")).toBeUndefined();
    });

    it("maps low/medium/high to claude output_config.effort values", () => {
      expect(
        makeBuilder("x", { reasoning: "low" }).reasoningEffort("claude")
      ).toBe("low");
      expect(
        makeBuilder("x", { reasoning: "medium" }).reasoningEffort("claude")
      ).toBe("medium");
      expect(
        makeBuilder("x", { reasoning: "high" }).reasoningEffort("claude")
      ).toBe("high");
    });

    it("maps to codex/openai reasoning effort values", () => {
      expect(
        makeBuilder("x", { reasoning: "high" }).reasoningEffort("codex")
      ).toBe("high");
      expect(
        makeBuilder("x", { reasoning: "low" }).reasoningEffort("openai")
      ).toBe("low");
    });

    it('maps to gemini thinking level (low → "low" for latency)', () => {
      expect(
        makeBuilder("x", { reasoning: "low" }).reasoningEffort("gemini")
      ).toBe("low");
      expect(
        makeBuilder("x", { reasoning: "high" }).reasoningEffort("gemini")
      ).toBe("high");
    });

    it("returns undefined for qwen (reasoning is carried in the system prompt switch, not an effort knob)", () => {
      expect(
        makeBuilder("x", { reasoning: "high" }).reasoningEffort("qwen")
      ).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 5.2b — structured-output dimension (REQ-PREP-2 dim 2)
  // -------------------------------------------------------------------------

  describe("structuredOutputConfig(providerId)", () => {
    const SCHEMA = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    } as const;

    function b(opts?: ConstructorParameters<typeof SystemPromptBuilder>[1]) {
      return new SystemPromptBuilder("Answer.", opts);
    }

    it("returns undefined when no outputSchema is set", () => {
      expect(b().structuredOutputConfig("claude")).toBeUndefined();
    });

    it("maps to Claude output_config.format json_schema", () => {
      const cfg = b({ outputSchema: SCHEMA }).structuredOutputConfig("claude");
      expect(cfg).toEqual({
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      });
    });

    it("maps to OpenAI/Codex response_format json_schema (strict)", () => {
      const expected = {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "structured_output",
            strict: true,
            schema: SCHEMA,
          },
        },
      };
      expect(
        b({ outputSchema: SCHEMA }).structuredOutputConfig("openai")
      ).toEqual(expected);
      expect(
        b({ outputSchema: SCHEMA }).structuredOutputConfig("codex")
      ).toEqual(expected);
    });

    it("maps to Gemini responseSchema + responseMimeType", () => {
      const cfg = b({ outputSchema: SCHEMA }).structuredOutputConfig("gemini");
      expect(cfg).toEqual({
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
      });
    });

    it("maps to a Qwen tool-call envelope", () => {
      const cfg = b({ outputSchema: SCHEMA }).structuredOutputConfig("qwen");
      expect(cfg).toEqual({
        tools: [
          {
            type: "function",
            function: {
              name: "structured_output",
              description: "Return the result as structured JSON.",
              parameters: SCHEMA,
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "structured_output" },
        },
      });
    });

    it("returns undefined for CLI passthrough providers (crush, goose)", () => {
      expect(
        b({ outputSchema: SCHEMA }).structuredOutputConfig("crush")
      ).toBeUndefined();
      expect(
        b({ outputSchema: SCHEMA }).structuredOutputConfig("goose")
      ).toBeUndefined();
    });

    it("uses a custom schema name when provided", () => {
      const cfg = b({
        outputSchema: SCHEMA,
        outputSchemaName: "weather",
      }).structuredOutputConfig("openai") as {
        response_format: { json_schema: { name: string } };
      };
      expect(cfg.response_format.json_schema.name).toBe("weather");
    });
  });

  // -------------------------------------------------------------------------
  // Phase 5.2b — raw passthrough (REQ-PREP-4)
  // -------------------------------------------------------------------------

  describe("promptPrep raw passthrough", () => {
    const SCHEMA = { type: "object" } as const;

    it("buildFor returns the raw text for every provider when raw=true", () => {
      const builder = new SystemPromptBuilder("Verbatim.", {
        raw: true,
        reasoning: "low",
        qwenReasoning: "off",
      });
      expect(builder.buildFor("claude")).toBe("Verbatim.");
      expect(builder.buildFor("codex")).toBe("Verbatim.");
      expect(builder.buildFor("qwen")).toBe("Verbatim.");
      expect(builder.buildFor("gemini")).toBe("Verbatim.");
    });

    it("reasoningEffort is suppressed when raw=true", () => {
      const builder = new SystemPromptBuilder("x", {
        raw: true,
        reasoning: "high",
      });
      expect(builder.reasoningEffort("claude")).toBeUndefined();
    });

    it("structuredOutputConfig is suppressed when raw=true", () => {
      const builder = new SystemPromptBuilder("x", {
        raw: true,
        outputSchema: SCHEMA,
      });
      expect(builder.structuredOutputConfig("claude")).toBeUndefined();
    });
  });
});
