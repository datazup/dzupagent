import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { ForgeError } from '@dzupagent/core/events'
import {
  DEFAULT_CLI_RUNTIME_LIMITS,
  type CliHomeProjection,
  type CliRunSpecification,
  type CliRuntimeDependencies,
  type CliRuntimeLimits,
} from './types.js'

type TerminationReason = 'abort' | 'timeout' | 'overflow'

export async function* runJsonlProcess(
  specification: CliRunSpecification,
  dependencies: CliRuntimeDependencies = {},
): AsyncGenerator<Record<string, unknown>> {
  const startedAt = Date.now()
  const limits: CliRuntimeLimits = { ...DEFAULT_CLI_RUNTIME_LIMITS, ...specification.limits }
  const spawn = dependencies.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options))
  const setTimer = dependencies.setTimer ?? setTimeout
  const clearTimer = dependencies.clearTimer ?? clearTimeout
  const graceMs = specification.terminationGraceMs ?? 5_000
  const platform = dependencies.platform ?? process.platform
  let child: ChildProcess | undefined
  let terminationReason: TerminationReason | undefined
  let closed = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let escalation: ReturnType<typeof setTimeout> | undefined
  let stderr = ''
  let stderrBytes = 0
  let stdoutBytes = 0
  let recordCount = 0
  let diagnosticCount = 0
  const textChunks: Buffer[] = []
  const recordMalformedDiagnostic = (message: string): void => {
    if (diagnosticCount < limits.diagnostics) {
      dependencies.onDiagnostic?.({ kind: 'malformed_line', message: message.slice(0, 512) })
    }
    diagnosticCount += 1
  }

  const killTree = (signal: NodeJS.Signals): void => {
    if (!child) return
    if (closed || child.exitCode !== null) return
    try {
      if (dependencies.killProcessTree) dependencies.killProcessTree(child, signal)
      else defaultKillProcessTree(child, signal, platform)
    } catch {
      // Exit classification below remains authoritative even when signalling races.
    }
  }
  const terminate = (reason: TerminationReason): void => {
    terminationReason ??= reason
    if (!child || closed || child.exitCode !== null) return
    killTree('SIGTERM')
    if (!escalation) {
      escalation = setTimer(() => {
        if (child && !closed && child.exitCode === null) killTree('SIGKILL')
      }, graceMs)
      escalation.unref?.()
    }
  }
  const onAbort = (): void => terminate('abort')

  try {
    assertCommand(specification.command)
    if (specification.cwd) await assertWorkingDirectory(specification.cwd)
    assertLimits(limits)
    if (specification.homeProjection) emitHomeProjectionCreated(specification.homeProjection, dependencies)

    child = spawn(specification.command, specification.args, {
      cwd: specification.cwd,
      env: projectionEnvironment(specification),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      shell: false,
    })
    closed = child.exitCode !== null

    specification.signal?.addEventListener('abort', onAbort, { once: true })
    if (specification.signal?.aborted) terminate('abort')
    if (specification.timeoutMs && specification.timeoutMs > 0) {
      timeout = setTimer(() => terminate('timeout'), specification.timeoutMs)
      timeout.unref?.()
    }

    const stderrStream = child.stderr
    stderrStream?.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stderrBytes += value.byteLength
      if (stderrBytes > limits.stderrBytes) {
        terminate('overflow')
        return
      }
      stderr += value.toString('utf8')
    })

    const spawnError = await waitForSpawn(child)
    if (spawnError) throw classifySpawnError(specification.command, spawnError)
    if (!specification.stdinResponder && child.stdin && !child.stdin.destroyed) {
      child.stdin.end()
    }
    const stdout = child.stdout
    if (!stdout) throw executionError(specification.command, 'Child stdout is unavailable')

    let buffer = Buffer.alloc(0)
    for await (const chunk of stdout) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      stdoutBytes += bytes.byteLength
      if (stdoutBytes > limits.stdoutBytes) {
        terminate('overflow')
        break
      }
      if (specification.stdoutMode === 'text') {
        textChunks.push(bytes)
        continue
      }
      buffer = Buffer.concat([buffer, bytes])
      if (buffer.byteLength > limits.lineBytes && !buffer.includes(0x0a)) {
        terminate('overflow')
        break
      }

      let newline = buffer.indexOf(0x0a)
      while (newline >= 0) {
        const line = buffer.subarray(0, newline)
        buffer = buffer.subarray(newline + 1)
        if (line.byteLength > limits.lineBytes) {
          terminate('overflow')
          break
        }
        const record = parseRecord(line, specification, recordMalformedDiagnostic)
        if (record) {
          recordCount += 1
          if (recordCount > limits.records) {
            terminate('overflow')
            break
          }
          // Start interaction resolution before yielding so the adapter can
          // project the question to its caller. Awaiting the responder first
          // deadlocks ask-caller mode: the caller cannot see the interaction
          // id needed to resolve the pending response.
          const pendingAnswer = specification.stdinResponder
            ? specification.stdinResponder(record).then(
                (answer) => ({ answer }),
                (error: unknown) => ({ error }),
              )
            : undefined
          yield record
          const settledAnswer = await pendingAnswer
          if (settledAnswer && 'error' in settledAnswer) throw settledAnswer.error
          const answer = settledAnswer?.answer
          if (answer !== undefined && answer !== null && child.stdin && !child.stdin.destroyed) child.stdin.write(`${answer}\n`)
        }
        newline = buffer.indexOf(0x0a)
      }
      if (terminationReason) break
    }

    if (specification.stdoutMode !== 'text' && !terminationReason && buffer.byteLength > 0) {
      if (buffer.byteLength > limits.lineBytes) terminate('overflow')
      else {
        const record = parseRecord(buffer, specification, recordMalformedDiagnostic)
        if (record) {
          recordCount += 1
          if (recordCount > limits.records) terminate('overflow')
          else yield record
        }
      }
    }

    const { code, signal } = await waitForClose(child)
    closed = true
    if (terminationReason === 'timeout') throw timeoutError(specification)
    if (terminationReason === 'abort') throw abortedError(specification.command)
    if (terminationReason === 'overflow') throw overflowError(specification.command, limits)
    if (code !== 0) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Process '${specification.command}' exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`,
        recoverable: false,
        context: { command: specification.command, exitCode: code, signal, stderr },
      })
    }
    if (specification.stdoutMode === 'text') {
      yield {
        type: 'text_result',
        content: Buffer.concat(textChunks).toString('utf8').trimEnd(),
        duration_ms: Date.now() - startedAt,
      }
    }
  } catch (error) {
    if (error instanceof ForgeError) throw error
    throw ForgeError.wrap(error, {
      code: 'ADAPTER_EXECUTION_FAILED',
      message: `Process '${specification.command}' failed while streaming output`,
      recoverable: false,
      context: { command: specification.command, classification: 'stream_error' },
    })
  } finally {
    if (timeout) clearTimer(timeout)
    if (escalation) clearTimer(escalation)
    specification.signal?.removeEventListener('abort', onAbort)
    if (child && !closed && child.exitCode === null) terminate(terminationReason ?? 'abort')
    await cleanupHomeProjection(specification.homeProjection, dependencies)
  }
}

function projectionEnvironment(specification: CliRunSpecification): Readonly<Record<string, string>> | undefined {
  const env = { ...(specification.env ?? {}), ...(specification.homeProjection?.env ?? {}) }
  return Object.keys(env).length > 0 ? env : undefined
}

function emitHomeProjectionCreated(projection: CliHomeProjection, dependencies: CliRuntimeDependencies): void {
  dependencies.onDiagnostic?.({
    kind: 'cli_home_projection_created',
    message: 'CLI home projection created',
    metadata: {
      root: projection.root,
      generatedFiles: Object.keys(projection.generatedPaths).length,
      baseProfileInputs: Object.keys(projection.baseProfilePaths).length,
      requiredDirectories: projection.requiredDirectories.length,
    },
  })
}

async function cleanupHomeProjection(
  projection: CliHomeProjection | undefined,
  dependencies: CliRuntimeDependencies,
): Promise<void> {
  if (!projection) return
  try {
    await projection.cleanup()
    dependencies.onDiagnostic?.({
      kind: 'cli_home_projection_cleanup_status',
      message: 'CLI home projection cleanup completed',
      metadata: { root: projection.root, status: 'success' },
    })
  } catch (error) {
    dependencies.onDiagnostic?.({
      kind: 'cli_home_projection_cleanup_status',
      message: 'CLI home projection cleanup failed',
      metadata: {
        root: projection.root,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

function parseRecord(
  line: Buffer,
  specification: CliRunSpecification,
  recordDiagnostic: (message: string) => void,
): Record<string, unknown> | null {
  const text = line.toString('utf8').trim()
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : malformed(text)
  } catch {
    if (specification.malformedLinePolicy === 'error') {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Process '${specification.command}' emitted malformed JSONL`,
        recoverable: false,
        context: { command: specification.command, classification: 'malformed_stream' },
      })
    }
    recordDiagnostic(text)
    return null
  }

  function malformed(value: string): null {
    if (specification.malformedLinePolicy === 'error') throw executionError(specification.command, 'JSONL record must be an object')
    recordDiagnostic(value)
    return null
  }
}

