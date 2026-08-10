/**
 * Draft, data-only contracts for the cohesive AgentRunner lifecycle.
 *
 * These types are deliberately JSON-safe and provider-neutral. They do not
 * make the current `DzupAgent.launch()` handle restartable or execution-
 * authoritative; runner and persistence ports will adopt them in later
 * packets.
 */

export const AGENT_RUN_EVENT_SCHEMA = 'dzupagent.run-event/v1' as const
export const AGENT_RUN_STATE_SCHEMA = 'dzupagent.agentRunState/v2' as const
export const AGENT_SESSION_SCHEMA = 'dzupagent.agentSession/v1' as const
export const AGENT_RUN_STATE_STABILITY = 'draft' as const

export type AgentRunJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentRunJsonValue[]
  | { readonly [key: string]: AgentRunJsonValue }

export type AgentRunJsonObject = Readonly<Record<string, AgentRunJsonValue>>

/** Opaque durable artifact identity. Raw bytes and unrestricted host paths stay outside run state. */
export interface AgentArtifactReference {
  readonly artifactId: string
  readonly mediaType?: string
  readonly byteLength?: number
  readonly digest?: string
}

/** Namespaced adapter-owned state. Values must remain JSON-safe and credential-free. */
export interface AgentAdapterReference {
  readonly namespace: string
  readonly schema: string
  readonly value: AgentRunJsonValue
}

export type AgentContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image'
      readonly source: AgentArtifactReference
      readonly detail?: 'auto' | 'low' | 'high'
    }
  | {
      readonly type: 'audio'
      readonly source: AgentArtifactReference
      readonly format?: string
    }
  | {
      readonly type: 'file'
      readonly source: AgentArtifactReference
      readonly mediaType?: string
      readonly name?: string
    }
  | { readonly type: 'reasoning-summary'; readonly text: string }
  | { readonly type: 'refusal'; readonly text: string }
  | {
      readonly type: 'extension'
      readonly namespace: string
      readonly value: AgentRunJsonValue
    }

export interface AgentMessageItem {
  readonly type: 'message'
  readonly itemId: string
  readonly role: 'system' | 'developer' | 'user' | 'assistant'
  readonly content: readonly AgentContentBlock[]
  readonly providerRef?: AgentAdapterReference
}

export interface AgentToolCallItem {
  readonly type: 'tool-call'
  readonly itemId: string
  readonly callId: string
  readonly toolId: string
  readonly arguments: AgentRunJsonValue
}

export interface AgentToolResultItem {
  readonly type: 'tool-result'
  readonly itemId: string
  readonly callId: string
  readonly output: AgentRunJsonValue | readonly AgentContentBlock[]
  readonly isError: boolean
}

export interface AgentHandoffItem {
  readonly type: 'handoff'
  readonly itemId: string
  readonly handoffId: string
  readonly sourceAgentId: string
  readonly targetAgentId: string
  readonly state: 'proposed' | 'authorized' | 'committed' | 'rejected'
  readonly invocationId?: string
}

export interface AgentGuardrailItem {
  readonly type: 'guardrail'
  readonly itemId: string
  readonly guardrailId: string
  readonly stage: 'input' | 'model-output' | 'tool-input' | 'tool-output' | 'handoff'
  readonly outcome: 'allow' | 'transform' | 'suspend' | 'reject'
  readonly summary?: string
}

export interface AgentInteractionItem {
  readonly type: 'interaction'
  readonly itemId: string
  readonly interactionId: string
  readonly generation: number
  readonly state: 'requested' | 'resolved' | 'expired'
}

export type AgentItem =
  | AgentMessageItem
  | AgentToolCallItem
  | AgentToolResultItem
  | AgentHandoffItem
  | AgentGuardrailItem
  | AgentInteractionItem

/** Reusable conversation history, independent of any one framework run. */
export interface AgentSessionSnapshot {
  readonly schema: typeof AGENT_SESSION_SCHEMA
  readonly sessionId: string
  readonly revision: string
  readonly items: readonly AgentItem[]
}

export interface AgentSessionBinding {
  readonly sessionId: string
  readonly baseRevision: string
  readonly transactionId?: string
}

/** Stable logical identity shared by retries and resume attempts. */
export interface AgentInvocationIdentity {
  readonly invocationId: string
  readonly callId: string
  readonly attempt: number
  readonly inputDigest: string
  readonly effectKey?: string
  readonly parentInvocationId?: string
  readonly resultDigest?: string
}

export type AgentToolEffectClass = 'read' | 'reversible-write' | 'irreversible-write' | 'external'

export type AgentToolInvocationStatus =
  | 'planned'
  | 'approval-required'
  | 'approved'
  | 'started'
  | 'completed'
  | 'failed-before-effect'
  | 'effect-unknown'
  | 'rejected'

export interface AgentToolInvocationState extends AgentInvocationIdentity {
  readonly toolId: string
  readonly toolRevision: string
  readonly effectClass: AgentToolEffectClass
  readonly idempotencyKey?: string
  readonly state: AgentToolInvocationStatus
  readonly completionEvidence?: AgentRunJsonValue
}

export interface AgentPrincipalReference {
  readonly principalId: string
  readonly principalType: 'user' | 'service' | 'agent' | 'host'
}

export interface AgentPendingInteraction {
  readonly interactionId: string
  readonly generation: number
  readonly kind: 'tool-approval' | 'clarification' | 'confirmation' | 'custom'
  readonly stateRevision: number
  readonly request: AgentRunJsonValue
  readonly requestDigest: string
  readonly invocationId?: string
  readonly requestedBy: AgentPrincipalReference
  readonly decisionPolicyRef: string
  readonly decisionPolicyRevision: string
  readonly expiresAt?: string
}

