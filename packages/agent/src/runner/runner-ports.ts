import type {
  AgentItem,
  AgentBudgetState,
  AgentMessageItem,
  AgentRunEventEnvelope,
  AgentRunJsonValue,
  AgentRunStateV2,
  AgentPersistableContext,
  AgentToolCallItem,
} from '@dzupagent/agent-types/run'

export interface AgentRunnerInput {
  readonly agentId: string
  readonly behaviorDigest: string
  readonly items: readonly AgentItem[]
  readonly context?: AgentPersistableContext
  readonly budget?: AgentBudgetState
}

/**
 * Experimental compare-and-swap persistence for one canonical framework run
 * state. Target ownership is adapter-types, pending a layer-safe contract edge.
 */
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

/** Experimental ordered append-only evidence for canonical framework events. */
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

export interface AgentRunnerModelToolDescriptor {
  readonly toolId: string
  readonly toolRevision: string
  readonly effectClass: 'read'
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
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export interface AgentRunnerModelResult {
  readonly item: AgentMessageItem | AgentToolCallItem
  readonly usage?: AgentRunnerModelUsage
}

/**
 * One low-level model invocation. Queueing, leases, durable host status, and
 * provider credentials remain outside this framework port.
 */
export interface AgentRunnerModelPort {
  readonly adapterId: string
  invoke(request: AgentRunnerModelRequest): Promise<AgentRunnerModelResult>
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

/** Bounded R3 tool port: the executable slice admits read-only effects only. */
export interface AgentRunnerReadOnlyToolPort {
  readonly toolId: string
  readonly toolRevision: string
  readonly effectClass: 'read'
  execute(request: AgentRunnerReadOnlyToolRequest): Promise<AgentRunnerReadOnlyToolResult>
}
