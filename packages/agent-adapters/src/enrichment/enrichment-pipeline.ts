/**
 * EnrichmentPipeline — composes DzupAgent Unified Capability Layer enrichment
 * into an {@link AgentInput} without inline string concatenation.
 *
 * Replaces the ad-hoc logic previously living in
 * `OrchestratorFacade.applyDzupAgentEnrichment()`. Each phase is delegated to
 * an existing, well-tested component:
 *
 *   - Skills   → {@link SkillProjector} (`projectBundles` + `applyToInput`)
 *   - Memory   → {@link DzupAgentMemoryLoader} (`loadEntries`) + a small
 *                memory-block composer that also uses the projector's
 *                `applyToInput` style append semantics
 *   - Policy   → {@link compilePolicyForProvider} (optional)
 *   - Shaping  → {@link SystemPromptBuilder} (`buildFor`)  — ensures the final
 *                string passed to the adapter is produced by the canonical
 *                provider-aware shaper rather than inline template literals.
 *
 * Failures in any phase are best-effort: a broken skill file or a malformed
 * memory document must not block the underlying run. Policy compilation
 * failures, when a policy is supplied, propagate to the caller so that
 * conformance can be enforced by {@link PolicyConformanceChecker}.
 */

import { DzupAgentFileLoader } from '../dzupagent/file-loader.js'
import { DzupAgentMemoryLoader } from '../dzupagent/memory-loader.js'
import { getCodexMemoryStrategy, getMaxMemoryTokens } from '../dzupagent/config.js'
import { compilePolicyForProvider } from '../policy/policy-compiler.js'
import type {
  AdapterPolicy,
  CompiledPolicyOverrides,
} from '../policy/policy-compiler.js'
import { SkillProjector } from '../skills/skill-projector.js'
import type { AdapterSkillBundle } from '../skills/adapter-skill-types.js'
import { SystemPromptBuilder } from '../prompts/system-prompt-builder.js'
import type {
  AdapterProviderId,
  AgentInput,
  AgentMemoryRecalledEvent,
  AgentSkillsCompiledEvent,
  DzupAgentConfig,
  DzupAgentPaths,
} from '../types.js'

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Input context for a single pipeline invocation.
 *
 * The pipeline is stateless — every call receives a fully-populated context.
 * Callers are responsible for resolving paths, loading the DzupAgent config,
 * selecting a provider, and providing an event emitter.
 */
export interface EnrichmentContext {
  /** Resolved `.dzupagent/` paths */
  paths: DzupAgentPaths
  /** Parsed DzupAgent config (governs token budgets, memory strategy, …) */
  dzupConfig: DzupAgentConfig
  /** Target provider for shaping/memory-strategy decisions */
  providerId: AdapterProviderId
  /** When true, skip the skills phase entirely */
  skipSkills?: boolean | undefined
  /** When true, skip the memory phase entirely */
  skipMemory?: boolean | undefined
  /**
   * Optional policy to compile for the target provider. When supplied, the
   * pipeline returns the compiled overrides in {@link EnrichmentResult}.
   * Conformance checking is the caller's responsibility — this keeps the
   * pipeline free of event-bus coupling for policy violations.
   */
  policy?: AdapterPolicy | undefined
  /**
   * Side-effect callback used to surface `adapter:skills_compiled` and
   * `adapter:memory_recalled` events. The pipeline itself never touches
   * the event bus directly.
   */
  emitEvent?: (event: AgentSkillsCompiledEvent | AgentMemoryRecalledEvent) => void
}

/** Result of a pipeline invocation — enriched input plus metadata. */
export interface EnrichmentResult {
  /** The (possibly mutated) input — same reference as the argument */
  input: AgentInput
  /** Number of skill bundles applied, if any */
  skillCount: number
  /** Number of memory entries applied, if any */
  memoryCount: number
  /** Compiled policy overrides, when `context.policy` was supplied */
  compiledPolicy?: CompiledPolicyOverrides | undefined
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Orchestrates the skill / memory / policy / prompt-shaping phases.
 *
 * Usage:
 * ```ts
 * const pipeline = new EnrichmentPipeline()
 * const result = await pipeline.apply(input, {
 *   paths,
 *   dzupConfig,
 *   providerId,
 *   skipMemory,
 *   skipSkills,
 *   emitEvent: (e) => eventBus.emit(e as unknown as DzupEvent),
 * })
 * ```
 */
export class EnrichmentPipeline {
  private readonly skillProjector: SkillProjector

