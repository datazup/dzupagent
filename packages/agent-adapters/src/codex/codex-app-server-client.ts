import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'

import type { ResolvedProbeExecutable } from '../introspection/index.js'
import {
  digestExecutableArtifact,
  validExecutableArtifactDigest,
} from '../introspection/executable-artifact.js'

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

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000
const DEFAULT_MAX_LINE_BYTES = 512_000
const DEFAULT_MAX_AGGREGATE_OUTPUT_BYTES = 8_000_000
const DEFAULT_MAX_FRAMES = 10_000
const DEFAULT_MAX_PENDING_REQUESTS = 32
const DEFAULT_MAX_QUEUED_EVENTS = 256
const MAX_RETIRED_REQUEST_IDS = 1_024

/**
 * Private JSONL stdio transport for one Codex App Server process.
 *
 * The client owns exactly one initialize/initialized handshake. It retains no
 * provider frames: callers receive only decoded method/params events, while
 * protocol failures are reduced to stable error codes with no raw payload.
 */
export class CodexAppServerStdioClient {
  private readonly child: ChildProcess
  private readonly limits: Required<CodexAppServerClientLimits>
  private readonly pending = new Map<number, PendingRequest>()
  private readonly completedRequestIds = new Set<number>()
  private readonly eventQueue: AsyncEventQueue<CodexAppServerInboundEvent>
  private readonly decoder = new StringDecoder('utf8')
  private stdoutBuffer = ''
  private aggregateOutputBytes = 0
  private frameCount = 0
  private nextRequestId = 1
  private initialized = false
  private closing = false
  private exited = false
  private terminalError: CodexAppServerClientError | undefined
  private cleanupPromise: Promise<void> | undefined
  private sigtermSent = false
  private sigkillSent = false

