/**
 * SpawnCompilerBridge — runs `dzupagent-compile` as an isolated child process
 * and translates its NDJSON stdout into the same SSE event stream that the
 * in-process compile route produces.
 *
 * Use with the `?subprocess=true` flag on `POST /compile`.
 *
 * Process isolation guarantees that:
 *  - A compiler crash never brings down the server process.
 *  - Memory spikes from large flows are contained to the child.
 *  - The child's event loop cannot block the server event loop.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { type Readable } from 'node:stream'
import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import type {
  CompilationDiagnostic,
  CompilationTarget,
  CompilationTargetReason,
  CompilationWarning,
} from '@dzupagent/flow-compiler'
import type { DzupEvent } from '@dzupagent/core/events'
import { secureLogger } from '@dzupagent/core/utils'
import type { RunEventStore } from '@dzupagent/agent-adapters/runs'
import type { EventGateway } from '../events/event-gateway.js'
import { buildCompileResultEvent } from './compile-result-event.js'
import { logRouteError } from './route-error.js'
import {
  finalizeCompileSuccess,
  logInternalCompileDiagnostics,
  toPublicCompileDiagnostic,
} from './compile/shared.js'

/** Every line emitted by `dzupagent-compile` stdout. */
type NdjsonLine =
  | Extract<
      DzupEvent,
      {
        type:
          | 'flow:compile_started'
          | 'flow:compile_parsed'
          | 'flow:compile_shape_validated'
          | 'flow:compile_semantic_resolved'
          | 'flow:compile_lowered'
          | 'flow:compile_completed'
          | 'flow:compile_failed'
      }
    >
  | {
      type: 'result'
      compileId: string
      target: CompilationTarget
      artifact: unknown
      warnings: CompilationWarning[]
      reasons?: CompilationTargetReason[]
    }
  | { type: 'error'; phase: string; message?: string; errors?: unknown[]; compileId?: string }

/**
 * Error frame as produced by {@link spawnAndStream}. `internalDetail` carries
 * server-only text (child stderr, malformed stdout) and never reaches clients.
 */
type BridgeErrorFrame = Extract<NdjsonLine, { type: 'error' }> & { internalDetail?: string }

/** Fixed client-facing message for a child `error` frame that carries raw text. */
const SUBPROCESS_INTERNAL_ERROR_MESSAGE = 'Compilation subprocess failed because of an internal error'

/** Resolve the absolute path to the installed `dzupagent-compile` binary. */
function resolveBinaryPath(): string {
  // In a Yarn workspace the binary is always linked under root node_modules/.bin.
  // Use the package entry point to anchor the search.
  const req = createRequire(import.meta.url)
  try {
    const pkgMain = req.resolve('@dzupagent/flow-compiler')
    // pkgMain → …/packages/flow-compiler/dist/index.js
    // binary  → …/packages/flow-compiler/dist/bin/compile.js
    const pkgRoot = pkgMain.replace(/\/dist\/.*$/, '')
    return join(pkgRoot, 'dist', 'bin', 'compile.js')
  } catch {
    // Fallback: rely on PATH (the binary is linked by Yarn)
    return 'dzupagent-compile'
  }
}

const BINARY_PATH = resolveBinaryPath()

/** Whether BINARY_PATH is a .js file that needs `node` as runner. */
function isJsScript(p: string): boolean {
  return p.endsWith('.js')
}

interface SpawnBridgeOptions {
  /** Serialised flow JSON string piped to the child's stdin. */
  flowJson: string
  /** Abort signal from the HTTP request. When fired the child is killed. */
  signal?: AbortSignal
}

interface SpawnSession {
  child: ReturnType<typeof spawn>
  getProcessError: () => Error | undefined
  recordProcessError: (error: Error) => void
  exitState: {
    code: number | null
    signal: NodeJS.Signals | null
    exited: boolean
  }
  exitPromise: Promise<void>
}

/** Spawn the compiler and prove startup succeeded before committing an SSE response. */
async function createSpawnSession(): Promise<SpawnSession> {
  const [cmd, args] = isJsScript(BINARY_PATH)
    ? ['node', [BINARY_PATH]]
    : [BINARY_PATH, []]

  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // DZUPAGENT-ERR-C-26: Node treats an unhandled ChildProcess/stream 'error'
  // as an uncaught exception. Keep both listeners for the full process lifetime
  // and attach them before stdin or any other child I/O is touched.
  let processError: Error | undefined
  const recordProcessError = (error: Error): void => {
    processError ??= error
  }
  child.on('error', recordProcessError)
  child.stdin?.on('error', recordProcessError)

  // Capture close from the same early setup window. A very short-lived child
  // can exit before the generator begins consuming stdout.
  const exitState = {
    code: null as number | null,
    signal: null as NodeJS.Signals | null,
    exited: false,
  }
  const exitPromise = new Promise<void>((resolve) => {
    child.once('close', (code: number | null, signal: NodeJS.Signals | null | undefined) => {
      exitState.code = code
      exitState.signal = signal ?? null
      exitState.exited = true
      resolve()
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onInitialError)
      resolve()
    }
    const onInitialError = (error: Error): void => {
      child.off('spawn', onSpawn)
      reject(error)
    }
    child.once('spawn', onSpawn)
    child.once('error', onInitialError)
  })

  return {
    child,
    getProcessError: () => processError,
    recordProcessError,
    exitState,
    exitPromise,
  }
}

