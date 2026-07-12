/**
 * Shared process helpers for CLI-based agent adapters.
 *
 * Provides binary availability checks and JSONL streaming from
 * spawned child processes.
 */

import { execFile, type SpawnOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { detectCliInteraction } from '../interaction/interaction-detector.js'
import type { InteractionKind } from '../interaction/interaction-detector.js'
import { runJsonlProcess } from '../cli-runtime/run-jsonl-process.js'
import type { CliRuntimeLimits, CliStdoutMode, MalformedLinePolicy } from '../cli-runtime/types.js'

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
  /** Output and record bounds applied before any untrusted data is yielded. */
  limits?: Partial<CliRuntimeLimits> | undefined
  /** Compatibility defaults to skip; new strict callers should select error. */
  malformedLinePolicy?: MalformedLinePolicy | undefined
  /** Defaults to JSONL; text mode yields one bounded terminal text record. */
  stdoutMode?: CliStdoutMode | undefined
  /** Grace period between cooperative termination and process-tree escalation. */
  terminationGraceMs?: number | undefined
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
  const { signal, timeoutMs, stdinResponder, limits, malformedLinePolicy, stdoutMode, terminationGraceMs, cwd, env } = options
  yield* runJsonlProcess({
    command,
    args,
    cwd: typeof cwd === 'string' ? cwd : undefined,
    env: env as Record<string, string> | undefined,
    signal,
    timeoutMs,
    limits,
    malformedLinePolicy,
    stdoutMode,
    terminationGraceMs,
    stdinResponder: stdinResponder
      ? async (record) => {
          const detected = detectCliInteraction(record)
          return detected ? stdinResponder(record, detected.question, detected.kind) : null
        }
      : undefined,
  })
}
