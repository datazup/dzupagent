/**
 * Neutral enforcement-driver port for execution isolation.
 *
 * Callers implement this interface; the execution-contracts package
 * only defines the contract — never the OS-level implementation.
 *
 * A host that cannot apply an enforcement mechanism MUST return
 * EnforcementResult.unavailable — never a simulated success.
 */

import type { ResourcePolicy } from './resource-policy.js'
import type { HostCapabilities } from './host-capabilities.js'

/** Outcome of applying or releasing a single enforcement dimension. */
export type EnforcementOutcome = 'applied' | 'unavailable' | 'failed'

export interface EnforcementResult {
  /** Which dimension was attempted (e.g. 'cgroup', 'ulimit', 'process-group'). */
  dimension: string
  outcome: EnforcementOutcome
  /** Short human-readable detail (no paths, credentials, or internal IDs). */
  detail?: string
}

export interface ApplyEnforcementParams {
  executionId: string
  policy: ResourcePolicy
  capabilities: HostCapabilities
}

export interface ReleaseEnforcementParams {
  executionId: string
  /** Whether the execution was forcibly terminated before natural exit. */
  forciblyTerminated: boolean
}

/**
 * Enforcement driver port. Implementations apply host-level isolation
 * (cgroup, namespace, ulimit, process-group) for a single execution scope.
 *
 * Implementations MUST:
 * - Return 'unavailable' for any dimension the host does not support
 * - Never return 'applied' unless the enforcement was actually verified
 * - Never store credentials, URLs, or product scope
 */
export interface IEnforcementDriver {
  /**
   * Apply enforcement for the given execution scope.
   * Called once when the execution begins.
   */
  apply(params: ApplyEnforcementParams): Promise<EnforcementResult[]>

  /**
   * Release enforcement for the given execution scope.
   * Called once when the execution ends (naturally or forcibly).
   */
  release(params: ReleaseEnforcementParams): Promise<EnforcementResult[]>
}

/**
 * An enforcement driver for hosts that do not support any OS-level enforcement.
 * Always returns 'unavailable' — never claims to have enforced anything.
 */
export class UnsupportedEnforcementDriver implements IEnforcementDriver {
  async apply(_params: ApplyEnforcementParams): Promise<EnforcementResult[]> {
    return [
      {
        dimension: 'cgroup',
        outcome: 'unavailable',
        detail: 'host does not support cgroups-v2',
      },
      {
        dimension: 'namespace',
        outcome: 'unavailable',
        detail: 'host does not support user namespaces',
      },
      {
        dimension: 'ulimit',
        outcome: 'unavailable',
        detail: 'host does not support ulimit enforcement',
      },
      {
        dimension: 'process-group',
        outcome: 'unavailable',
        detail: 'host does not support process groups',
      },
    ]
  }

  async release(
    _params: ReleaseEnforcementParams,
  ): Promise<EnforcementResult[]> {
    return [
      { dimension: 'cgroup', outcome: 'unavailable' },
      { dimension: 'namespace', outcome: 'unavailable' },
      { dimension: 'ulimit', outcome: 'unavailable' },
      { dimension: 'process-group', outcome: 'unavailable' },
    ]
  }
}