function defaultKillProcessTree(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform): void {
  if (platform !== 'win32' && child.pid) {
    process.kill(-child.pid, signal)
    return
  }
  if (platform === 'win32' && child.pid) {
    nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    }).unref()
    return
  }
  child.kill(signal)
}

async function assertWorkingDirectory(cwd: string): Promise<void> {
  const info = await stat(cwd).catch(() => null)
  if (!info?.isDirectory()) throw new ForgeError({ code: 'VALIDATION_FAILED', message: `Working directory does not exist or is not a directory: ${cwd}`, recoverable: false })
}

function assertCommand(command: string): void {
  if (!command.trim() || command.includes('\0')) throw new ForgeError({ code: 'VALIDATION_FAILED', message: 'CLI command must be a non-empty executable name or path', recoverable: false })
}

function assertLimits(limits: CliRuntimeLimits): void {
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`CLI runtime limit ${name} must be a positive safe integer`)
}

function waitForSpawn(child: ChildProcess): Promise<Error | null> {
  if (child.pid) return Promise.resolve(null)
  return new Promise((resolve) => { child.once('spawn', () => resolve(null)); child.once('error', (error) => resolve(error)) })
}

function waitForClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
}

function classifySpawnError(command: string, error: Error): ForgeError {
  const code = (error as NodeJS.ErrnoException).code
  return new ForgeError({
    code: code === 'ENOENT' ? 'ADAPTER_SDK_NOT_INSTALLED' : 'ADAPTER_EXECUTION_FAILED',
    message: code === 'ENOENT' ? `Binary '${command}' not found in PATH` : `Failed to spawn '${command}': ${error.message}`,
    recoverable: false,
    cause: error,
    context: { command },
  })
}

function executionError(command: string, message: string): ForgeError {
  return new ForgeError({ code: 'ADAPTER_EXECUTION_FAILED', message, recoverable: false, context: { command } })
}
function timeoutError(specification: CliRunSpecification): ForgeError {
  return new ForgeError({ code: 'ADAPTER_TIMEOUT', message: `Process '${specification.command}' timed out after ${specification.timeoutMs}ms`, recoverable: true, context: { command: specification.command, timeoutMs: specification.timeoutMs } })
}
function abortedError(command: string): ForgeError {
  return new ForgeError({ code: 'AGENT_ABORTED', message: `Process '${command}' aborted`, recoverable: true, context: { command } })
}
function overflowError(command: string, limits: CliRuntimeLimits): ForgeError {
  return new ForgeError({ code: 'ADAPTER_EXECUTION_FAILED', message: `Process '${command}' exceeded a configured output bound`, recoverable: false, context: { command, classification: 'output_overflow', limits } })
}