/** Async generator that yields parsed NDJSON lines from the child process. */
async function* spawnAndStream(
  opts: SpawnBridgeOptions,
  session: SpawnSession,
): AsyncGenerator<NdjsonLine | BridgeErrorFrame> {
  const { flowJson, signal } = opts
  const {
    child,
    getProcessError,
    recordProcessError,
    exitState,
    exitPromise,
  } = session

  // Propagate abort: kill the child when the HTTP connection drops.
  let aborted = false
  const onAbort = (): void => {
    aborted = true
    child.kill('SIGTERM')
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  // Drain stderr so it doesn't block the child's output pipe and so the server
  // log can carry it when the child exits non-zero (never the client frame).
  const stderrChunks: string[] = []
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => stderrChunks.push(chunk))

  // Exit code/signal capture was installed in createSpawnSession. The protocol
  // delivers a terminal `result` or `error` frame on stdout, but partial NDJSON
  // cannot be trusted as success — we MUST observe a clean exit (code === 0)
  // before treating any earlier `result` frame as final.
  // Write flow JSON to stdin then close it so the child knows input is complete.
  // The callback captures immediate write failures in addition to the persistent
  // stream listener installed by createSpawnSession.
  child.stdin?.write(flowJson, 'utf8', (error) => {
    if (error) recordProcessError(error)
  })
  child.stdin?.end()

  const readable = child.stdout as Readable
  readable.setEncoding('utf8')

  let buffer = ''
  let terminal = false
  let bufferedResult: Extract<NdjsonLine, { type: 'result' }> | null = null
  // Last compileId seen on any frame, so the exit failure can be correlated.
  let lastCompileId: string | undefined
  try {
    for await (const chunk of readable) {
      if (aborted) break
      buffer += chunk as string
      const lines = buffer.split('\n')
      // Keep the last (possibly incomplete) fragment in the buffer.
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        let parsed: NdjsonLine
        try {
          parsed = JSON.parse(trimmed) as NdjsonLine
          const frameCompileId = (parsed as { compileId?: unknown }).compileId
          if (typeof frameCompileId === 'string') lastCompileId = frameCompileId
        } catch {
          // Malformed line — emit as fatal error and stop.
          yield {
            type: 'error',
            phase: 'protocol',
            message: 'Malformed NDJSON from dzupagent-compile',
            internalDetail: trimmed,
          }
          terminal = true
          break
        }
        if (parsed.type === 'result') {
          // Buffer the result — do NOT yield until we've confirmed the child
          // actually exited cleanly. Yielding early would mask a non-zero exit
          // that follows a "result" frame written by a crashing child.
          bufferedResult = parsed
          terminal = true
          break
        }
        yield parsed
        // Stop reading after a fatal error frame.
        if (parsed.type === 'error') {
          terminal = true
          break
        }
      }
      if (terminal) break
    }
    // Flush any remaining buffer content (only when stdout drained naturally).
    if (!terminal && buffer.trim().length > 0 && !aborted) {
      try {
        const parsed = JSON.parse(buffer.trim()) as NdjsonLine
        if (parsed.type === 'result') {
          bufferedResult = parsed
        } else {
          yield parsed
        }
      } catch {
        yield {
          type: 'error',
          phase: 'protocol',
          message: 'Malformed NDJSON tail from dzupagent-compile',
          internalDetail: buffer,
        }
      }
    }

    // Authoritative success gate: wait for the child to exit, then decide
    // whether to flush the buffered `result` frame. A non-zero exit code or a
    // termination signal MUST be surfaced as a protocol error — partial
    // protocol frames cannot mask a crashing child.
    if (!aborted) {
      if (!exitState.exited) {
        await Promise.race([
          exitPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ])
      }

      const processError = getProcessError()
      if (processError) {
        throw processError
      } else if (exitState.code === 0 && exitState.signal === null && bufferedResult !== null) {
        yield bufferedResult
      } else if (exitState.code !== 0 || exitState.signal !== null) {
        const codeStr = exitState.code === null ? 'null' : String(exitState.code)
        const sigStr = exitState.signal === null ? '' : ` signal=${exitState.signal}`
        const stderrText = stderrChunks.join('').trim()
        const partialNote = bufferedResult !== null
          ? ' (partial result frame discarded — exit was non-zero)'
          : ''
        // DZUPAGENT-ERR-H-16: stderr (stack traces, install paths, OOM text)
        // is server-log only; the client sees the exit code/signal.
        yield {
          type: 'error',
          phase: 'subprocess',
          compileId: bufferedResult?.compileId ?? lastCompileId ?? randomUUID(),
          message: `dzupagent-compile exited with code=${codeStr}${sigStr}${partialNote}`,
          internalDetail: stderrText.length > 0 ? stderrText : '(no stderr)',
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Destroy stdout so the child doesn't linger when we exit early.
    if (!readable.destroyed) readable.destroy()
    // Wait for the child to exit, with a safety timeout so tests never hang.
    if (!exitState.exited) {
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ])
    }
  }
}