export type AgentInteractionDecisionOutcome = 'approved' | 'rejected'

/** Host-authorized decision evidence bound to one exact suspended interaction. */
export interface AgentInteractionDecisionInput {
  readonly interactionId: string
  readonly generation: number
  readonly requestDigest: string
  readonly stateRevision: number
  readonly decision: AgentInteractionDecisionOutcome
  readonly decisionPolicyRef: string
  readonly decisionPolicyRevision: string
  readonly actor: AgentPrincipalReference
}

/** Durable form of a decision after the runner commits it exactly once. */
export interface AgentInteractionDecisionRecord extends AgentInteractionDecisionInput {
  readonly invocationId: string
  readonly decidedAt: string
}

export interface AgentHandoffState {
  readonly handoffId: string
  readonly invocationId: string
  readonly sourceAgentId: string
  readonly targetAgentId: string
  readonly state: 'proposed' | 'authorized' | 'committed' | 'rejected'
  readonly inputDigest: string
}

export interface AgentUsageRecord {
  readonly usageId: string
  readonly source: 'model' | 'tool' | 'host'
  readonly accountingSource: string
  readonly invocationId?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly cost?: {
    readonly currency: string
    readonly minorUnits: string
  }
  readonly recordedAt: string
}

export interface AgentUsageLedger {
  readonly records: readonly AgentUsageRecord[]
}

export interface AgentBudgetState {
  readonly policyRef: string
  readonly policyRevision: string
  readonly status: 'within-limit' | 'soft-limit-reached' | 'hard-limit-reached'
  readonly limits: AgentRunJsonObject
  readonly consumed: AgentRunJsonObject
}

export type AgentPersistableContext<TContext extends AgentRunJsonValue = AgentRunJsonValue> =
  | { readonly state: 'absent' }
  | {
      readonly state: 'included'
      readonly schema: string
      readonly value: TContext
    }
  | { readonly state: 'reference'; readonly reference: AgentAdapterReference }

export interface AgentSandboxSessionReference {
  readonly sandboxId: string
  readonly manifestDigest: string
  readonly snapshotId?: string
}

/**
 * Draft v2 state contract. The experimental in-memory runner proves exact read
 * approval resume and transactional session binding; durable adapters and
 * effectful tools require separate conformance.
 */
export interface AgentRunStateV2<TContext extends AgentRunJsonValue = AgentRunJsonValue> {
  readonly schema: typeof AGENT_RUN_STATE_SCHEMA
  readonly runId: string
  readonly revision: number
  readonly status:
    | 'created'
    | 'running'
    | 'suspending'
    | 'suspended'
    | 'completed'
    | 'failed'
    | 'cancelled'
  readonly agent: {
    readonly initialAgentId: string
    readonly currentAgentId: string
    readonly behaviorDigest: string
  }
  readonly attempt: { readonly number: number; readonly startedAt: string }
  readonly input: readonly AgentItem[]
  readonly committedItems: readonly AgentItem[]
  readonly nextEventSeq: number
  readonly invocations: readonly AgentToolInvocationState[]
  readonly interactions: readonly AgentPendingInteraction[]
  readonly interactionDecisions: readonly AgentInteractionDecisionRecord[]
  readonly handoffs: readonly AgentHandoffState[]
  readonly usage: AgentUsageLedger
  readonly budget: AgentBudgetState
  readonly context: AgentPersistableContext<TContext>
  readonly sessionBinding?: AgentSessionBinding
  readonly adapterState?: Readonly<Record<string, AgentAdapterReference>>
  readonly sandboxRef?: AgentSandboxSessionReference
  readonly createdAt: string
  readonly updatedAt: string
}

export type AgentRunStateMigrationResult<TContext extends AgentRunJsonValue = AgentRunJsonValue> =
  | {
      readonly status: 'migrated'
      readonly sourceSchema: string
      readonly state: AgentRunStateV2<TContext>
    }
  | { readonly status: 'unsupported-newer'; readonly sourceSchema: string }
  | { readonly status: 'invalid'; readonly reason: string }
  | {
      readonly status: 'behavior-mismatch'
      readonly expectedBehaviorDigest: string
      readonly actualBehaviorDigest: string
    }

export type AgentRunEventType =
  | 'run.started'
  | 'run.suspended'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'agent.activated'
  | 'agent.deactivated'
  | 'model.requested'
  | 'model.delta'
  | 'model.completed'
  | 'model.failed'
  | 'item.added'
  | 'item.updated'
  | 'handoff.proposed'
  | 'handoff.authorized'
  | 'handoff.committed'
  | 'handoff.rejected'
  | 'tool.selected'
  | 'tool.authorization_requested'
  | 'tool.started'
  | 'tool.output_delta'
  | 'tool.completed'
  | 'tool.failed'
  | 'guardrail.evaluated'
  | 'interaction.requested'
  | 'interaction.resolved'
  | 'interaction.expired'
  | 'usage.recorded'
  | 'budget.updated'
  | 'session.commit_requested'
  | 'session.committed'
  | 'session.conflicted'

export interface AgentRunEventEnvelope<
  TType extends AgentRunEventType = AgentRunEventType,
  TPayload extends AgentRunJsonValue = AgentRunJsonValue,
> {
  readonly schema: typeof AGENT_RUN_EVENT_SCHEMA
  readonly runId: string
  readonly eventId: string
  readonly sequence: number
  readonly stateRevision: number
  readonly attempt: number
  readonly occurredAt: string
  readonly type: TType
  readonly payload: TPayload
  readonly traceRef?: string
}
