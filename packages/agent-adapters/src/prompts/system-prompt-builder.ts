/**
 * SystemPromptBuilder — provider-aware system prompt construction.
 *
 * Different providers handle system prompts differently:
 *   - Claude: can replace the entire system prompt OR append to the built-in
 *     claude_code preset. Append (default) is almost always preferable so the
 *     agent retains its full tool-use and safety knowledge.
 *   - Codex: system-level instructions go in `config.instructions` (user-facing
 *     role/context) and optionally `config.developer_instructions` (meta-level
 *     agent reasoning behaviour).
 *   - Qwen: plain string, optionally with a `/think` or `/no_think` reasoning
 *     soft switch appended (see `qwenReasoning`).
 *   - All other providers (Gemini, Crush, Goose, OpenRouter): plain string
 *     system prompts passed directly to the underlying model.
 *
 * Usage:
 *   const builder = new SystemPromptBuilder('You are a TypeScript expert.')
 *   const payload = builder.buildFor('claude')
 *   // → { type: 'preset', preset: 'claude_code', append: 'You are a TypeScript expert.' }
 *
 *   const payload = builder.buildFor('codex')
 *   // → { instructions: 'You are a TypeScript expert.' }
 *
 *   const payload = builder.buildFor('gemini')
 *   // → 'You are a TypeScript expert.'
 */

import type { AdapterProviderId } from "../types.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Claude SDK preset-append form (keeps built-in claude_code system + adds user text). */
export interface ClaudeAppendPayload {
  type: "preset";
  preset: "claude_code";
  append: string;
}

/** Claude plain-string form (replaces the entire system prompt). */
export type ClaudeReplacePayload = string;

/** Codex config-key form (maps to --config instructions / developer_instructions). */
export interface CodexPromptPayload {
  instructions: string;
  developer_instructions?: string;
}

/** Generic string payload used by all other providers. */
export type StringPromptPayload = string;

export type SystemPromptPayload =
  | ClaudeAppendPayload
  | ClaudeReplacePayload
  | CodexPromptPayload
  | StringPromptPayload;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SystemPromptBuilderOptions {
  /**
   * For Claude: whether to append the system prompt to the built-in preset
   * or replace it entirely.
   * - `'append'` (default): preserves all claude_code tool/safety knowledge.
   * - `'replace'`: replaces the entire system prompt; use only when you need
   *   full control of the system context.
   */
  claudeMode?: "append" | "replace";

  /**
   * For Codex: optional `developer_instructions` string (meta-level agent
   * behaviour, separate from user-facing `instructions`).
   */
  codexDeveloperInstructions?: string;

  /**
   * For Qwen: reasoning soft switch appended to the system prompt.
   * - `'on'` appends `/think` (enable chain-of-thought).
   * - `'off'` appends `/no_think` (disable thinking; e.g. qwen-code / latency).
   * - unset (default): no switch appended; the model's own default applies.
   * The most recent switch wins in multi-turn conversations, so placing it on
   * the system prompt sets the baseline mode for the run.
   *
   * Takes precedence over the normalized {@link reasoning} mapping for Qwen
   * (author override, FR-4.2).
   */
  qwenReasoning?: "on" | "off";

  /**
   * Normalized reasoning intent (FR-4 / REQ-PREP-2), mapped per provider:
   * - Claude: `output_config.effort` (via {@link SystemPromptBuilder.reasoningEffort}).
   * - OpenAI / Codex: reasoning effort (via `reasoningEffort`).
   * - Gemini: thinking level (via `reasoningEffort`); `'low'` also appends a
   *   lean "think silently" directive to the system prompt for latency.
   * - Qwen: `/think` (medium/high) vs `/no_think` (low) soft switch in the
   *   system prompt — Qwen has no separate effort knob.
   * Unset (default): no reasoning shaping is applied.
   */
  reasoning?: "low" | "medium" | "high";

  /**
   * Normalized structured-output intent (FR-4 / REQ-PREP-2 dim 2): a JSON Schema
   * mapped to each provider's NATIVE structured-output request mechanism via
   * {@link SystemPromptBuilder.structuredOutputConfig} — never to prompt wording
   * where a native mechanism exists. Unset (default): no structured-output config.
   */
  outputSchema?: Record<string, unknown>;

  /**
   * Name attached to the structured-output schema where the provider's
   * mechanism takes one (OpenAI json_schema name, Qwen tool name). Default
   * `'structured_output'`.
   */
  outputSchemaName?: string;

  /**
   * Raw passthrough (REQ-PREP-4): when `true`, every prep adornment is
   * bypassed — `buildFor` returns the verbatim system prompt for all providers,
   * and `reasoningEffort` / `structuredOutputConfig` return `undefined`. For
   * advanced authors who want full control of the provider request.
   */
  raw?: boolean;
}

/** Provider effort value produced by {@link SystemPromptBuilder.reasoningEffort}. */
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Provider-native structured-output request config produced by
 * {@link SystemPromptBuilder.structuredOutputConfig}. The shape is the
 * provider's own — the adapter spreads it into its request payload.
 */
