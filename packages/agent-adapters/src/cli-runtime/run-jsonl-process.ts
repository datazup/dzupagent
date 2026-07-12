import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { ForgeError } from '@dzupagent/core/events'
import {
  DEFAULT_CLI_RUNTIME_LIMITS,
  type CliRunSpecification,
  type CliRuntimeDependencies,
  type CliRuntimeLimits,
} from './types.js'

type TerminationReason = 'abort' | 'timeout' | 'overflow'

export async function* runJsonlProcess(
  specification: CliRunSpecification,
  dependencies: CliRuntimeDependencies = {},
): AsyncGenerator<Record<string, unknown>> {
  assertCommand(specification.command)
  if (specification.cwd) await assertWorkingDirectory(specification.cwd)

  const limits: CliRuntimeLimits = { ...DEFAULT_CLI_RUNTIME_LIMITS, ...specification.limits }
  assertLimits(limits)
  const spawn = dependencies.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options))
  const setTimer = dependencies.setTimer ?? setTimeout
  const clearTimer = dependencies.clearTimer ?? clearTimeout
  const graceMs = specification.terminationGraceMs ?? 5_000
  const platform = dependencies.platform ?? process.platform
  const child = spawn(specification.command, specification.args, {
    cwd: specification.cwd,
    env: specification.env ? { ...specification.env } : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: platform !== 'win32',
    shell: false,
  })

  let terminationReason: TerminationReason | undefined
  let closed = child.exitCode !== null
  let timeout: ReturnType<typeof setTimeout> | undefined
  let escalation: ReturnType<typeof setTimeout> | undefined
  let stderr = ''
  let stderrBytes = 0
  let stdoutBytes = 0
  let recordCount = 0
  let diagnosticCount = 0
  const recordMalformedDiagnostic = (message: string): void => {
    if (diagnosticCount < limits.diagnostics) {
      dependencies.onDiagnostic?.({ kind: 'malformed_line', message: message.slice(0, 512) })
    }
    diagnosticCount += 1
  }

  const killTree = (signal: NodeJS.Signals): void => {
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
    if (closed || child.exitCode !== null) return
    killTree('SIGTERM')
    if (!escalation) {
      escalation = setTimer(() => {
        if (!closed && child.exitCode === null) killTree('SIGKILL')
      }, graceMs)
      escalation.unref?.()
    }
  }
  const onAbort = (): void => terminate('abort')
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

  try {
    const spawnError = await waitForSpawn(child)
    if (spawnError) throw classifySpawnError(specification.command, spawnError)
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
          const answer = await specification.stdinResponder?.(record)
          if (answer !== undefined && answer !== null && child.stdin && !child.stdin.destroyed) child.stdin.write(`${answer}\n`)
          yield record
        }
        newline = buffer.indexOf(0x0a)
      }
      if (terminationReason) break
    }

    if (!terminationReason && buffer.byteLength > 0) {
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
    if (!closed && child.exitCode === null) terminate(terminationReason ?? 'abort')
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
