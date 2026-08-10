import type {
  AgentItem,
  AgentBudgetState,
  AgentInteractionDecisionInput,
  AgentMessageItem,
  AgentPrincipalReference,
  AgentRunEventEnvelope,
  AgentRunJsonValue,
  AgentRunStateV2,
  AgentSessionSnapshot,
  AgentPersistableContext,
  AgentToolCallItem,
} from '@dzupagent/agent-types/run'

export interface AgentRunnerInput {
  readonly agentId: string
  readonly behaviorDigest: string
  readonly items: readonly AgentItem[]
  readonly sessionId?: string
  readonly context?: AgentPersistableContext
  readonly budget?: AgentBudgetState
}

export interface AgentRunnerResumeInput {
  readonly runId: string
  readonly behaviorDigest: string
  readonly decision: AgentInteractionDecisionInput
}

export const AGENT_RUNNER_PERSISTENCE_PORT_VERSION = '0.1.0' as const

/** Experimental CAS run-state store */
export interface AgentRunStore {
  load(runId: string): Promise<AgentRunStateV2 | undefined>
  create(state: AgentRunStateV2): Promise<AgentRunStoreCreateResult>
  compareAndSwap(
    runId: string,
    expectedRevision: number,
    nextState: AgentRunStateV2,
  ): Promise<AgentRunStoreCompareAndSwapResult>
}

export type AgentRunStoreCreateResult =
  | { readonly status: 'created'; readonly state: AgentRunStateV2 }
  | {
      readonly status: 'already-exists'
      readonly runId: string
      readonly actualRevision: number
    }

export type AgentRunStoreCompareAndSwapResult =
  | { readonly status: 'updated'; readonly state: AgentRunStateV2 }
  | { readonly status: 'not-found'; readonly runId: string }
  | {
      readonly status: 'revision-conflict'
      readonly runId: string
      readonly expectedRevision: number
      readonly actualRevision: number
    }
  | {
      readonly status: 'invalid-transition'
      readonly runId: string
      readonly reason: 'revision-not-successor' | 'run-id-mismatch'
    }

/** Experimental append-only event journal */
export interface AgentEventJournal {
  append(event: AgentRunEventEnvelope): Promise<AgentEventJournalAppendResult>
  read(runId: string): Promise<readonly AgentRunEventEnvelope[]>
}

export type AgentEventJournalAppendResult =
  | { readonly status: 'appended'; readonly event: AgentRunEventEnvelope }
  | {
      readonly status: 'sequence-conflict'
      readonly runId: string
      readonly attemptedSequence: number
      readonly expectedSequence: number
    }
  | {
      readonly status: 'event-id-conflict'
      readonly eventId: string
      readonly existingRunId: string
      readonly existingSequence: number
    }

/**
 * Experimental atomic state-and-event seam used by exact in-memory resume.
 * Durable adapters must provide equivalent atomicity or recoverable idempotency.
 */
export interface AgentRunnerPersistence {
  createRun(state: AgentRunStateV2): Promise<AgentRunStoreCreateResult>
  loadRun(runId: string): Promise<AgentRunStateV2 | undefined>
  readEvents(runId: string): Promise<readonly AgentRunEventEnvelope[]>
  beginSessionTransaction(
    input: AgentRunnerSessionBeginInput,
  ): Promise<AgentRunnerSessionBeginResult>
  loadSessionTransaction(
    transactionId: string,
  ): Promise<AgentRunnerSessionTransaction | undefined>
  commitSessionTransaction(
    input: AgentRunnerSessionCommitInput,
  ): Promise<AgentRunnerSessionCommitResult>
  abortSessionTransaction(
    transactionId: string,
  ): Promise<AgentRunnerSessionAbortResult>
  commitTransition(
    transition: AgentRunnerPersistenceTransition,
  ): Promise<AgentRunnerPersistenceCommitResult>
}

export interface AgentRunnerPersistenceTransition {
  readonly runId: string
  readonly expectedRevision: number
  readonly nextState: AgentRunStateV2
  readonly event: AgentRunEventEnvelope
}

export type AgentRunnerPersistenceCommitResult =
  | {
      readonly status: 'committed'
      readonly state: AgentRunStateV2
      readonly event: AgentRunEventEnvelope
    }
  | { readonly status: 'run-not-found'; readonly runId: string }
  | {
      readonly status: 'revision-conflict'
      readonly runId: string
      readonly expectedRevision: number
      readonly actualRevision: number
    }
  | {
      readonly status: 'invalid-transition'
      readonly reason:
        | 'run-id-mismatch'
        | 'revision-not-successor'
        | 'state-event-revision-mismatch'
        | 'state-event-sequence-mismatch'
    }
  | {
      readonly status: 'event-sequence-conflict'
      readonly attemptedSequence: number
      readonly expectedSequence: number
    }
  | {
      readonly status: 'event-id-conflict'
      readonly eventId: string
      readonly existingRunId: string
      readonly existingSequence: number
    }
  | { readonly status: 'injected-failure'; readonly phase: 'state' | 'journal' }

export type AgentRunnerSessionErrorCode =
  | 'injected-failure'
  | 'invalid-session'
  | 'revision-conflict'
  | 'session-not-found'
  | 'transaction-closed'
  | 'transaction-content-conflict'
  | 'transaction-id-conflict'
  | 'transaction-not-found'

