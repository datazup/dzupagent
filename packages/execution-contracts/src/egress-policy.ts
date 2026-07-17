/**
 * Default-deny network egress policy for execution isolation.
 *
 * Grants are provider-label pairs only — no raw URLs, credentials, paths, or
 * payloads appear in records. All traffic is denied unless an explicit grant
 * covers the provider.
 */

import type { EgressGrant } from './resource-policy.js'

export type EgressDecision = 'allow' | 'deny'

export interface EgressRecord {
  decision: EgressDecision
  /** Stable provider identifier — never a raw URL. */
  provider: string
  /** Human-readable label from the matching grant, or 'unlabeled' for denials. */
  label: string
  /** ISO 8601 timestamp. */
  timestamp: string
}

export class EgressPolicy {
  private readonly grants: Map<string, string>
  private readonly records: EgressRecord[] = []

  constructor(grants: EgressGrant[]) {
    this.grants = new Map(grants.map((g) => [g.provider, g.label]))
  }

  /**
   * Check whether the named provider is explicitly granted.
   * Default deny — returns 'deny' for any provider not in the grant list.
   */
  check(provider: string): EgressDecision {
    return this.grants.has(provider) ? 'allow' : 'deny'
  }

  /**
   * Record an egress decision. Produces a sanitized log entry — no URLs,
   * credentials, or raw command payloads.
   */
  record(decision: EgressDecision, provider: string, timestamp?: string): EgressRecord {
    const entry: EgressRecord = {
      decision,
      provider,
      label: decision === 'allow' ? (this.grants.get(provider) ?? 'unlabeled') : 'denied',
      timestamp: timestamp ?? new Date().toISOString(),
    }
    this.records.push(entry)
    return entry
  }

  /**
   * Check and record in one call. Returns the decision.
   */
  checkAndRecord(provider: string, timestamp?: string): EgressDecision {
    const decision = this.check(provider)
    this.record(decision, provider, timestamp)
    return decision
  }

  /** Return all sanitized egress records accumulated so far. */
  getRecords(): Readonly<EgressRecord[]> {
    return this.records
  }

  /** Number of allow decisions recorded. */
  get allowCount(): number {
    return this.records.filter((r) => r.decision === 'allow').length
  }

  /** Number of deny decisions recorded. */
  get denyCount(): number {
    return this.records.filter((r) => r.decision === 'deny').length
  }
}

/**
 * Build an EgressPolicy from a ResourcePolicy's egressGrants list.
 */
export function createEgressPolicy(grants: EgressGrant[]): EgressPolicy {
  return new EgressPolicy(grants)
}