  /**
   * Static record of per-phase timings for the most recent {@link apply} run.
   * Callers use {@link metrics} to inspect the last run's observability
   * counters without having to thread a separate observer through the
   * pipeline.
   */
  private static _lastRunMetrics: {
    skills?: { durationMs: number }
    memory?: { durationMs: number }
    promptShaping?: { durationMs: number }
  } = {}

  constructor(skillProjector: SkillProjector = new SkillProjector()) {
    this.skillProjector = skillProjector
  }

  /**
   * Apply the full enrichment pipeline in-place on the given {@link AgentInput}.
   *
   * The returned {@link EnrichmentResult} holds the same `input` reference so
   * callers that mutate inputs (as the facade does) observe the updated
   * `systemPrompt` / `options` without extra plumbing.
   */
  async apply(input: AgentInput, context: EnrichmentContext): Promise<EnrichmentResult> {
    // Reset last-run metrics at the start of every invocation so readers
    // never observe stale values from a previous pipeline call.
    EnrichmentPipeline._lastRunMetrics = {}

    let skillCount = 0
    let memoryCount = 0

    if (!context.skipSkills) {
      skillCount = await this.applySkills(input, context)
    }

    if (!context.skipMemory) {
      memoryCount = await this.applyMemory(input, context)
    }

    // Final prompt shaping — routes the accumulated string through the
    // canonical builder so provider-aware shaping is the single source of
    // truth for how the string is normalised before an adapter sees it.
    this.applyPromptShaping(input, context)

    const compiledPolicy = context.policy
      ? compilePolicyForProvider(context.providerId, context.policy)
      : undefined

    return {
      input,
      skillCount,
      memoryCount,
      ...(compiledPolicy !== undefined ? { compiledPolicy } : {}),
    }
  }

  /**
   * Convenience static entry point for callers that don't need a custom
   * {@link SkillProjector}. Creates a transient pipeline and runs it.
   */
  static apply(
    input: AgentInput,
    context: EnrichmentContext,
  ): Promise<EnrichmentResult> {
    return new EnrichmentPipeline().apply(input, context)
  }

  /**
   * Returns a shallow copy of the per-phase timings captured during the most
   * recent {@link apply} invocation. Phases that were skipped (via
   * `skipSkills` / `skipMemory`) are absent from the returned object.
   *
   * The shape is intentionally stable so downstream consumers (dashboards,
   * OTel exporters, replay viewers) can depend on it without extra typing.
   */
  static metrics(): {
    skills?: { durationMs: number }
    memory?: { durationMs: number }
    promptShaping?: { durationMs: number }
  } {
    return { ...EnrichmentPipeline._lastRunMetrics }
  }

  // -------------------------------------------------------------------------
  // Phase: skills
  // -------------------------------------------------------------------------

  private async applySkills(
    input: AgentInput,
    context: EnrichmentContext,
  ): Promise<number> {
    const t0 = Date.now()
    let bundles: AdapterSkillBundle[]
    try {
      const loader = new DzupAgentFileLoader({ paths: context.paths })
      bundles = await loader.loadSkills()
    } catch {
      // Best-effort — broken skill file must not block the run
      const durationMs = Date.now() - t0
      EnrichmentPipeline._lastRunMetrics.skills = { durationMs }
      return 0
    }

    if (bundles.length === 0) {
      const durationMs = Date.now() - t0
      EnrichmentPipeline._lastRunMetrics.skills = { durationMs }
      return 0
    }

    const projection = this.skillProjector.projectBundles(bundles, context.providerId)
    const projected = this.skillProjector.applyToInput(input, projection)

    // `applyToInput` returns a new AgentInput; mirror its string output onto
    // the caller's reference so in-place mutation semantics are preserved.
    input.systemPrompt = projected.systemPrompt

    const durationMs = Date.now() - t0
    EnrichmentPipeline._lastRunMetrics.skills = { durationMs }

    if (context.emitEvent) {
      const event: AgentSkillsCompiledEvent = {
        type: 'adapter:skills_compiled',
        providerId: context.providerId,
        timestamp: Date.now(),
        skills: bundles.map((b) => ({ skillId: b.bundleId, degraded: [], dropped: [] })),
        durationMs,
      }
      context.emitEvent(event)
    }

    return bundles.length
  }

