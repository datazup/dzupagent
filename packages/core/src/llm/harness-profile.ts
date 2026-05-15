/**
 * HarnessProfile — versioned per-model prompt/tool/middleware policy.
 *
 * Inspired by Deep Agents v0.6 harness profiles. A profile is a small
 * versioned policy object that overrides how a model is called:
 *   - system prompt prefix/suffix injection
 *   - tool visibility (include/exclude by name)
 *   - middleware include/exclude by name
 *   - default subagent config overrides
 *
 * Profiles are resolved at invocation time via HarnessProfileRegistry which
 * matches by provider, modelName (glob), and tier.
 *
 * Eval-artifact loop: profiles carry a `benchmarkId` so callers can gate
 * profile promotion behind benchmark regressions rather than updating ad hoc.
 */

import type { ModelTier, LLMProviderName } from './model-config.js'

// ---------------------------------------------------------------------------
// Profile types
// ---------------------------------------------------------------------------

/** Instruction injected into the system prompt. */
export interface SystemPromptOverride {
  /** Text to prepend to the system prompt. */
  prefix?: string
  /** Text to append to the system prompt. */
  suffix?: string
}

/** Controls which tools the model may see during invocation. */
export interface ToolVisibilityOverride {
  /**
   * If set, only these tool names are visible to the model.
   * Mutually exclusive with `exclude`.
   */
  include?: string[]
  /**
   * Tool names to hide from the model.
   * Applied after `include` if both are set (include takes precedence).
   */
  exclude?: string[]
  /** Override an existing tool's description. */
  descriptionOverrides?: Record<string, string>
}

/** Middleware names to activate or deactivate for this model. */
export interface MiddlewareOverride {
  /** Middleware names to force-include (even if not globally registered). */
  include?: string[]
  /** Middleware names to force-exclude. */
  exclude?: string[]
}

/** Lightweight subagent default overrides. */
export interface SubagentConfigOverride {
  maxIterations?: number
  temperature?: number
  maxTokens?: number
}

/**
 * A versioned harness profile for one or more model surfaces.
 *
 * Resolution order (first match wins):
 *   1. Exact provider + modelName match
 *   2. provider wildcard + modelName match
 *   3. tier match
 *   4. Default profile (no selectors)
 */
export interface HarnessProfile {
  /** Unique profile identifier. */
  id: string
  /**
   * Semantic version of this profile's content.
   * Callers can pin to a version to prevent accidental drift.
   */
  version: string
  /** Human-readable description. */
  description?: string
  /**
   * Optional benchmark run ID that validated this profile.
   * Promotes disciplined, eval-driven profile updates.
   */
  benchmarkId?: string

  // ---- Selectors (all optional — omit to make this the default profile) ----

  /** Restrict to a specific provider (e.g. 'anthropic', 'openai'). */
  provider?: LLMProviderName
  /**
   * Restrict to a model name or glob pattern
   * (e.g. 'claude-opus-4-7', 'claude-*', 'gpt-4*').
   */
  modelGlob?: string
  /** Restrict to a model capability tier. */
  tier?: ModelTier

  // ---- Overrides (all optional) -------------------------------------------

  systemPrompt?: SystemPromptOverride
  toolVisibility?: ToolVisibilityOverride
  middleware?: MiddlewareOverride
  subagentDefaults?: SubagentConfigOverride

  /** Wall-clock time this profile was registered/updated (ms since epoch). */
  registeredAt: number
}

// ---------------------------------------------------------------------------
// Application result
// ---------------------------------------------------------------------------

/**
 * Resolved overrides after applying a profile — what actually gets injected
 * at invocation time. Callers receive this from `HarnessProfileRegistry.resolve()`.
 */