export type StructuredOutputRequestConfig = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Persona template context & resolution
// ---------------------------------------------------------------------------

/**
 * Context variables available for persona-aware system prompt templates.
 * All fields optional — unresolved variables are left as-is with a warning.
 */
export interface PersonaTemplateContext {
  persona?: {
    id?: string;
    name?: string;
    role?: string;
  };
  task?: {
    description?: string;
  };
  run?: {
    depth?: number;
    branchId?: string;
    rootRunId?: string;
  };
  parent?: {
    output?: string;
  };
  /** Arbitrary extra variables merged at resolution time. */
  extra?: Record<string, string>;
}

/**
 * Resolves `{{variable}}` placeholders in a template string using the
 * provided context.  Supports dot-path notation: `{{persona.role}}`,
 * `{{run.depth}}`, `{{parent.output}}`, etc.
 *
 * Unknown placeholders are left unchanged and logged as warnings.
 */
export function resolvePersonaTemplate(
  template: string,
  ctx: PersonaTemplateContext
): string {
  const flat: Record<string, string> = {};

  if (ctx.persona) {
    if (ctx.persona.id != null) flat["persona.id"] = ctx.persona.id;
    if (ctx.persona.name != null) flat["persona.name"] = ctx.persona.name;
    if (ctx.persona.role != null) flat["persona.role"] = ctx.persona.role;
  }
  if (ctx.task) {
    if (ctx.task.description != null)
      flat["task.description"] = ctx.task.description;
  }
  if (ctx.run) {
    if (ctx.run.depth != null) flat["run.depth"] = String(ctx.run.depth);
    if (ctx.run.branchId != null) flat["run.branchId"] = ctx.run.branchId;
    if (ctx.run.rootRunId != null) flat["run.rootRunId"] = ctx.run.rootRunId;
  }
  if (ctx.parent) {
    if (ctx.parent.output != null) flat["parent.output"] = ctx.parent.output;
  }
  if (ctx.extra) {
    for (const [k, v] of Object.entries(ctx.extra)) {
      flat[k] = v;
    }
  }

  return template.replace(
    /\{\{([^}]+)\}\}/g,
    (match: string, key: string): string => {
      const trimmed = key.trim();
      if (trimmed in flat) return flat[trimmed]!;
      // Leave unresolved placeholder as-is (don't break the prompt silently)
      return match;
    }
  );
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class SystemPromptBuilder {
  private readonly text: string;
  private readonly opts: {
    claudeMode: "append" | "replace";
    codexDeveloperInstructions: string;
    qwenReasoning: "on" | "off" | null;
    reasoning: "low" | "medium" | "high" | null;
    outputSchema: Record<string, unknown> | null;
    outputSchemaName: string;
    raw: boolean;
  };

  constructor(systemPrompt: string, opts: SystemPromptBuilderOptions = {}) {
    if (!systemPrompt.trim()) {
      throw new Error(
        "SystemPromptBuilder: systemPrompt must be a non-empty string"
      );
    }
    this.text = systemPrompt;
    this.opts = {
      claudeMode: opts.claudeMode ?? "append",
      codexDeveloperInstructions: opts.codexDeveloperInstructions ?? "",
      qwenReasoning: opts.qwenReasoning ?? null,
      reasoning: opts.reasoning ?? null,
      outputSchema: opts.outputSchema ?? null,
      outputSchemaName: opts.outputSchemaName ?? "structured_output",
      raw: opts.raw ?? false,
    };
  }

  /**
   * Build the provider-specific system prompt payload.
   *
   * Returns the value that should be assigned to the provider-specific option
   * field (e.g. `options.systemPrompt` for Claude, `config.instructions` for
   * Codex, or the `systemPrompt` query param for others).
   *
   * When `raw` is set, returns the verbatim system prompt for every provider
   * (no adornment).
   */
  buildFor(providerId: AdapterProviderId): SystemPromptPayload {
    if (this.opts.raw) return this.text;
    switch (providerId) {
      case "claude":
        return this.buildForClaude();
      case "codex":
        return this.buildForCodex();
      case "qwen":
        return this.buildForQwen();
      case "gemini":
      case "gemini-sdk":
        return this.buildForGemini();
      default:
        return this.text;
    }
  }

  /**
   * Build the Claude-specific payload.
   * Returns an append-preset object by default; plain string in replace mode.
   */
  buildForClaude(): ClaudeAppendPayload | ClaudeReplacePayload {
    if (this.opts.claudeMode === "replace") {
      return this.text;
    }
    return {
      type: "preset",
      preset: "claude_code",
      append: this.text,
    };
  }

  /**
   * Build the Codex-specific config payload.
   * Maps to CLI `--config instructions=...` and optionally
   * `--config developer_instructions=...`.
   */
  buildForCodex(): CodexPromptPayload {
    const payload: CodexPromptPayload = { instructions: this.text };
    if (this.opts.codexDeveloperInstructions) {
      payload.developer_instructions = this.opts.codexDeveloperInstructions;
    }
    return payload;
  }

  /**
   * Build the Qwen-specific system prompt.
   *
   * Resolution order (FR-4.2 author override):
   *   1. explicit `qwenReasoning` (`'on'`→`/think`, `'off'`→`/no_think`), else
   *   2. normalized `reasoning` (`'low'`→`/no_think`, `'medium'|'high'`→`/think`), else
   *   3. raw prompt unchanged.
   * The most recent switch wins in multi-turn, so this sets the run baseline.
   */
  buildForQwen(): StringPromptPayload {
    const sw = this.qwenSwitch();
    return sw ? `${this.text}\n\n${sw}` : this.text;
  }

  private qwenSwitch(): "/think" | "/no_think" | null {
    if (this.opts.qwenReasoning === "off") return "/no_think";
    if (this.opts.qwenReasoning === "on") return "/think";
    if (this.opts.reasoning === "low") return "/no_think";
    if (this.opts.reasoning === "medium" || this.opts.reasoning === "high") {
      return "/think";
    }
    return null;
  }

  /**
   * Build the Gemini-specific system prompt. Gemini favors directness and is
   * terse by default (§3.3), so no verbose scaffolding is added. On
   * `reasoning: 'low'` a lean "think silently" directive is appended for
   * latency; on medium/high the prompt is left unpadded so the model's own
   * thinking does the work.
   */
  buildForGemini(): StringPromptPayload {
    if (this.opts.reasoning === "low") {
      return `${this.text}\n\nThink silently; keep reasoning brief.`;
    }
    return this.text;
  }

  /**
   * Map the normalized `reasoning` intent onto a provider's API-level effort
   * knob (REQ-PREP-2), for the adapter to apply outside the system prompt:
   *   - Claude → `output_config.effort`
   *   - OpenAI / Codex → reasoning effort
   *   - Gemini → thinking level
   *   - Qwen → `undefined` (carried in the system-prompt soft switch instead)
   * Returns `undefined` when no reasoning intent is set, or for providers that
   * have no separate effort knob.
   */
  reasoningEffort(providerId: AdapterProviderId): ReasoningEffort | undefined {
    if (this.opts.raw || this.opts.reasoning === null) return undefined;
    switch (providerId) {
      case "claude":
      case "codex":
      case "openai":
      case "openrouter":
      case "gemini":
      case "gemini-sdk":
        return this.opts.reasoning;
      default:
        // qwen (system-prompt switch), crush/goose (CLI passthrough): no knob.
        return undefined;
    }
  }

  /**
   * Map the normalized `outputSchema` (a JSON Schema) onto a provider's NATIVE
   * structured-output request mechanism (REQ-PREP-2 dim 2). The returned object
   * is the provider's own request shape, which the adapter spreads into its
   * request payload:
   *   - Claude → `{ output_config: { format: { type: 'json_schema', schema } } }`
   *   - OpenAI / Codex / OpenRouter → `{ response_format: { type: 'json_schema',
   *     json_schema: { name, strict: true, schema } } }`
   *   - Gemini → `{ responseMimeType: 'application/json', responseSchema }`
   *   - Qwen → a forced `structured_output` tool-call envelope
   * Returns `undefined` when no `outputSchema` is set, in `raw` mode, or for
   * CLI-passthrough providers (crush, goose) that expose no native mechanism.
   */
  structuredOutputConfig(
    providerId: AdapterProviderId
  ): StructuredOutputRequestConfig | undefined {
    if (this.opts.raw || this.opts.outputSchema === null) return undefined;
    const schema = this.opts.outputSchema;
    const name = this.opts.outputSchemaName;
    switch (providerId) {
      case "claude":
        return { output_config: { format: { type: "json_schema", schema } } };
      case "codex":
      case "openai":
      case "openrouter":
        return {
          response_format: {
            type: "json_schema",
            json_schema: { name, strict: true, schema },
          },
        };
      case "gemini":
      case "gemini-sdk":
        return {
          responseMimeType: "application/json",
          responseSchema: schema,
        };
      case "qwen":
        return {
          tools: [
            {
              type: "function",
              function: {
                name,
                description: "Return the result as structured JSON.",
                parameters: schema,
              },
            },
          ],
          tool_choice: { type: "function", function: { name } },
        };
      default:
        // crush / goose: CLI passthrough, no native structured-output knob.
        return undefined;
    }
  }

  /** The raw system prompt text (useful for logging / serialization). */
  get rawText(): string {
    return this.text;
  }

  /**
   * Create a SystemPromptBuilder from a persona template string with
   * `{{variable}}` placeholders resolved from the given context.
   *
   * Supports: `{{persona.name}}`, `{{persona.role}}`, `{{task.description}}`,
   * `{{run.depth}}`, `{{run.branchId}}`, `{{parent.output}}`.
   */
  static fromPersonaTemplate(
    template: string,
    ctx: PersonaTemplateContext,
    opts?: SystemPromptBuilderOptions
  ): SystemPromptBuilder {
    const resolved = resolvePersonaTemplate(template, ctx);
    return new SystemPromptBuilder(resolved, opts);
  }
}
