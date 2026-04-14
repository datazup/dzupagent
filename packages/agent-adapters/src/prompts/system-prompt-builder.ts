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
 *   - All other providers (Gemini, Qwen, Crush, Goose, OpenRouter): plain
 *     string system prompts passed directly to the underlying model.
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

import type { AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Claude SDK preset-append form (keeps built-in claude_code system + adds user text). */
export interface ClaudeAppendPayload {
  type: 'preset'
  preset: 'claude_code'
  append: string
}

/** Claude plain-string form (replaces the entire system prompt). */
export type ClaudeReplacePayload = string

/** Codex config-key form (maps to --config instructions / developer_instructions). */
export interface CodexPromptPayload {
  instructions: string
  developer_instructions?: string
}

/** Generic string payload used by all other providers. */
export type StringPromptPayload = string

export type SystemPromptPayload =
  | ClaudeAppendPayload
  | ClaudeReplacePayload
  | CodexPromptPayload
  | StringPromptPayload

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
  claudeMode?: 'append' | 'replace'

  /**
   * For Codex: optional `developer_instructions` string (meta-level agent
   * behaviour, separate from user-facing `instructions`).
   */
  codexDeveloperInstructions?: string
}

// ---------------------------------------------------------------------------
// Persona template context & resolution
// ---------------------------------------------------------------------------

/**
 * Context variables available for persona-aware system prompt templates.
 * All fields optional — unresolved variables are left as-is with a warning.
 */
export interface PersonaTemplateContext {
  persona?: {
    id?: string
    name?: string
    role?: string
  }
  task?: {
    description?: string
  }
  run?: {
    depth?: number
    branchId?: string
    rootRunId?: string
  }
  parent?: {
    output?: string
  }
  /** Arbitrary extra variables merged at resolution time. */
  extra?: Record<string, string>
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
  ctx: PersonaTemplateContext,
): string {
  const flat: Record<string, string> = {}

  if (ctx.persona) {
    if (ctx.persona.id != null) flat['persona.id'] = ctx.persona.id
    if (ctx.persona.name != null) flat['persona.name'] = ctx.persona.name
    if (ctx.persona.role != null) flat['persona.role'] = ctx.persona.role
  }
  if (ctx.task) {
    if (ctx.task.description != null) flat['task.description'] = ctx.task.description
  }
  if (ctx.run) {
    if (ctx.run.depth != null) flat['run.depth'] = String(ctx.run.depth)
    if (ctx.run.branchId != null) flat['run.branchId'] = ctx.run.branchId
    if (ctx.run.rootRunId != null) flat['run.rootRunId'] = ctx.run.rootRunId
  }
  if (ctx.parent) {
    if (ctx.parent.output != null) flat['parent.output'] = ctx.parent.output
  }
  if (ctx.extra) {
    for (const [k, v] of Object.entries(ctx.extra)) {
      flat[k] = v
    }
  }

  return template.replace(/\{\{([^}]+)\}\}/g, (match: string, key: string): string => {
    const trimmed = key.trim()
    if (trimmed in flat) return flat[trimmed]!
    // Leave unresolved placeholder as-is (don't break the prompt silently)
    return match
  })
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class SystemPromptBuilder {
  private readonly text: string
  private readonly opts: Required<SystemPromptBuilderOptions>

  constructor(systemPrompt: string, opts: SystemPromptBuilderOptions = {}) {
    if (!systemPrompt.trim()) {
      throw new Error('SystemPromptBuilder: systemPrompt must be a non-empty string')
    }
    this.text = systemPrompt
    this.opts = {
      claudeMode: opts.claudeMode ?? 'append',
      codexDeveloperInstructions: opts.codexDeveloperInstructions ?? '',
    }
  }

  /**
   * Build the provider-specific system prompt payload.
   *
   * Returns the value that should be assigned to the provider-specific option
   * field (e.g. `options.systemPrompt` for Claude, `config.instructions` for
   * Codex, or the `systemPrompt` query param for others).
   */
  buildFor(providerId: AdapterProviderId): SystemPromptPayload {
    switch (providerId) {
      case 'claude':
        return this.buildForClaude()
      case 'codex':
        return this.buildForCodex()
      default:
        return this.text
    }
  }

  /**
   * Build the Claude-specific payload.
   * Returns an append-preset object by default; plain string in replace mode.
   */
  buildForClaude(): ClaudeAppendPayload | ClaudeReplacePayload {
    if (this.opts.claudeMode === 'replace') {
      return this.text
    }
    return {
      type: 'preset',
      preset: 'claude_code',
      append: this.text,
    }
  }

  /**
   * Build the Codex-specific config payload.
   * Maps to CLI `--config instructions=...` and optionally
   * `--config developer_instructions=...`.
   */
  buildForCodex(): CodexPromptPayload {
    const payload: CodexPromptPayload = { instructions: this.text }
    if (this.opts.codexDeveloperInstructions) {
      payload.developer_instructions = this.opts.codexDeveloperInstructions
    }
    return payload
  }

  /** The raw system prompt text (useful for logging / serialization). */
  get rawText(): string {
    return this.text
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
    opts?: SystemPromptBuilderOptions,
  ): SystemPromptBuilder {
    const resolved = resolvePersonaTemplate(template, ctx)
    return new SystemPromptBuilder(resolved, opts)
  }
}