  // -------------------------------------------------------------------------
  // Phase: memory
  // -------------------------------------------------------------------------

  private async applyMemory(
    input: AgentInput,
    context: EnrichmentContext,
  ): Promise<number> {
    const t0 = Date.now()
    try {
      const loader = new DzupAgentMemoryLoader({
        paths: context.paths,
        providerId: context.providerId,
        maxTotalTokens: getMaxMemoryTokens(context.dzupConfig),
        codexMemoryStrategy: getCodexMemoryStrategy(context.dzupConfig),
        ...(context.emitEvent
          ? {
              onRecalled: (entries, totalTokens) => {
                const event: AgentMemoryRecalledEvent = {
                  type: 'adapter:memory_recalled',
                  providerId: context.providerId,
                  timestamp: Date.now(),
                  entries,
                  totalTokens,
                  durationMs: Date.now() - t0,
                }
                context.emitEvent!(event)
              },
            }
          : {}),
      })

      const entries = await loader.loadEntries()
      if (entries.length === 0) {
        const durationMs = Date.now() - t0
        EnrichmentPipeline._lastRunMetrics.memory = { durationMs }
        return 0
      }

      const memoryBlock = composeMemoryBlock(entries.map((e) => e.content))
      input.systemPrompt = appendSection(input.systemPrompt, memoryBlock)

      const durationMs = Date.now() - t0
      EnrichmentPipeline._lastRunMetrics.memory = { durationMs }
      return entries.length
    } catch {
      // Best-effort — malformed memory must not block the run
      const durationMs = Date.now() - t0
      EnrichmentPipeline._lastRunMetrics.memory = { durationMs }
      return 0
    }
  }

  // -------------------------------------------------------------------------
  // Phase: prompt shaping
  // -------------------------------------------------------------------------

  private applyPromptShaping(input: AgentInput, context: EnrichmentContext): void {
    const t0 = Date.now()
    const text = input.systemPrompt
    if (!text || !text.trim()) {
      const durationMs = Date.now() - t0
      EnrichmentPipeline._lastRunMetrics.promptShaping = { durationMs }
      return
    }

    // `SystemPromptBuilder` validates and normalises the assembled prompt.
    // For string-returning providers (everything except claude/codex) the
    // output is the canonical string payload; for claude/codex the caller
    // (adapter layer) performs the final mapping to SDK-specific payloads,
    // so we only normalise the underlying text here.
    const builder = new SystemPromptBuilder(text)
    const payload = builder.buildFor(context.providerId)
    if (typeof payload === 'string') {
      input.systemPrompt = payload
    } else {
      // Non-string payloads are adapter-layer concerns; preserve the raw text.
      input.systemPrompt = builder.rawText
    }

    const durationMs = Date.now() - t0
    EnrichmentPipeline._lastRunMetrics.promptShaping = { durationMs }
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Compose the `## Project Context` memory block from pre-loaded entries.
 * Kept private so the facade no longer holds the literal template.
 */
function composeMemoryBlock(contents: readonly string[]): string {
  const snippets = contents.map((c) => c.trim()).filter((c) => c.length > 0).join('\n\n')
  return `## Project Context\n\n${snippets}\n`
}

/**
 * Append a section to an existing system prompt with a blank-line separator.
 * Returns the new section when the existing prompt is empty.
 */
function appendSection(existing: string | undefined, section: string): string {
  if (!existing) return section
  return `${existing}\n\n${section}`
}