  private constructor(options: CodexAppServerClientOptions, executablePath: string) {
    this.limits = normalizeLimits(options.limits)
    this.eventQueue = new AsyncEventQueue(this.limits.maxQueuedEvents, (error) => {
      this.fail(error)
    })
    const spawnProcess = options.dependencies?.spawn ?? spawn
    this.child = spawnProcess(
      executablePath,
      ['app-server', '--stdio'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: { ...options.env } } : {}),
      },
    )
    this.attachProcessListeners()
  }

  static async connect(
    options: CodexAppServerClientOptions,
    requestOptions: CodexAppServerRequestOptions = {},
  ): Promise<CodexAppServerStdioClient> {
    const limits = normalizeLimits(options.limits)
    const monotonicNow = options.dependencies?.monotonicNow ?? (() => performance.now())
    const deadline = monotonicNow()
      + tightenedRequestTimeout(limits.requestTimeoutMs, requestOptions.timeoutMs)
    const signal = requestOptions.signal
    ensureNotCancelled(signal)
    const executablePath = await qualifyExecutable(options, deadline, monotonicNow, signal)
    ensureNotCancelled(signal)
    const client = new CodexAppServerStdioClient(options, executablePath)
    const abortClient = () => client.fail(operationCancelled())
    signal?.addEventListener('abort', abortClient, { once: true })
    if (signal?.aborted) abortClient()
    const clientInfo = options.clientInfo ?? {
      name: 'dzupagent_app_server',
      title: 'DzupAgent App Server',
      version: '0.2.0',
    }
    try {
      await qualifyArtifactDigest(options, executablePath, deadline, monotonicNow, signal)
      const initializeResult = await client.sendRequest('initialize', {
        clientInfo,
        capabilities: { experimentalApi: true },
      }, { timeoutMs: remainingTimeout(deadline, monotonicNow) })
      assertInitializeResponse(initializeResult)
      if (client.terminalError) throw client.terminalError
      await client.writeFrame({
        method: 'initialized',
        params: {},
      }, remainingTimeout(deadline, monotonicNow), signal)
      client.initialized = true
      return client
    } catch (error) {
      client.fail(asClientError(error, 'CODEX_APP_SERVER_REQUEST_FAILED'))
      try {
        await client.close()
      } catch (cleanupError) {
        throw asClientError(cleanupError, 'CODEX_APP_SERVER_CLEANUP_FAILED')
      }
      throw client.terminalError ?? error
    } finally {
      signal?.removeEventListener('abort', abortClient)
    }
  }

  events(): AsyncIterable<CodexAppServerInboundEvent> {
    return this.eventQueue
  }

  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: CodexAppServerRequestOptions = {},
  ): Promise<unknown> {
    if (!this.initialized) {
      return Promise.reject(new CodexAppServerClientError(
        'CODEX_APP_SERVER_CLOSED',
        'Codex app-server request attempted before initialization',
      ))
    }
    return this.sendRequest(method, params, options)
  }

  async close(): Promise<void> {
    if (this.exited) {
      this.eventQueue.close()
      return
    }
    if (!this.closing) {
      this.closing = true
      this.rejectPending(new CodexAppServerClientError(
        'CODEX_APP_SERVER_CLOSED',
        'Codex app-server client closed',
      ))
      this.eventQueue.close()
      this.child.stdin?.end()
    }
    await this.beginCleanup()
  }

  private attachProcessListeners(): void {
    if (!this.child.stdin || !this.child.stdout || !this.child.stderr) {
      this.fail(new CodexAppServerClientError(
        'CODEX_APP_SERVER_PROCESS_DIED',
        'Codex app-server stdio pipes were unavailable',
      ))
      return
    }

    this.child.on('error', () => {
      this.fail(new CodexAppServerClientError(
        'CODEX_APP_SERVER_PROCESS_DIED',
        'Codex app-server process failed',
      ))
    })
    this.child.on('exit', () => {
      this.exited = true
      if (!this.closing && !this.terminalError) {
        this.fail(new CodexAppServerClientError(
          'CODEX_APP_SERVER_PROCESS_DIED',
          'Codex app-server exited before the client closed',
        ))
      }
    })
    this.child.stdout.on('data', (chunk: Buffer | string) => {
      this.acceptOutput(chunk, true)
    })
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.acceptOutput(chunk, false)
    })
  }

  private acceptOutput(chunk: Buffer | string, stdout: boolean): void {
    if (this.terminalError || this.closing) return
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength
    this.aggregateOutputBytes += bytes
    if (this.aggregateOutputBytes > this.limits.maxAggregateOutputBytes) {
      this.fail(new CodexAppServerClientError(
        'CODEX_APP_SERVER_OUTPUT_LIMIT',
        'Codex app-server output exceeded its aggregate limit',
      ))
      return
    }
    if (!stdout) return

    this.stdoutBuffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    for (;;) {
      const boundary = this.stdoutBuffer.indexOf('\n')
      if (boundary < 0) break
      const line = this.stdoutBuffer.slice(0, boundary)
      this.stdoutBuffer = this.stdoutBuffer.slice(boundary + 1)
      if (Buffer.byteLength(line, 'utf8') > this.limits.maxLineBytes) {
        this.fail(new CodexAppServerClientError(
          'CODEX_APP_SERVER_LINE_LIMIT',
          'Codex app-server frame exceeded its line limit',
        ))
        return
      }
      if (line.trim().length === 0) continue
      this.frameCount += 1
      if (this.frameCount > this.limits.maxFrames) {
        this.fail(new CodexAppServerClientError(
          'CODEX_APP_SERVER_FRAME_LIMIT',
          'Codex app-server emitted too many frames',
        ))
        return
      }
      this.acceptFrame(line)
      if (this.terminalError) return
    }
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.limits.maxLineBytes) {
      this.fail(new CodexAppServerClientError(
        'CODEX_APP_SERVER_LINE_LIMIT',
        'Codex app-server frame exceeded its line limit',
      ))
    }
  }

  private acceptFrame(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      this.fail(malformedFrame())
      return
    }
    // Codex omits the JSON-RPC version header on the wire. Accepting a valid
    // 2.0 header keeps replay fixtures compatible without emitting one.
    if (!isRecord(parsed) || (parsed['jsonrpc'] !== undefined && parsed['jsonrpc'] !== '2.0')) {
      this.fail(malformedFrame())
      return
    }

    const method = parsed['method']
    const hasId = Object.hasOwn(parsed, 'id')
    if (typeof method === 'string') {
      const params = parsed['params'] === undefined ? {} : parsed['params']
      if (!isRecord(params) || (hasId && !validServerRequestId(parsed['id']))) {
        this.fail(malformedFrame())
        return
      }
      this.eventQueue.push({
        kind: hasId ? 'request' : 'notification',
        method,
        params,
        ...(hasId ? { requestId: parsed['id'] as string | number } : {}),
      })
      return
    }

    if (!hasId || !Number.isSafeInteger(parsed['id'])) {
      this.fail(malformedFrame())
      return
    }
    const id = Number(parsed['id'])
    const hasResult = Object.hasOwn(parsed, 'result')
    const hasError = Object.hasOwn(parsed, 'error')
    if (hasResult === hasError) {
      this.fail(malformedFrame())
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      this.fail(new CodexAppServerClientError(
        this.completedRequestIds.has(id)
          ? 'CODEX_APP_SERVER_DUPLICATE_RESPONSE'
          : 'CODEX_APP_SERVER_LATE_RESPONSE',
        this.completedRequestIds.has(id)
          ? 'Codex app-server emitted a duplicate response'
          : 'Codex app-server emitted a late or unknown response',
      ))
      return
    }

    this.pending.delete(id)
    clearTimeout(pending.timer)
    this.retireRequestId(id)
    if (hasError) {
      pending.reject(new CodexAppServerClientError(
        'CODEX_APP_SERVER_REQUEST_FAILED',
        'Codex app-server request failed',
      ))
    } else {
      pending.resolve(parsed['result'])
    }
  }

  private sendRequest(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: CodexAppServerRequestOptions = {},
  ): Promise<unknown> {
    if (this.terminalError || this.closing || this.exited) {
      return Promise.reject(this.terminalError ?? new CodexAppServerClientError(
        'CODEX_APP_SERVER_CLOSED',
        'Codex app-server client is closed',
      ))
    }
    if (this.pending.size >= this.limits.maxPendingRequests) {
      const error = new CodexAppServerClientError(
        'CODEX_APP_SERVER_PENDING_LIMIT',
        'Codex app-server pending request limit was exceeded',
      )
      this.fail(error)
      return Promise.reject(error)
    }
    if (!boundedMethod(method) || this.nextRequestId > Number.MAX_SAFE_INTEGER) {
      const error = malformedFrame()
      this.fail(error)
      return Promise.reject(error)
    }

    let timeoutMs: number
    try {
      timeoutMs = tightenedRequestTimeout(this.limits.requestTimeoutMs, options.timeoutMs)
    } catch (error) {
      return Promise.reject(error)
    }

    const id = this.nextRequestId
    this.nextRequestId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        const error = new CodexAppServerClientError(
          'CODEX_APP_SERVER_TIMEOUT',
          'Codex app-server request timed out',
        )
        pending.reject(error)
        this.fail(error)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      void this.writeFrame({
        id,
        method,
        params,
      }, timeoutMs).catch((error: unknown) => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        const clientError = asClientError(error, 'CODEX_APP_SERVER_WRITE_FAILED')
        pending.reject(clientError)
        this.fail(clientError)
      })
    })
  }

  private writeFrame(
    frame: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new CodexAppServerClientError(
        'CODEX_APP_SERVER_WRITE_FAILED',
        'Codex app-server stdin is unavailable',
      ))
    }
    const bytes = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(bytes, 'utf8') > this.limits.maxLineBytes) {
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

  private retireRequestId(id: number): void {
    this.completedRequestIds.add(id)
    if (this.completedRequestIds.size <= MAX_RETIRED_REQUEST_IDS) return
    const first = this.completedRequestIds.values().next().value as number | undefined
    if (first !== undefined) this.completedRequestIds.delete(first)
  }

  private fail(error: CodexAppServerClientError): void {
    if (this.terminalError) return
    this.terminalError = error
    this.closing = true
    this.rejectPending(error)
    this.eventQueue.fail(error)
    this.child.stdin?.destroy()
    void this.beginCleanup().catch(() => undefined)
  }

  private beginCleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.terminateProcess()
      void this.cleanupPromise.catch(() => undefined)
    }
    return this.cleanupPromise
  }

  private async terminateProcess(): Promise<void> {
    if (this.exited) return
    try {
      if (!this.sigtermSent) {
        this.sigtermSent = true
        this.child.kill('SIGTERM')
      }
      if (await this.waitForExit(this.limits.cleanupTimeoutMs)) return
      if (!this.sigkillSent) {
        this.sigkillSent = true
        this.child.kill('SIGKILL')
      }
      if (await this.waitForExit(this.limits.cleanupTimeoutMs)) return
    } catch {
      // The stable cleanup code below intentionally omits process-authored detail.
    }
    throw new CodexAppServerClientError(
      'CODEX_APP_SERVER_CLEANUP_FAILED',
      'Codex app-server process did not terminate during cleanup',
    )
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child.off('exit', onExit)
        resolve(value)
      }
      const onExit = () => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.child.once('exit', onExit)
    })
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<T>) => void
    readonly reject: (error: Error) => void
  }> = []
  private closed = false
  private terminalError: Error | undefined

  constructor(
    private readonly maxValues: number,
    private readonly onOverflow: (error: CodexAppServerClientError) => void,
  ) {}

  push(value: T): void {
    if (this.closed || this.terminalError) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value, done: false })
      return
    }
    if (this.values.length >= this.maxValues) {
      this.onOverflow(new CodexAppServerClientError(
        'CODEX_APP_SERVER_OUTPUT_LIMIT',
        'Codex app-server event queue exceeded its limit',
      ))
      return
    }
    this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.values.splice(0)
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error): void {
    if (this.terminalError) return
    this.terminalError = error
    this.values.splice(0)
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.terminalError) return Promise.reject(this.terminalError)
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject })
        })
      },
    }
  }
}

