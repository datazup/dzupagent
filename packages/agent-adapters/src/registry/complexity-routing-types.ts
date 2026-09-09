import type {
  ExecutionRouteCostClass,
  ExecutionRoutePolicy,
} from '@dzupagent/runtime-contracts'
import type {
  AiExecutionOfferSnapshot,
  AiTaskRouteIdentity,
  AiTaskRoutingBinding,
} from '@dzupagent/runtime-contracts/ai-execution'

import type { RouteSelectionReceipt } from './deterministic-candidate-selector.js'

/** Host-assessed complexity. This policy does not call a model to classify tasks. */
export interface TaskComplexityProfile {
  readonly taskId: string
  readonly complexity: 'C0' | 'C1' | 'C2' | 'C3'
  readonly kind: 'implementation' | 'architecture' | 'security' | 'review'
  readonly requiredCapabilities: readonly string[]
  readonly contextTokens: number
  readonly outputTokens: number
  readonly maximumCostMicros: number
  readonly assessmentRef: string
}

export type TaskRouteIdentity = AiTaskRouteIdentity

/** Catalog evidence for one concrete, versioned provider/model/profile offer. */
export interface QualifiedTaskRoutingOffer {
  readonly offer: AiExecutionOfferSnapshot
  readonly providerFamily: string
  readonly qualification: {
    readonly evidenceRef: string
    readonly maximumComplexity: TaskComplexityProfile['complexity']
    readonly coding: 'fast' | 'strong'
  }
  /** Provider-native effort names with portable ordered levels: high is level 3. */
  readonly efforts: readonly { readonly name: string; readonly level: number }[]
  readonly contextWindowTokens: number
  readonly maximumOutputTokens: number
  readonly estimatedCostMicros: number
  readonly costClass: ExecutionRouteCostClass
  readonly estimatedLatencyMs: number
  readonly quota: {
    /** Stable accounting pool identity, shared by offers drawing the same quota. */
    readonly poolRef: string
    readonly available: boolean
    readonly remainingTokens: number
    readonly evidenceRef: string
    readonly checkedAt: string
  }
  readonly authAvailable: boolean
  readonly backendAvailable: boolean
  readonly modelAvailable: boolean
}

export interface TaskRoutingRequest {
  readonly schema: 'dzupagent.taskRoutingRequest/v1'
  readonly policyRevision: string
  readonly task: TaskComplexityProfile
  readonly offers: readonly QualifiedTaskRoutingOffer[]
  /** Preserves host policy constraints and transition approvals. */
  readonly policy: Omit<ExecutionRoutePolicy, 'candidates' | 'strategy' | 'preferenceOrder'>
  readonly decidedAt: string
  /** Host policy freshness limit for health and quota observations, in milliseconds. */
  readonly maxObservationAgeMs: number
  /** Required for a review task; effort/profile changes never establish independence. */
  readonly implementer?: TaskRouteIdentity
}

export interface SelectedTaskRoute {
  readonly offer: QualifiedTaskRoutingOffer
  readonly effort: string
  readonly policy: ExecutionRoutePolicy
  readonly receipt: RouteSelectionReceipt
}

export interface TaskRoutingDecision {
  readonly schema: 'dzupagent.taskRoutingDecision/v1'
  readonly request: TaskRoutingRequest
  readonly requiredCapabilities: readonly string[]
  readonly eligibility: readonly {
    readonly offerId: string
    readonly role: 'primary' | 'reviewer'
    readonly reasons: readonly string[]
  }[]
  readonly primary: SelectedTaskRoute
  /** Present only when this decision requires a separately routed reviewer. */
  readonly reviewer?: SelectedTaskRoute
  readonly reviewPolicy: AiTaskRoutingBinding['reviewPolicy']
  readonly decisionDigest: `sha256:${string}`
}