function isDiagnostic(value: unknown): value is CompilationDiagnostic {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string'
}

/**
 * Client projection of a child/bridge error frame (DZUPAGENT-ERR-H-16).
 * Raw text — bridge `internalDetail`, and the free-form `message` the CLI
 * writes for a thrown error — is logged with the compileId and replaced;
 * diagnostics go through the same internal-diagnostic redaction as the
 * in-process compile paths.
 */
function toPublicErrorFrame(
  c: Context,
  frame: BridgeErrorFrame,
): Extract<NdjsonLine, { type: 'error' }> {
  const { internalDetail, ...rest } = frame
  const errors = Array.isArray(frame.errors) ? frame.errors.filter(isDiagnostic) : undefined
  if (errors) logInternalCompileDiagnostics(errors, frame.compileId)

  // Bridge-authored frames carry an already safe message; a CLI frame's
  // message is the text of whatever the child threw.
  const bridgeAuthored = internalDetail !== undefined
  const rawChildMessage = !bridgeAuthored && frame.message !== undefined
  if (bridgeAuthored || rawChildMessage) {
    secureLogger.error({
      level: 'error',
      operation: 'compile.subprocess.failed',
      method: c.req.method,
      path: c.req.path,
      phase: frame.phase,
      ...(frame.compileId ? { compileId: frame.compileId } : {}),
      detail: bridgeAuthored ? internalDetail : frame.message,
    })
  }

  return {
    ...rest,
    ...(rawChildMessage ? { message: SUBPROCESS_INTERNAL_ERROR_MESSAGE } : {}),
    ...(frame.errors !== undefined
      ? { errors: (errors ?? []).map(toPublicCompileDiagnostic) }
      : {}),
  }
}

export interface SubprocessCompileOptions {
  eventGateway?: EventGateway
  /**
   * Target the caller asked for. A routed target that differs is reported as
   * a `TARGET_MISMATCH` failure, as in the JSON branch.
   */
  requestedTarget?: CompilationTarget
  /** Persists a success the same way as every in-process branch. */
  runEventStore?: RunEventStore
}

/**
 * Hono handler that streams `dzupagent-compile` output as SSE.
 * Drop-in replacement for the in-process SSE branch in compile.ts.
 *
 * @param c      Hono context with the parsed flow body already validated.
 * @param flowInput  The CLI input: raw DSL source text, a flow JSON string, or
 *                   a flow/document object that is JSON-serialised before piping.
 */
export async function handleSubprocessCompile(
  c: Context,
  flowInput: string | object,
  options?: SubprocessCompileOptions,
): Promise<Response> {
  const flowJson = typeof flowInput === 'string' ? flowInput : JSON.stringify(flowInput)

  // Expose the run correlation id as a response header for client traceability,
  // consistent with the in-process SSE branch in compile.ts.
  const runId = c.req.query('runId') ?? ''
  if (runId) {
    c.header('X-Run-Id', runId)
  }

  // Build a per-request AbortSignal tied to the HTTP connection lifetime.
  const ac = new AbortController()

  let session: SpawnSession
  try {
    session = await createSpawnSession()
  } catch (err) {
    const { safe } = logRouteError(c, 'compile.subprocess.spawn', err, 503)
    return c.json({ error: safe }, 503)
  }

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => ac.abort())

    try {
      for await (const line of spawnAndStream({ flowJson, signal: ac.signal }, session)) {
        if (ac.signal.aborted) break

        if (line.type === 'result') {
          // Target assertion, gateway publish and persistence are shared
          // with every in-process branch (DZUPAGENT-CODE-M-17).
          const finalized = finalizeCompileSuccess(line, {
            requestedTarget: options?.requestedTarget,
            runId,
            config: { eventGateway: options?.eventGateway, runEventStore: options?.runEventStore },
          })
          if (!finalized.ok) {
            await stream.writeSSE({
              event: 'flow:compile_failed',
              data: JSON.stringify({
                type: 'error',
                phase: 'target',
                compileId: line.compileId,
                message: finalized.failure.error,
                errors: finalized.failure.errors,
              }),
            })
            continue
          }
          await stream.writeSSE({
            event: 'flow:compile_result',
            data: JSON.stringify(buildCompileResultEvent(line)),
          })
        } else if (line.type === 'error') {
          await stream.writeSSE({
            event: 'flow:compile_failed',
            data: JSON.stringify(toPublicErrorFrame(c, line)),
          })
        } else {
          // lifecycle event — forward as-is
          options?.eventGateway?.publish(line)
          const eventType = line.type as string
          await stream.writeSSE({
            event: eventType,
            data: JSON.stringify(line),
          })
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        const { safe } = logRouteError(c, 'compile.subprocess.spawn', err)
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: safe }),
        })
      }
    }
  })
}