export async function qualifyCodexAppServerExecutable(
  options: CodexAppServerClientOptions,
  requestOptions: CodexAppServerRequestOptions = {},
): Promise<string> {
  const limits = normalizeLimits(options.limits)
  const monotonicNow = options.dependencies?.monotonicNow ?? (() => performance.now())
  const deadline = monotonicNow()
    + tightenedRequestTimeout(limits.requestTimeoutMs, requestOptions.timeoutMs)
  return qualifyExecutable(options, deadline, monotonicNow, requestOptions.signal)
}

async function qualifyExecutable(
  options: CodexAppServerClientOptions,
  deadline: number,
  monotonicNow: () => number,
  signal?: AbortSignal,
): Promise<string> {
  ensureNotCancelled(signal)
  const identity = options.executable
  if (
    !identity
    || identity.name !== 'codex'
    || !isAbsolute(identity.path)
    || !isAbsolute(identity.realPath)
    || !validExecutableArtifactDigest(identity.artifactDigest)
  ) throw executableInvalid()

  const resolveRealPath = options.dependencies?.realpath ?? realpath
  const inspectStat = options.dependencies?.stat ?? stat
  const checkAccess = options.dependencies?.access ?? access
  let actualRealPath: string
  try {
    actualRealPath = await withinTimeout(
      resolveRealPath(identity.path),
      remainingTimeout(deadline, monotonicNow),
      signal,
    )
  } catch (error) {
    if (error instanceof CodexAppServerClientError && (
      error.code === 'CODEX_APP_SERVER_TIMEOUT'
      || error.code === 'CODEX_APP_SERVER_CANCELLED'
    )) {
      throw error
    }
    throw executableInvalid()
  }
  if (actualRealPath !== identity.realPath) throw executableInvalid()

  try {
    const executableStat = await withinTimeout(
      inspectStat(actualRealPath),
      remainingTimeout(deadline, monotonicNow),
      signal,
    )
    if (!executableStat.isFile()) throw executableInvalid()
  } catch (error) {
    if (error instanceof CodexAppServerClientError) throw error
    throw executableInvalid()
  }

  try {
    await withinTimeout(
      checkAccess(actualRealPath, constants.X_OK),
      remainingTimeout(deadline, monotonicNow),
      signal,
    )
  } catch (error) {
    if (error instanceof CodexAppServerClientError && (
      error.code === 'CODEX_APP_SERVER_TIMEOUT'
      || error.code === 'CODEX_APP_SERVER_CANCELLED'
    )) {
      throw error
    }
    throw executableInvalid()
  }
  await qualifyArtifactDigest(options, actualRealPath, deadline, monotonicNow, signal)
  ensureNotCancelled(signal)
  remainingTimeout(deadline, monotonicNow)
  return actualRealPath
}

