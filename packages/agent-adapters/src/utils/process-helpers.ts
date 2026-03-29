/**
 * Shared process helpers for CLI-based agent adapters.
 *
 * Provides binary availability checks and JSONL streaming from
 * spawned child processes.
 */

import { spawn, type SpawnOptions } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ForgeError } from '@dzipagent/core'

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
  signal?: AbortSignal
  /** Timeout in milliseconds — kills the process after this duration */
  timeoutMs?: number
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
 */
export async function* spawnAndStreamJsonl(
  command: string,
  args: string[],
  options: SpawnJsonlOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const { signal, timeoutMs, ...spawnOpts } = options

  const child = spawn(command, args, {
    ...spawnOpts,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Track whether we initiated the kill so we can distinguish from external signals
  let killedByUs = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  // Abort signal handler
  const onAbort = (): void => {
    killedByUs = true
    child.kill('SIGTERM')
  }

  if (signal) {
    if (signal.aborted) {
      child.kill('SIGTERM')
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  // Timeout handler
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      killedByUs = true
      child.kill('SIGTERM')
    }, timeoutMs)
  }

  try {
    // Handle spawn errors (e.g. binary not found)
    const spawnError = await new Promise<Error | null>((resolve) => {
      child.on('error', (err: Error) => resolve(err))
      // If stdout starts flowing, spawn succeeded
      child.stdout?.once('readable', () => resolve(null))
      // Also resolve on early close with no error
      child.on('close', () => resolve(null))
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

    // Stream JSONL from stdout
    const stdout = child.stdout
    if (!stdout) {
      return
    }

    let buffer = ''

    for await (const chunk of stdout) {
      buffer += String(chunk)
      const lines = buffer.split('\n')
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue

        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            yield parsed as Record<string, unknown>
          }
        } catch {
          // Skip non-JSON lines (CLI preamble, progress indicators, etc.)
        }
      }
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

    if (killedByUs && timeoutMs !== undefined) {
      throw new ForgeError({
        code: 'ADAPTER_TIMEOUT',
        message: `Process '${command}' timed out after ${timeoutMs}ms`,
        recoverable: true,
        suggestion: 'Increase timeoutMs or simplify the prompt',
        context: { command, timeoutMs },
      })
    }

    if (exitCode !== null && exitCode !== 0 && !killedByUs) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Process '${command}' exited with code ${exitCode}`,
        recoverable: false,
        context: { command, exitCode },
      })
    }
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
    if (signal) {
      signal.removeEventListener('abort', onAbort)
    }
    // Ensure cleanup
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM')
    }
  }
}
