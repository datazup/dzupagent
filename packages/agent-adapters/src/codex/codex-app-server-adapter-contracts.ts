import type {
  ProviderSessionAttemptBinding,
  ProviderSessionOperationResult,
} from '@dzupagent/runtime-contracts/provider-session'

import type { AdapterConfig } from '../types.js'
import {
  CodexAppServerClientError,
  type CodexAppServerClientDependencies,
  type CodexAppServerClientLimits,
  type CodexAppServerSpawn,
  type CodexAppServerStdioClient,
} from './codex-app-server-client.js'
import type { ResolvedProbeExecutable } from '../introspection/index.js'

export type InterruptTurnResult = ProviderSessionOperationResult & {
  readonly kind: 'interrupt-turn'
}

export interface CodexAppServerAdapterOptions extends AdapterConfig {
  readonly attemptBinding: ProviderSessionAttemptBinding
  /** Private identity used for observation and requalified immediately before spawn. */
  readonly executable: ResolvedProbeExecutable
  readonly clientLimits?: CodexAppServerClientLimits | undefined
  /** Tight interrupt acknowledgement grace, separate from ordinary RPC timeouts. */
  readonly interruptGraceMs?: number | undefined
  readonly dependencies?: {
    readonly spawn?: CodexAppServerSpawn | undefined
    readonly now?: (() => number) | undefined
    readonly monotonicNow?: (() => number) | undefined
    readonly realpath?: CodexAppServerClientDependencies['realpath']
    readonly stat?: CodexAppServerClientDependencies['stat']
    readonly access?: CodexAppServerClientDependencies['access']
    readonly digestArtifact?: CodexAppServerClientDependencies['digestArtifact']
  } | undefined
}

/**
 * A decision the adapter reaches on its own -- cancellation or deadline expiry --
 * as opposed to an outcome the provider reported. Once recorded it is
 * authoritative: a later success frame cannot overturn it, which is why it is
 * latched on the lifecycle rather than recomputed at emission time.
 */
export interface LocalTerminalDecision {
  readonly code: 'CODEX_APP_SERVER_CANCELLED' | 'CODEX_APP_SERVER_EXECUTION_TIMEOUT'
  readonly message: string
}

export interface RunLifecycle {
  readonly deadline: number
  terminalDecision?: LocalTerminalDecision | undefined
}

export interface RunningExecution {
  cancel(): void
}

export interface ActiveRun {
  readonly client: CodexAppServerStdioClient
  readonly threadId: string
  readonly turnId: string
  readonly timeoutMs: number
  readonly lifecycle: RunLifecycle
  interruptPromise?: Promise<void> | undefined
}

export const REQUIRED_BASE_CAPABILITIES = [
  'execute',
  'resume',
  'cancel',
  'stream',
  'usage',
] as const
export const MAX_PROMPT_LENGTH = 1_000_000
export const MAX_REFERENCE_LENGTH = 512
export const MAX_RESULT_LENGTH = 2_000_000
export const MAX_DELTA_LENGTH = 512_000
export const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000
export const MAX_EXECUTION_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_INTERRUPT_GRACE_MS = 250
export const MAX_INTERRUPT_GRACE_MS = DEFAULT_INTERRUPT_GRACE_MS

/**
 * The exhaustive set of provider-initiated requests that map to a host-visible
 * interaction. It is an allow-list rather than a deny-list because an
 * unrecognised request must fail the turn: answering one the adapter does not
 * understand would let the provider drive an effect nothing admitted.
 */
export const HUMAN_REQUEST_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'applyPatchApproval',
  'execCommandApproval',
])

export function timeoutDecision(): LocalTerminalDecision {
  return {
    code: 'CODEX_APP_SERVER_EXECUTION_TIMEOUT',
    message: 'Codex app-server execution exceeded its time limit',
  }
}

export function cancellationDecision(): LocalTerminalDecision {
  return {
    code: 'CODEX_APP_SERVER_CANCELLED',
    message: 'Codex app-server execution was cancelled',
  }
}

export function decisionError(
  decision: LocalTerminalDecision,
): Error & { readonly code: LocalTerminalDecision['code'] } {
  return adapterError(decision.code, decision.message) as Error & {
    readonly code: LocalTerminalDecision['code']
  }
}

export function staleTurnError(): Error {
  return adapterError(
    'CODEX_APP_SERVER_STALE_TURN',
    'Codex app-server emitted an event for a stale turn',
  )
}

export function adapterError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code })
}

/**
 * Rebuilds an arbitrary thrown value as an error the adapter is willing to
 * surface. Client errors pass through because their messages are adapter-authored
 * and code-stable; anything else is reduced to its message and optional string
 * code so a provider-authored object cannot smuggle extra fields into an event.
 */
export function sanitizedError(error: unknown): Error & { readonly code?: string } {
  if (error instanceof CodexAppServerClientError) return error
  if (error instanceof Error) {
    const candidate = error as Error & { readonly code?: unknown }
    const code = typeof candidate.code === 'string'
      ? candidate.code
      : undefined
    return Object.assign(new Error(error.message), code ? { code } : {})
  }
  return new Error('Codex app-server adapter failed')
}

export function errorCode(error: Error & { readonly code?: string }): string {
  return error.code ?? 'CODEX_APP_SERVER_FAILED'
}
