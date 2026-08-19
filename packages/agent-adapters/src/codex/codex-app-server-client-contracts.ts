import type { ChildProcess, SpawnOptions } from 'node:child_process'

import type { ResolvedProbeExecutable } from '../introspection/index.js'

export type CodexAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface CodexAppServerInboundEvent {
  readonly kind: 'notification' | 'request'
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
  readonly requestId?: string | number | undefined
}

export interface CodexAppServerClientLimits {
  readonly requestTimeoutMs?: number | undefined
  readonly cleanupTimeoutMs?: number | undefined
  readonly maxLineBytes?: number | undefined
  readonly maxAggregateOutputBytes?: number | undefined
  readonly maxFrames?: number | undefined
  readonly maxPendingRequests?: number | undefined
  readonly maxQueuedEvents?: number | undefined
}

export interface CodexAppServerClientOptions {
  /** Private host-owned identity previously used for capability observation. */
  readonly executable: ResolvedProbeExecutable
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly clientInfo?: {
    readonly name: string
    readonly title: string
    readonly version: string
  } | undefined
  readonly limits?: CodexAppServerClientLimits | undefined
  readonly dependencies?: CodexAppServerClientDependencies | undefined
}

export interface CodexAppServerClientDependencies {
  readonly spawn?: CodexAppServerSpawn | undefined
  readonly realpath?: ((path: string) => Promise<string>) | undefined
  readonly stat?: ((path: string) => Promise<{ isFile(): boolean }>) | undefined
  readonly access?: ((path: string, mode?: number) => Promise<void>) | undefined
  readonly digestArtifact?: ((path: string) => Promise<string>) | undefined
  readonly monotonicNow?: (() => number) | undefined
}

export interface CodexAppServerRequestOptions {
  /** Tight per-operation ceiling; it can never expand the configured limit. */
  readonly timeoutMs?: number | undefined
  /** Optional setup cancellation; active-turn cancellation remains adapter-owned. */
  readonly signal?: AbortSignal | undefined
}

export type CodexAppServerClientErrorCode =
  | 'CODEX_APP_SERVER_CANCELLED'
  | 'CODEX_APP_SERVER_CLEANUP_FAILED'
  | 'CODEX_APP_SERVER_CLOSED'
  | 'CODEX_APP_SERVER_DUPLICATE_RESPONSE'
  | 'CODEX_APP_SERVER_EXECUTABLE_INVALID'
  | 'CODEX_APP_SERVER_FRAME_LIMIT'
  | 'CODEX_APP_SERVER_INITIALIZE_INVALID'
  | 'CODEX_APP_SERVER_LATE_RESPONSE'
  | 'CODEX_APP_SERVER_LINE_LIMIT'
  | 'CODEX_APP_SERVER_MALFORMED_FRAME'
  | 'CODEX_APP_SERVER_OUTPUT_LIMIT'
  | 'CODEX_APP_SERVER_PENDING_LIMIT'
  | 'CODEX_APP_SERVER_PROCESS_DIED'
  | 'CODEX_APP_SERVER_REQUEST_FAILED'
  | 'CODEX_APP_SERVER_TIMEOUT'
  | 'CODEX_APP_SERVER_WRITE_FAILED'

export class CodexAppServerClientError extends Error {
  constructor(
    readonly code: CodexAppServerClientErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CodexAppServerClientError'
  }
}

/*
 * The factories below live beside the error type because every message here is
 * a fixed, provider-independent string. Nothing the Codex process authored may
 * reach a caller, so a raised failure carries only a stable code -- callers
 * branch on `code`, never on prose.
 */

export function operationCancelled(): CodexAppServerClientError {
  return new CodexAppServerClientError(
    'CODEX_APP_SERVER_CANCELLED',
    'Codex app-server operation was cancelled',
  )
}

export function malformedFrame(): CodexAppServerClientError {
  return new CodexAppServerClientError(
    'CODEX_APP_SERVER_MALFORMED_FRAME',
    'Codex app-server emitted a malformed frame',
  )
}

export function executableInvalid(): CodexAppServerClientError {
  return new CodexAppServerClientError(
    'CODEX_APP_SERVER_EXECUTABLE_INVALID',
    'Qualified Codex executable identity is unavailable or drifted',
  )
}

export function asClientError(
  error: unknown,
  code: CodexAppServerClientErrorCode,
): CodexAppServerClientError {
  return error instanceof CodexAppServerClientError
    ? error
    : new CodexAppServerClientError(code, 'Codex app-server client operation failed')
}
