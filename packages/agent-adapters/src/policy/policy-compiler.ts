/**
 * PolicyCompiler -- translates a normalized AdapterPolicy into
 * provider-specific adapter configuration overrides.
 *
 * Each provider has its own semantics for sandbox mode, approval policy,
 * network access, tool allow/block lists, budgets, and turn limits. This
 * module centralizes those translations so callers can express intent once
 * and have it applied uniformly across all registered providers.
 *
 * @example
 * ```ts
 * const policy: AdapterPolicy = {
 *   sandboxMode: 'workspace-write',
 *   networkAccess: false,
 *   approvalRequired: true,
 *   blockedTools: ['shell'],
 *   maxBudgetUsd: 1.0,
 *   maxTurns: 20,
 * }
 *
 * const overrides = compilePolicyForProvider('codex', policy)
 * adapter.configure(overrides.config)
 * ```
 */

import type { AdapterConfig, AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Normalized, provider-agnostic policy declaration. */
export interface AdapterPolicy {
  /** Filesystem access level. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'full-access'
  /** Whether the agent may access the network. */
  networkAccess?: boolean
  /** Whether human approval is required before execution. */
  approvalRequired?: boolean
  /** Tool names the agent is allowed to use (allowlist). */
  allowedTools?: string[]
  /** Tool names the agent must never use (blocklist). */
  blockedTools?: string[]
  /** Maximum spend in USD for a single execution. */
  maxBudgetUsd?: number
  /** Maximum number of turns / iterations. */
  maxTurns?: number
}

/** The compiled output for a single provider. */
export interface CompiledPolicyOverrides {
  /** Partial AdapterConfig to merge via adapter.configure(). */
  config: Partial<AdapterConfig>
  /** Provider-specific options that should land in AgentInput.options. */
  inputOptions: Record<string, unknown>
  /** Guardrail settings derived from the policy. */
  guardrails: CompiledGuardrailHints
}

/** Guardrail hints extracted from the policy for downstream wiring. */
export interface CompiledGuardrailHints {
  maxIterations?: number
  maxCostCents?: number
  blockedTools?: string[]
}

// ---------------------------------------------------------------------------
// Provider compilers
// ---------------------------------------------------------------------------

function compileForCodex(policy: AdapterPolicy): CompiledPolicyOverrides {
  const config: Partial<AdapterConfig> = {}
  const inputOptions: Record<string, unknown> = {}

  if (policy.sandboxMode !== undefined) {
    config.sandboxMode = policy.sandboxMode
  }

  if (policy.networkAccess !== undefined) {
    inputOptions['networkAccessEnabled'] = policy.networkAccess
  }

  if (policy.approvalRequired !== undefined) {
    inputOptions['approvalPolicy'] = policy.approvalRequired ? 'on-failure' : 'never'
  }

  if (policy.maxTurns !== undefined) {
    inputOptions['maxTurns'] = policy.maxTurns
  }

  return {
    config,
    inputOptions,
    guardrails: extractGuardrailHints(policy),
  }
}

function compileForClaude(policy: AdapterPolicy): CompiledPolicyOverrides {
  const config: Partial<AdapterConfig> = {}
  const inputOptions: Record<string, unknown> = {}

  if (policy.sandboxMode !== undefined) {
    config.sandboxMode = policy.sandboxMode
  }

  if (policy.maxBudgetUsd !== undefined) {
    inputOptions['maxBudgetUsd'] = policy.maxBudgetUsd
  }

  if (policy.maxTurns !== undefined) {
    inputOptions['maxTurns'] = policy.maxTurns
  }

  if (policy.approvalRequired !== undefined) {
    // Claude SDK: permissionMode 'default' requires approval, 'bypassPermissions' does not
    const providerOptions: Record<string, unknown> = {
      ...(config.providerOptions ?? {}),
      permissionMode: policy.approvalRequired ? 'default' : 'bypassPermissions',
    }
    config.providerOptions = providerOptions
  }

  return {
    config,
    inputOptions,
    guardrails: extractGuardrailHints(policy),
  }
}

function compileForGemini(policy: AdapterPolicy): CompiledPolicyOverrides {
  const config: Partial<AdapterConfig> = {}
  const inputOptions: Record<string, unknown> = {}

  if (policy.sandboxMode !== undefined) {
    config.sandboxMode = policy.sandboxMode
  }

  if (policy.maxTurns !== undefined) {
    inputOptions['maxTurns'] = policy.maxTurns
  }

  return {
    config,
    inputOptions,
    guardrails: extractGuardrailHints(policy),
  }
}

function compileForQwen(policy: AdapterPolicy): CompiledPolicyOverrides {
  const config: Partial<AdapterConfig> = {}
  const inputOptions: Record<string, unknown> = {}

  if (policy.sandboxMode !== undefined) {
    config.sandboxMode = policy.sandboxMode
  }

  if (policy.maxTurns !== undefined) {
    inputOptions['maxTurns'] = policy.maxTurns
  }

  return {
    config,
    inputOptions,
    guardrails: extractGuardrailHints(policy),
  }
}

function compileForCrush(policy: AdapterPolicy): CompiledPolicyOverrides {
  const config: Partial<AdapterConfig> = {}
  const inputOptions: Record<string, unknown> = {}

  if (policy.sandboxMode !== undefined) {
    config.sandboxMode = policy.sandboxMode
  }

  if (policy.maxTurns !== undefined) {
    inputOptions['maxTurns'] = policy.maxTurns
  }

  return {
    config,
    inputOptions,
    guardrails: extractGuardrailHints(policy),
  }
}

function compileForGoose(policy: AdapterPolicy): CompiledPolicyOverrides {
  const config: Partial<AdapterConfig> = {}
  const inputOptions: Record<string, unknown> = {}

  if (policy.sandboxMode !== undefined) {
    config.sandboxMode = policy.sandboxMode
    // Goose uses --permission-mode via input options
    const gooseModeMap: Record<string, string> = {
      'read-only': 'read-only',
      'workspace-write': 'workspace',
      'full-access': 'full',
    }
    inputOptions['permissionMode'] = gooseModeMap[policy.sandboxMode] ?? 'workspace'
  }

  if (policy.maxTurns !== undefined) {
    inputOptions['maxTurns'] = policy.maxTurns
  }

  return {
    config,
    inputOptions,
    guardrails: extractGuardrailHints(policy),
  }
}

function compileForOpenRouter(policy: AdapterPolicy): CompiledPolicyOverrides {
  const config: Partial<AdapterConfig> = {}
  const inputOptions: Record<string, unknown> = {}

  if (policy.maxTurns !== undefined) {
    inputOptions['maxTurns'] = policy.maxTurns
  }

  // OpenRouter is API-based; sandboxMode and networkAccess are not applicable
  // at the provider level, but guardrail hints still apply.

  return {
    config,
    inputOptions,
    guardrails: extractGuardrailHints(policy),
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function extractGuardrailHints(policy: AdapterPolicy): CompiledGuardrailHints {
  const hints: CompiledGuardrailHints = {}

  if (policy.maxTurns !== undefined) {
    hints.maxIterations = policy.maxTurns
  }

  if (policy.maxBudgetUsd !== undefined) {
    hints.maxCostCents = Math.round(policy.maxBudgetUsd * 100)
  }

  if (policy.blockedTools !== undefined && policy.blockedTools.length > 0) {
    hints.blockedTools = [...policy.blockedTools]
  }

  return hints
}

// ---------------------------------------------------------------------------
// Compiler registry
// ---------------------------------------------------------------------------

type ProviderCompiler = (policy: AdapterPolicy) => CompiledPolicyOverrides

const PROVIDER_COMPILERS: Record<AdapterProviderId, ProviderCompiler> = {
  codex: compileForCodex,
  claude: compileForClaude,
  gemini: compileForGemini,
  'gemini-sdk': compileForGemini,
  qwen: compileForQwen,
  crush: compileForCrush,
  goose: compileForGoose,
  openrouter: compileForOpenRouter,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a normalized policy into provider-specific overrides for a single provider.
 *
 * @param providerId - The target provider
 * @param policy     - The normalized policy to compile
 * @returns Compiled overrides including config, input options, and guardrail hints
 */
export function compilePolicyForProvider(
  providerId: AdapterProviderId,
  policy: AdapterPolicy,
): CompiledPolicyOverrides {
  const compiler = PROVIDER_COMPILERS[providerId]
  return compiler(policy)
}

/**
 * Compile a normalized policy for all known providers.
 *
 * @param policy - The normalized policy to compile
 * @returns A map of provider ID to compiled overrides
 */
export function compilePolicyForAll(
  policy: AdapterPolicy,
): ReadonlyMap<AdapterProviderId, CompiledPolicyOverrides> {
  const result = new Map<AdapterProviderId, CompiledPolicyOverrides>()
  for (const [providerId, compiler] of Object.entries(PROVIDER_COMPILERS)) {
    result.set(providerId as AdapterProviderId, compiler(policy))
  }
  return result
}
