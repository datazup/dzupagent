import type { TokenUsage } from './execution.js'
import type { AdapterProviderId } from './provider.js'

/**
 * A raw provider event persisted verbatim to `.dzupagent/runs/<runId>/raw-events.jsonl`.
 * The `payload` is the unmodified SDK/CLI output — shape varies per provider.
 */
export interface RawAgentEvent {
  providerId: AdapterProviderId
  runId: string
  /** Session ID, if available at the time of the event */
  sessionId?: string | undefined
  /** Stable event identifier assigned by the adapter when available */
  providerEventId?: string | undefined
  /** Parent provider event identifier when a hierarchy is known */
  parentProviderEventId?: string | undefined
  /** Monotonic epoch-ms timestamp */
  timestamp: number
  /** Where the raw event originated */
  source: 'stdout' | 'stderr' | 'sdk' | 'ipc'
  /** Unmodified provider payload */
  payload: unknown
  /** Correlation ID propagated from the originating request */
  correlationId?: string | undefined
}

/**
 * An artifact mutation event — created when an adapter writes, updates, or
 * removes a file under the run directory (transcripts, checkpoints, outputs…).
 */
export interface AgentArtifactEvent {
  runId: string
  providerId: AdapterProviderId
  timestamp: number
  /** Classifier for downstream tooling */
  artifactType: 'transcript' | 'checkpoint' | 'output' | 'log' | 'other'
  /** Absolute filesystem path of the artifact */
  path: string
  /** Mutation kind */
  action: 'created' | 'updated' | 'deleted'
  /** Optional provider-specific metadata */
  metadata?: Record<string, unknown> | undefined
  correlationId?: string | undefined
}

/** Kinds of governance-plane events emitted alongside the unified AgentEvent stream. */
export type GovernanceEventKind =
  | 'governance:approval_requested'
  | 'governance:approval_resolved'
  | 'governance:hook_executed'
  | 'governance:rule_violation'
  | 'governance:dangerous_command'

/**
 * Governance events are emitted on a side-channel parallel to `AgentEvent`.
 * They surface approval/authorization decisions, hook executions, rule
 * violations, and dangerous-command detections so the host can audit, alert,
 * or replay governance decisions independently of normal adapter output.
 */
export type GovernanceEvent =
  | {
      type: 'governance:approval_requested'
      runId: string
      sessionId?: string
      interactionId: string
      providerId: string
      timestamp: number
      prompt: string
      commandPreview?: string
    }
  | {
      type: 'governance:approval_resolved'
      runId: string
      sessionId?: string
      interactionId: string
      providerId: string
      timestamp: number
      resolution: 'approved' | 'denied' | 'auto'
    }
  | {
      type: 'governance:hook_executed'
      runId: string
      sessionId?: string
      providerId: string
      timestamp: number
      hookName: string
      exitCode?: number
    }
  | {
      type: 'governance:rule_violation'
      runId: string
      sessionId?: string
      providerId: string
      timestamp: number
      ruleId: string
      severity: 'warn' | 'block'
      detail: string
    }
  | {
      type: 'governance:dangerous_command'
      runId: string
      sessionId?: string
      providerId: string
      timestamp: number
      command: string
      blocked: boolean
    }

/** Terminal status for a completed run */
export type RunStatus = 'completed' | 'failed' | 'cancelled'

/**
 * Summary record written to `.dzupagent/runs/<runId>/summary.json` when the
 * store is closed. Aggregates high-level run statistics.
 */
export interface RunSummary {
  runId: string
  providerId: AdapterProviderId
  /** Session ID, if one was assigned by the provider */
  sessionId?: string | undefined
  startedAt: number
  completedAt: number
  durationMs: number
  toolCallCount: number
  artifactCount: number
  tokenUsage?: TokenUsage | undefined
  /** Populated when status === 'failed' */
  errorMessage?: string | undefined
  status: RunStatus
  correlationId?: string | undefined
}
