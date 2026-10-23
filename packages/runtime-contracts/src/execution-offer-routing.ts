/** Operational evidence complements, rather than replaces, AiExecutionOfferSnapshot. */
export const EXECUTION_OFFER_ROUTING_SCHEMA = 'dzupagent.executionOfferRouting/v1' as const

export type RoutingObservation = {
  readonly unit: 'tokens' | 'percent' | 'slots' | 'ms' | 'score' | 'micros'
  readonly observedAt: string
  readonly expiresAt: string
  readonly provenance: string
  readonly confidence: number
} & (
  | { readonly state: 'known'; readonly value: number }
  | { readonly state: 'unknown'; readonly reason: string }
)

/** Counts include all providers sharing this resource, including queued commitments. */
export interface RoutingCapacity {
  readonly running: RoutingObservation
  readonly queued: RoutingObservation
  readonly reserved: RoutingObservation
  readonly limit: RoutingObservation
  readonly reviewHeadroom: RoutingObservation
}

export interface ExecutionOfferOperations {
  readonly offerId: string
  readonly principal: string
  readonly account: string
  readonly host: string
  readonly quotaPool: string
  readonly stages: readonly string[]
  readonly authorityRef: string
  readonly allowed: boolean
  readonly principalCapacity: RoutingCapacity
  readonly accountCapacity: RoutingCapacity
  readonly hostCapacity: RoutingCapacity
  readonly quota: {
    readonly remaining: RoutingObservation
    readonly committed: RoutingObservation
    readonly reviewHeadroom: RoutingObservation
  }
  readonly quality: RoutingObservation
  readonly continuity: RoutingObservation
  readonly fairness: RoutingObservation
  readonly completion: {
    readonly queue: RoutingObservation
    readonly execution: RoutingObservation
    readonly transfer: RoutingObservation
    readonly validation: RoutingObservation
    readonly review: RoutingObservation
  }
  /** A restored pool admits only this bounded number of NEW assignments. */
  readonly recovery?: {
    readonly restoredAt: string
    readonly admitted: RoutingObservation
    readonly limit: RoutingObservation
  }
}

export interface ExecutionOfferRoutingPolicy {
  readonly revision: string
  readonly maxObservationAgeMs: number
  readonly minimumConfidence: number
  readonly maximumCompletionMs: number
  /** Strict by default. Conservative ranking gives uncertain soft facts no credit. */
  readonly rankingEvidence?: 'strict' | 'conservative'
  readonly weights: {
    readonly quality: number
    readonly completion: number
    readonly continuity: number
    readonly cost: number
    readonly fairness: number
  }
  /** Host configuration, not framework provider enumeration. */
  readonly preferredLocal?: {
    readonly provider: string
    readonly model: string
    readonly effort: string
  }
}

export interface ExecutionTaskAssignment {
  readonly taskId: string
  readonly stage: string
  readonly generation: number
  readonly ownerOfferId: string
  readonly state: 'queued' | 'checkpointed' | 'running' | 'unknown-dispatch' | 'partial-writes'
  readonly sourceRef: string
  readonly recoveryRef: string
}

export interface ExecutionOfferRanking {
  readonly offerId: string
  readonly score: number
  /** A policy penalty, not a duration observation, when completionBasis says so. */
  readonly completionMs: number
  /** Present in conservative mode; original observations remain in the request. */
  readonly completionBasis?: 'qualified-evidence' | 'policy-penalty'
  readonly uncertainty?: readonly string[]
  readonly reservedCostMicros: number
  readonly effort: string
  readonly localPreference: boolean
}

/** Atomic at the host: assignment CAS AND shared pool/principal/account/host admission. */
export interface ExecutionOfferReservationPort {
  reserve(input: {
    readonly key: string
    readonly taskId: string
    readonly expectedGeneration: number
    readonly expectedSourceOfferId: string
    readonly currency: string
    readonly decisionDigest: string
    readonly observationDigest: string
    readonly offerId: string
    readonly reviewerOfferId?: string
    readonly expiresAfterMs: number
    /** Aggregate these together, including repeated hosts/pools, in the same CAS. */
    readonly allocations: readonly {
      readonly offerId: string
      readonly principal: string
      readonly account: string
      readonly host: string
      readonly quotaPool: string
      readonly slots: 1
      readonly tokens: number
      readonly costMicros: number
      readonly recoveryAdmission: boolean
    }[]
  }): Promise<ExecutionOfferReservation | null>
  /** Must reject expired/changed/previously consumed holds and stale assignment generations. */
  confirm(input: ExecutionOfferReservation): Promise<{ readonly accepted: boolean; readonly handoffId?: string }>
}

export interface ExecutionOfferReservation {
  readonly id: string
  readonly key: string
  readonly offerId: string
  readonly reviewerOfferId?: string
  readonly generation: number
  readonly observationDigest: string
  readonly decisionDigest: string
  readonly expiresAt: string
}

export interface ExecutionOfferHandoff {
  readonly schema: typeof EXECUTION_OFFER_ROUTING_SCHEMA
  readonly handoffId: string
  readonly taskId: string
  readonly stage: string
  readonly sourceRef: string
  readonly recoveryRef: string
  readonly sourceDisposition: 'retain-until-destination-ack'
  readonly reservation: ExecutionOfferReservation
  readonly provider: string
  readonly offerId: string
  readonly offerRevision: string
  readonly profileRef: string
  readonly principal: string
  readonly account: string
  readonly host: string
  readonly quotaPool: string
  readonly model: string
  readonly effort: string
  readonly policyRevision: string
  readonly inputDigest: string
  readonly decisionDigest: string
  readonly nextAction: 'destination-admission-required'
}

/** Shape validation is deliberately independent of Node, adapters and wall clock. */
export function validateRoutingObservation(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object') return ['OBSERVATION_INVALID']
  const v = value as Record<string, unknown>
  const date = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s))
  if (!['tokens', 'percent', 'slots', 'ms', 'score', 'micros'].includes(String(v.unit)) ||
      !date(v.observedAt) || !date(v.expiresAt) || Date.parse(v.expiresAt) <= Date.parse(v.observedAt) ||
      typeof v.provenance !== 'string' || !v.provenance.trim() ||
      typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) return ['OBSERVATION_INVALID']
  if (v.state === 'unknown') return typeof v.reason === 'string' && v.reason.trim() && !Object.hasOwn(v, 'value') ? [] : ['OBSERVATION_INVALID']
  if (v.state !== 'known' || typeof v.value !== 'number' || !Number.isFinite(v.value) || v.value < 0 ||
      (v.unit === 'score' && v.value > 1) || (v.unit === 'percent' && v.value > 100) ||
      (['tokens', 'slots', 'micros'].includes(String(v.unit)) && !Number.isSafeInteger(v.value))) return ['OBSERVATION_INVALID']
  return []
}
