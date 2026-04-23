/**
 * Shared process helpers for CLI-based agent adapters.
 *
 * Provides binary availability checks and JSONL streaming from
 * spawned child processes.
 */

import { spawn, type SpawnOptions } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ForgeError } from '@dzupagent/core'
import { detectCliInteraction } from '../interaction/interaction-detector.js'
import type { InteractionKind } from '../interaction/interaction-detector.js'

const execFileAsync = promisify(execFile)

/**
 * Check if a binary exists in PATH.
 *
 * Uses `which` on Unix to locate the binary. Returns false if not found
 * or if the lookup command fails for any reason.
 */
export async function isBinaryAvailable(name: string): Promise<boolean> {
  try {
    await execFileAsync('which', [name])
    return true
  } catch {
    return false
  }
}

/** Options for the JSONL spawner. */
export interface SpawnJsonlOptions extends SpawnOptions {
  /** AbortSignal for cancellation */
  signal?: AbortSignal | undefined
  /** Timeout in milliseconds — kills the process after this duration */
  timeoutMs?: number | undefined
  /** Enable backpressure — pause stdout when consumer is processing. Default: false */
  backpressure?: boolean | undefined
  /**
   * Optional callback invoked when a JSONL record is detected as a mid-execution
   * interaction request (question, permission prompt, confirmation, etc.).
   *
   * The callback must return the answer string to write to stdin, or null to skip
   * (the record is still yielded). The callback is awaited before yielding.
   *
   * Only wire this when interactionPolicy.mode !== 'auto-approve' to avoid overhead.
   */
  stdinResponder?: ((
    record: Record<string, unknown>,
    question: string,
    kind: InteractionKind,
  ) => Promise<string | null>) | undefined
}

/**
 * Spawn a CLI process and yield parsed JSONL records from its stdout.
 *
 * Each line of stdout is expected to be a valid JSON object. Lines that
 * fail to parse are silently skipped (some CLIs emit non-JSON preamble).
 *
 * The generator cleans up the child process on return or throw, and
 * respects the optional AbortSignal for cancellation.
 *
 * @throws {ForgeError} with code ADAPTER_SDK_NOT_INSTALLED if the binary is not found (ENOENT).
 * @throws {ForgeError} with code ADAPTER_EXECUTION_FAILED if the process exits with a non-zero code.
 * @throws {ForgeError} with code ADAPTER_TIMEOUT if the process exceeds timeoutMs.
 * @throws {ForgeError} with code AGENT_ABORTED if execution is cancelled via AbortSignal.
 */
