/**
 * Provider failover/retry policy types for {@link DzupAgentConfig}.
 *
 * Extracted from the original `agent-types.ts` barrel — see that file for the
 * authoritative re-exports.
 */

import type { FallbackRequirements } from '@dzupagent/core/llm'

/**
 * How strictly the same-run failover chain is filtered against the run's
 * capability requirements (`DZUPAGENT-AGENT-C-06`).
 *
 * - `'declared'` (default): only model specs that actually declare a
 *   `capabilities` array are checked. A spec that declares nothing is allowed
 *   through, because an undeclared capability set is a config gap, not
 *   evidence of incapability. This makes the guard safe to enable by default
 *   on registries that never populated `capabilities`.
 * - `'strict'`: a spec that declares no `capabilities` fails any requirement
 *   (`unknown ≠ capable`). Recommended once the registry is fully annotated.
 * - `'off'`: no capability filtering — the pre-C-06 behaviour, where a
 *   tool-calling run could silently fail over to a model without tool calling.
 */
export type FailoverCapabilityGuard = 'off' | 'declared' | 'strict'

/**
 * Cross-vendor failover gate.
 *
 * - `'allow-all'` (default): any selectable provider in the tier chain may be
 *   used, matching the historical behaviour.
 * - `'allowlist'`: only the run's home provider plus the providers named in
 *   `approvedFallbackProviders` may be used. Mirrors the adapter layer's
 *   deny-by-default `approvedFallbackProviders` contract
 *   (`agent-adapters/src/registry/adapter-registry-helpers.ts`). Setting
 *   `approvedFallbackProviders` implies this mode.
 */
export type CrossVendorFallbackMode = 'allow-all' | 'allowlist'

/** Explicit run-level provider retry/failover policy. */
export interface ProviderFailoverPolicy {
  /** Enable invocation-time retry/failover. Defaults to false. */
  enabled?: boolean
  /**
   * Maximum provider attempts for one model turn. Defaults to 2 when enabled.
   * The value is capped by the number of selectable providers.
   */
  maxAttempts?: number
  /**
   * Retry after tool results are already present in the transcript.
   * Defaults to false to avoid duplicating side-effecting tool work.
   */
  allowRetryAfterToolResults?: boolean
  /**
   * Optional retry classifier. Defaults to the core transient-error detector.
   * Return false to surface the error without trying another provider.
   */
  shouldRetry?: (error: Error) => boolean

  /**
   * Capability guard mode for the failover chain. Defaults to `'declared'`.
   * See {@link FailoverCapabilityGuard}.
   */
  capabilityGuard?: FailoverCapabilityGuard

  /**
   * Additional capability / context-window requirements the host knows about
   * but the agent cannot derive on its own — most notably `'vision'` (the
   * failover chain is built before the run's messages are inspected) and an
   * explicit `minContextWindow`.
   *
   * Merged with the automatically derived requirements: tool-calling is
   * derived from the bound tool set, `minContextWindow` defaults to
   * `messageConfig.maxMessageTokens` when set here is absent.
   */
  capabilityRequirements?: FallbackRequirements

  /**
   * Cross-vendor gate. Defaults to `'allow-all'` for backward compatibility;
   * supplying `approvedFallbackProviders` switches it to `'allowlist'`.
   */
  crossVendorFallback?: CrossVendorFallbackMode

  /**
   * Providers this run may fail over to, in addition to its home provider.
   * Only consulted in `'allowlist'` mode. Every blocked hop emits a
   * `provider:fallback_blocked` event so the decision is auditable.
   */
  approvedFallbackProviders?: readonly string[]
}
