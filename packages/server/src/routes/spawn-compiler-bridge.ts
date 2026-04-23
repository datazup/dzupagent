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
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { type Readable } from 'node:stream'
import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import type {
  CompilationTarget,
  CompilationTargetReason,
  CompilationWarning,
} from '@dzupagent/flow-compiler'
import type { DzupEvent } from '@dzupagent/core'
import type { EventGateway } from '../events/event-gateway.js'
import { buildCompileResultEvent } from './compile-result-event.js'
import { sanitizeError } from './route-error.js'

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

/** Async generator that yields parsed NDJSON lines from the child process. */
async function* spawnAndStream(opts: SpawnBridgeOptions): AsyncGenerator<NdjsonLine> {
  const { flowJson, signal } = opts
  const [cmd, args] = isJsScript(BINARY_PATH)
    ? ['node', [BINARY_PATH]]
    : [BINARY_PATH, []]

  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Propagate abort: kill the child when the HTTP connection drops.
  let aborted = false
  const onAbort = (): void => {
    aborted = true
    child.kill('SIGTERM')
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  // Write flow JSON to stdin then close it so the child knows input is complete.
  child.stdin.write(flowJson, 'utf8')
  child.stdin.end()

  // Drain stderr so it doesn't block the child's output pipe.
  const stderrChunks: string[] = []
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => stderrChunks.push(chunk))

  const readable = child.stdout as Readable
  readable.setEncoding('utf8')

  let buffer = ''
  let terminal = false
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
        } catch {
          // Malformed line — emit as fatal error and stop.
          yield { type: 'error', phase: 'protocol', message: `Malformed NDJSON: ${trimmed}` }
          terminal = true
          break
        }
        yield parsed
        // Stop reading after the terminal lines so we don't over-read.
        if (parsed.type === 'result' || parsed.type === 'error') {
          terminal = true
          break
        }
      }
      if (terminal) break
    }
    // Flush any remaining buffer content (only when stdout drained naturally).
    if (!terminal && buffer.trim().length > 0 && !aborted) {
      try {
        yield JSON.parse(buffer.trim()) as NdjsonLine
      } catch {
        yield { type: 'error', phase: 'protocol', message: `Malformed NDJSON tail: ${buffer}` }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Destroy stdout so the child doesn't linger when we exit early.
    if (!readable.destroyed) readable.destroy()
    // Wait for the child to exit, with a safety timeout so tests never hang.
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ])
  }
}

/**
 * Hono handler that streams `dzupagent-compile` output as SSE.
 * Drop-in replacement for the in-process SSE branch in compile.ts.
 *
 * @param c      Hono context with the parsed flow body already validated.
 * @param flowInput  The flow value; will be JSON-serialised before piping.
 */
export async function handleSubprocessCompile(
  c: Context,
  flowInput: string | object,
  options?: { eventGateway?: EventGateway },
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

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => ac.abort())

    try {
      for await (const line of spawnAndStream({ flowJson, signal: ac.signal })) {
        if (ac.signal.aborted) break

        if (line.type === 'result') {
          options?.eventGateway?.publish(buildCompileResultEvent(line))
          await stream.writeSSE({
            event: 'flow:compile_result',
            data: JSON.stringify(buildCompileResultEvent(line)),
          })
        } else if (line.type === 'error') {
          await stream.writeSSE({
            event: 'flow:compile_failed',
            data: JSON.stringify(line),
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
        const { safe } = sanitizeError(err)
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: safe }),
        })
      }
    }
  })
}