export interface AgentRunnerSessionTransaction {
  readonly sessionId: string
  readonly transactionId: string
  readonly baseRevision: string
  readonly stagedInput: readonly AgentItem[]
  readonly status: 'open' | 'committed' | 'aborted'
  readonly baseSnapshot: AgentSessionSnapshot
  readonly finalDigest?: string
  readonly committedRevision?: string
  readonly committedSnapshot?: AgentSessionSnapshot
}

export interface AgentRunnerSessionBeginInput {
  readonly sessionId: string
  readonly transactionId: string
  readonly stagedInput: readonly AgentItem[]
}

export type AgentRunnerSessionBeginResult =
  | {
      readonly status: 'opened' | 'already-open'
      readonly snapshot: AgentSessionSnapshot
      readonly transaction: AgentRunnerSessionTransaction
    }
  | { readonly status: 'rejected'; readonly code: AgentRunnerSessionErrorCode }

export interface AgentRunnerSessionCommitInput {
  readonly sessionId: string
  readonly transactionId: string
  readonly baseRevision: string
  readonly items: readonly AgentItem[]
}

export type AgentRunnerSessionCommitResult =
  | {
      readonly status: 'committed' | 'already-committed'
      readonly snapshot: AgentSessionSnapshot
    }
  | {
      readonly status: 'rejected'
      readonly code: AgentRunnerSessionErrorCode
      readonly actualRevision?: string
    }

export type AgentRunnerSessionAbortResult =
  | { readonly status: 'aborted' | 'already-aborted' }
  | { readonly status: 'rejected'; readonly code: AgentRunnerSessionErrorCode }

export interface AgentRunnerToolApprovalRequirement {
  readonly requestedBy: AgentPrincipalReference
  readonly decisionPolicyRef: string
  readonly decisionPolicyRevision: string
  readonly expiresAt?: string
}

export interface AgentRunnerModelToolDescriptor {
  readonly toolId: string
  readonly toolRevision: string
  readonly effectClass: 'read'
  readonly description?: string
  readonly inputSchema?: AgentRunJsonValue
}

export interface AgentRunnerModelRequest {
  readonly runId: string
  readonly requestId: string
  readonly attempt: number
  readonly turn: number
  readonly agentId: string
  readonly input: readonly AgentItem[]
  readonly committedItems: readonly AgentItem[]
  readonly tools: readonly AgentRunnerModelToolDescriptor[]
}

export interface AgentRunnerModelUsage {
  readonly accountingSource: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

export type AgentRunnerModelFinishReason =
  | 'stop'
  | 'tool-calls'
  | 'length'
  | 'content-filter'
  | 'cancelled'
  | 'error'
  | 'unknown'

export type AgentRunnerProviderErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'rate-limit'
  | 'timeout'
  | 'invalid-request'
  | 'unavailable'
  | 'content-filter'
  | 'cancelled'
  | 'internal'
  | 'unknown'

export type AgentRunnerRetryClassification =
  | 'retryable'
  | 'non-retryable'
  | 'reconciliation-required'

export interface AgentRunnerModelResult {
  readonly status?: 'completed'
  readonly item: AgentMessageItem | AgentToolCallItem
  /**
   * Additional ordered items emitted by the same assistant turn. The current
   * scheduler fails closed if this is non-empty until multi-call execution is
   * separately admitted; conversion adapters may still retain the full turn.
   */
  readonly additionalItems?: readonly (AgentMessageItem | AgentToolCallItem)[]
  readonly usage?: AgentRunnerModelUsage
  readonly finishReason?: AgentRunnerModelFinishReason
}

export interface AgentRunnerModelFailure {
  readonly status: 'failed-before-dispatch' | 'outcome-unknown'
  readonly code: string
  readonly category: AgentRunnerProviderErrorCategory
  readonly retryClassification: AgentRunnerRetryClassification
}

export type AgentRunnerModelInvocationResult = AgentRunnerModelResult | AgentRunnerModelFailure

/** Low-level model invocation; host lifecycle and credentials stay outside. */
export interface AgentRunnerModelPort {
  readonly adapterId: string
  invoke(request: AgentRunnerModelRequest): Promise<AgentRunnerModelInvocationResult>
}

export interface AgentRunnerReadOnlyToolRequest {
  readonly runId: string
  readonly invocationId: string
  readonly callId: string
  readonly attempt: number
  readonly input: AgentRunJsonValue
}

export type AgentRunnerReadOnlyToolResult =
  | {
      readonly status: 'completed'
      readonly output: AgentRunJsonValue
      readonly completionEvidence?: AgentRunJsonValue
    }
  | {
      readonly status: 'failed-before-effect'
      readonly code: string
      readonly retryable: boolean
    }

export interface AgentRunnerReadOnlyToolPort {
  readonly toolId: string
  readonly toolRevision: string
  readonly effectClass: 'read'
  readonly description?: string
  readonly inputSchema?: AgentRunJsonValue
  readonly approval?: AgentRunnerToolApprovalRequirement | undefined
  execute(request: AgentRunnerReadOnlyToolRequest): Promise<AgentRunnerReadOnlyToolResult>
}