export async function* spawnAndStreamJsonl(
  command: string,
  args: string[],
  options: SpawnJsonlOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const { signal, timeoutMs, backpressure, stdinResponder, ...spawnOpts } = options

  const child = spawn(command, args, {
    ...spawnOpts,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Track who initiated termination so timeout and user abort are classified correctly.
  let terminationReason: 'abort' | 'timeout' | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined

  const terminateChild = (reason: 'abort' | 'timeout'): void => {
    if (!terminationReason) {
      terminationReason = reason
    }
    if (!child.killed) {
      child.kill('SIGTERM')
      // Escalate to SIGKILL if the process doesn't exit after SIGTERM
      forceKillTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL')
        }
      }, 5000)
      if (typeof forceKillTimer.unref === 'function') {
        forceKillTimer.unref()
      }
    }
  }

  // Abort signal handler
  const onAbort = (): void => {
    terminateChild('abort')
  }

  if (signal) {
    if (signal.aborted) {
      terminateChild('abort')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  // Timeout handler
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      terminateChild('timeout')
    }, timeoutMs)
  }

  try {
    // Stream JSONL from stdout. Attach listeners before awaiting the spawn
    // handshake so short-lived commands cannot exit before we start
    // observing their output.
    const stdout = child.stdout
    if (!stdout) {
      return
    }

    let buffer = ''
    const chunkQueue: string[] = []
    let streamEnded = false
    let streamError: Error | null = null
    let notifyReader: (() => void) | null = null

    const wakeReader = (): void => {
      if (notifyReader) {
        notifyReader()
        notifyReader = null
      }
    }

    stdout.on('readable', () => {
      let chunk: Buffer | string | null
      while ((chunk = stdout.read() as Buffer | string | null) !== null) {
        chunkQueue.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      }
      wakeReader()
    })
    stdout.once('end', () => {
      streamEnded = true
      wakeReader()
    })
    stdout.once('error', (err: Error) => {
      streamError = err
      streamEnded = true
      wakeReader()
    })

    // Wait for the process to either spawn successfully or fail immediately.
    const spawnError = await new Promise<Error | null>((resolve) => {
      child.once('spawn', () => resolve(null))
      child.once('error', (err: Error) => resolve(err))
    })

    if (spawnError) {
      const nodeError = spawnError as NodeJS.ErrnoException
      if (nodeError.code === 'ENOENT') {
        throw new ForgeError({
          code: 'ADAPTER_SDK_NOT_INSTALLED',
          message: `Binary '${command}' not found in PATH`,
          recoverable: false,
          suggestion: `Install the '${command}' CLI and ensure it is available in PATH`,
          context: { command },
        })
      }
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Failed to spawn '${command}': ${spawnError.message}`,
        recoverable: false,
        cause: spawnError,
        context: { command },
      })
    }

    while (!streamEnded || chunkQueue.length > 0) {
      if (chunkQueue.length === 0) {
        await new Promise<void>((resolve) => {
          notifyReader = resolve
        })
        continue
      }

      const chunk = chunkQueue.shift()
      if (chunk === undefined) continue

      buffer += chunk
      const lines = buffer.split('\n')
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue

        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const record = parsed as Record<string, unknown>

            // Handle mid-execution interaction requests when a responder is wired
            if (stdinResponder) {
              const detected = detectCliInteraction(record)
              if (detected) {
                const answer = await stdinResponder(record, detected.question, detected.kind)
                if (answer !== null && child.stdin && !child.stdin.destroyed) {
                  child.stdin.write(answer + '\n')
                }
              }
            }

            if (backpressure && stdout && !stdout.destroyed) {
              stdout.pause()
            }
            yield record
            if (backpressure && stdout && !stdout.destroyed) {
              stdout.resume()
            }
          }
        } catch {
          // Skip non-JSON lines (CLI preamble, progress indicators, etc.)
        }
      }
    }

    if (streamError) {
      throw ForgeError.wrap(streamError, {
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Failed while reading stdout from '${command}'`,
        recoverable: false,
        context: { command },
      })
    }

    // Process any remaining data in the buffer
    if (buffer.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(buffer.trim())
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          yield parsed as Record<string, unknown>
        }
      } catch {
        // Skip incomplete trailing data
      }
    }

    // Wait for the process to fully exit
    const exitCode = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode)
        return
      }
      child.on('close', (code) => resolve(code))
    })

    if (terminationReason === 'timeout' && timeoutMs !== undefined) {
      throw new ForgeError({
        code: 'ADAPTER_TIMEOUT',
        message: `Process '${command}' timed out after ${timeoutMs}ms`,
        recoverable: true,
        suggestion: 'Increase timeoutMs or simplify the prompt',
        context: { command, timeoutMs },
      })
    }

    if (terminationReason === 'abort') {
      throw new ForgeError({
        code: 'AGENT_ABORTED',
        message: `Process '${command}' aborted`,
        recoverable: true,
        suggestion: 'Retry the request if cancellation was unintentional',
        context: { command },
      })
    }

    if (exitCode !== null && exitCode !== 0 && !terminationReason) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Process '${command}' exited with code ${exitCode}`,
        recoverable: false,
        context: { command, exitCode },
      })
    }
  } finally {
    // Ensure stdout is resumed if backpressure paused it
    if (backpressure && child.stdout && !child.stdout.destroyed) {
      child.stdout.resume()
    }
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer)
    }
    if (signal) {
      signal.removeEventListener('abort', onAbort)
    }
    // Ensure cleanup — kill the process if it's still running
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM')
      const finalKillTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL')
        }
      }, 5000)
      if (typeof finalKillTimer.unref === 'function') {
        finalKillTimer.unref()
      }
    }
  }
}