export interface ResolvedHarnessOverrides {
  profileId: string
  profileVersion: string
  systemPromptPrefix?: string
  systemPromptSuffix?: string
  visibleToolNames?: string[]
  excludedToolNames?: string[]
  toolDescriptionOverrides?: Record<string, string>
  activeMiddlewareNames?: string[]
  excludedMiddlewareNames?: string[]
  subagentDefaults?: SubagentConfigOverride
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry that stores HarnessProfiles and resolves the best match for a
 * given provider/model/tier combination.
 *
 * Wire into ModelRegistry via `ModelRegistry.setHarnessProfileRegistry()`.
 */
export class HarnessProfileRegistry {
  private readonly profiles: HarnessProfile[] = []

  /** Register a profile. Later registrations override earlier ones with the same id. */
  register(profile: HarnessProfile): void {
    const idx = this.profiles.findIndex(p => p.id === profile.id)
    if (idx !== -1) {
      this.profiles[idx] = profile
    } else {
      this.profiles.push(profile)
    }
  }

  /** Remove a profile by id. */
  remove(id: string): boolean {
    const idx = this.profiles.findIndex(p => p.id === id)
    if (idx === -1) return false
    this.profiles.splice(idx, 1)
    return true
  }

  /** List all registered profiles. */
  list(): readonly HarnessProfile[] {
    return this.profiles
  }

  /** Get a profile by id. */
  get(id: string): HarnessProfile | undefined {
    return this.profiles.find(p => p.id === id)
  }

  /**
   * Resolve the best-matching profile for a given context.
   *
   * Resolution priority:
   *   1. provider + modelName exact/glob match
   *   2. provider-only match
   *   3. tier-only match
   *   4. Default profile (no selectors set)
   *
   * Returns undefined if no profiles are registered.
   */
  resolve(context: {
    provider: LLMProviderName
    modelName: string
    tier?: ModelTier
  }): ResolvedHarnessOverrides | undefined {
    const candidates = this.profiles.filter(p => this.matches(p, context))
    if (candidates.length === 0) return undefined

    // Sort by specificity: more selectors = higher priority.
    const scored = candidates.map(p => ({ p, score: specificity(p) }))
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]!.p

    return toResolved(best)
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private matches(
    profile: HarnessProfile,
    ctx: { provider: LLMProviderName; modelName: string; tier?: ModelTier },
  ): boolean {
    if (profile.provider && profile.provider !== ctx.provider) return false
    if (profile.modelGlob && !globMatch(profile.modelGlob, ctx.modelName)) return false
    if (profile.tier && profile.tier !== ctx.tier) return false
    return true
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function specificity(p: HarnessProfile): number {
  let s = 0
  if (p.provider) s += 4
  if (p.modelGlob) s += 2
  if (p.tier) s += 1
  return s
}

/**
 * Minimal glob matcher — supports `*` as a multi-character wildcard.
 * Sufficient for model name patterns like `claude-*` or `gpt-4*`.
 */
function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value
  const parts = pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`^${parts.join('.*')}$`)
  return re.test(value)
}

function toResolved(p: HarnessProfile): ResolvedHarnessOverrides {
  const out: ResolvedHarnessOverrides = {
    profileId: p.id,
    profileVersion: p.version,
  }
  if (p.systemPrompt?.prefix) out.systemPromptPrefix = p.systemPrompt.prefix
  if (p.systemPrompt?.suffix) out.systemPromptSuffix = p.systemPrompt.suffix
  if (p.toolVisibility?.include) out.visibleToolNames = p.toolVisibility.include
  if (p.toolVisibility?.exclude) out.excludedToolNames = p.toolVisibility.exclude
  if (p.toolVisibility?.descriptionOverrides) out.toolDescriptionOverrides = p.toolVisibility.descriptionOverrides
  if (p.middleware?.include) out.activeMiddlewareNames = p.middleware.include
  if (p.middleware?.exclude) out.excludedMiddlewareNames = p.middleware.exclude
  if (p.subagentDefaults) out.subagentDefaults = p.subagentDefaults
  return out
}