async function qualifyArtifactDigest(
  options: CodexAppServerClientOptions,
  executablePath: string,
  deadline: number,
  monotonicNow: () => number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const digestArtifact = options.dependencies?.digestArtifact ?? digestExecutableArtifact
    const actualDigest = await withinTimeout(
      digestArtifact(executablePath),
      remainingTimeout(deadline, monotonicNow),
      signal,
    )
    if (actualDigest !== options.executable.artifactDigest) throw executableInvalid()
  } catch (error) {
    if (error instanceof CodexAppServerClientError) throw error
    throw executableInvalid()
  }
}

function assertInitializeResponse(value: unknown): void {
  if (!isRecord(value)
    || !boundedString(value['codexHome'], 4_096)
    || !isAbsolute(value['codexHome'])
    || !boundedString(value['platformFamily'], 256)
    || !boundedString(value['platformOs'], 256)
    || !boundedString(value['userAgent'], 1_024)) {
    throw new CodexAppServerClientError(
      'CODEX_APP_SERVER_INITIALIZE_INVALID',
      'Codex app-server returned an invalid initialize response',
    )
  }
}

function withinTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => finish(operationCancelled())
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    timer = setTimeout(() => finish(new CodexAppServerClientError(
      'CODEX_APP_SERVER_TIMEOUT',
      'Codex app-server operation timed out',
    )), timeoutMs)
    if (signal?.aborted) {
      finish(operationCancelled())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish(undefined, value),
      (error: unknown) => finish(error),
    )
  })
}

function ensureNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw operationCancelled()
}

function operationCancelled(): CodexAppServerClientError {
  return new CodexAppServerClientError(
    'CODEX_APP_SERVER_CANCELLED',
    'Codex app-server operation was cancelled',
  )
}

function remainingTimeout(deadline: number, monotonicNow: () => number): number {
  const remaining = Math.ceil(deadline - monotonicNow())
  if (!Number.isSafeInteger(remaining) || remaining < 1) {
    throw new CodexAppServerClientError(
      'CODEX_APP_SERVER_TIMEOUT',
      'Codex app-server operation timed out',
    )
  }
  return remaining
}

function tightenedRequestTimeout(configured: number, ceiling: number | undefined): number {
  if (ceiling === undefined) return configured
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
    throw new CodexAppServerClientError(
      'CODEX_APP_SERVER_TIMEOUT',
      'Codex app-server request had no remaining time',
    )
  }
  return Math.min(configured, ceiling)
}

function executableInvalid(): CodexAppServerClientError {
  return new CodexAppServerClientError(
    'CODEX_APP_SERVER_EXECUTABLE_INVALID',
    'Qualified Codex executable identity is unavailable or drifted',
  )
}

function normalizeLimits(
  limits: CodexAppServerClientLimits | undefined,
): Required<CodexAppServerClientLimits> {
  return {
    requestTimeoutMs: finiteLimit(
      limits?.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    cleanupTimeoutMs: finiteLimit(
      limits?.cleanupTimeoutMs,
      DEFAULT_CLEANUP_TIMEOUT_MS,
      DEFAULT_CLEANUP_TIMEOUT_MS,
    ),
    maxLineBytes: finiteLimit(limits?.maxLineBytes, DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_LINE_BYTES),
    maxAggregateOutputBytes: finiteLimit(
      limits?.maxAggregateOutputBytes,
      DEFAULT_MAX_AGGREGATE_OUTPUT_BYTES,
      DEFAULT_MAX_AGGREGATE_OUTPUT_BYTES,
    ),
    maxFrames: finiteLimit(limits?.maxFrames, DEFAULT_MAX_FRAMES, DEFAULT_MAX_FRAMES),
    maxPendingRequests: finiteLimit(
      limits?.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
      DEFAULT_MAX_PENDING_REQUESTS,
    ),
    maxQueuedEvents: finiteLimit(
      limits?.maxQueuedEvents,
      DEFAULT_MAX_QUEUED_EVENTS,
      DEFAULT_MAX_QUEUED_EVENTS,
    ),
  }
}

function finiteLimit(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new Error(`Codex app-server limit must be an integer between 1 and ${ceiling}`)
  }
  return value
}

function validServerRequestId(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0 && value.length <= 512)
    || (Number.isSafeInteger(value) && Number(value) >= 0)
}

function boundedMethod(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_./-]+$/u.test(value)
}

function malformedFrame(): CodexAppServerClientError {
  return new CodexAppServerClientError(
    'CODEX_APP_SERVER_MALFORMED_FRAME',
    'Codex app-server emitted a malformed frame',
  )
}

function asClientError(
  error: unknown,
  code: CodexAppServerClientErrorCode,
): CodexAppServerClientError {
  return error instanceof CodexAppServerClientError
    ? error
    : new CodexAppServerClientError(code, 'Codex app-server client operation failed')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}
