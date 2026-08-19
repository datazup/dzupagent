import type { Writable } from 'node:stream'

import {
  CodexAppServerClientError,
  operationCancelled,
} from './codex-app-server-client-contracts.js'

/**
 * Serialises one JSONL frame onto a process stdin, bounded by the same line
 * limit the reader enforces inbound.
 *
 * The outbound check is not symmetry for its own sake: an oversized frame would
 * be rejected by the peer mid-line, leaving the stream desynchronised with no
 * way to resynchronise short of killing the process. Refusing to write it keeps
 * the failure local and recoverable.
 *
 * Resolution is latched, so a write callback that fires after a timeout or an
 * abort cannot retroactively report success on an operation the caller has
 * already been told failed.
 */
export function writeCodexAppServerFrame(
  stdin: Writable | null | undefined,
  frame: Readonly<Record<string, unknown>>,
  maxLineBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!stdin || stdin.destroyed || !stdin.writable) {
    return Promise.reject(new CodexAppServerClientError(
      'CODEX_APP_SERVER_WRITE_FAILED',
      'Codex app-server stdin is unavailable',
    ))
  }
  const bytes = `${JSON.stringify(frame)}\n`
  if (Buffer.byteLength(bytes, 'utf8') > maxLineBytes) {
    return Promise.reject(new CodexAppServerClientError(
      'CODEX_APP_SERVER_LINE_LIMIT',
      'Codex app-server outbound frame exceeded its line limit',
    ))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => finish(operationCancelled())
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new CodexAppServerClientError(
      'CODEX_APP_SERVER_TIMEOUT',
      'Codex app-server write timed out',
    )), timeoutMs)
    if (signal?.aborted) {
      finish(operationCancelled())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    stdin.write(bytes, (error) => {
      if (error) finish(new CodexAppServerClientError(
        'CODEX_APP_SERVER_WRITE_FAILED',
        'Codex app-server stdin write failed',
      ))
      else finish()
    })
  })
}
