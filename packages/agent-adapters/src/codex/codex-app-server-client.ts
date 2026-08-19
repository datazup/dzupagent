import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'

import {
  CodexAppServerClientError,
  asClientError,
  malformedFrame,
  operationCancelled,
  type CodexAppServerClientLimits,
  type CodexAppServerClientOptions,
  type CodexAppServerInboundEvent,
  type CodexAppServerRequestOptions,
} from './codex-app-server-client-contracts.js'
import { normalizeLimits } from './codex-app-server-client-limits.js'
import {
  ensureNotCancelled,
  remainingTimeout,
  tightenedRequestTimeout,
} from './codex-app-server-client-timeouts.js'
import {
  assertInitializeResponse,
  boundedMethod,
  isRecord,
  validServerRequestId,
} from './codex-app-server-client-validation.js'
import { AsyncEventQueue } from './codex-app-server-event-queue.js'
import { qualifyArtifactDigest, qualifyExecutable } from './codex-app-server-executable.js'
import { CodexAppServerFrameReader } from './codex-app-server-frame-reader.js'
import { writeCodexAppServerFrame } from './codex-app-server-frame-writer.js'

// PUBLIC API, not a convenience: `codex-goal-control.ts`, `codex-app-server-adapter.ts`
// and the package export map all name these through THIS path, so each declaration
// moved into a layer stays re-exported here. The list is explicit rather than
// `export *` so the internal limit defaults, validators and framing helpers the
// layering also shares do not leak into the published surface.
export { CodexAppServerClientError } from './codex-app-server-client-contracts.js'
export type {
  CodexAppServerClientDependencies,
  CodexAppServerClientErrorCode,
  CodexAppServerClientLimits,
  CodexAppServerClientOptions,
  CodexAppServerInboundEvent,
  CodexAppServerRequestOptions,
  CodexAppServerSpawn,
} from './codex-app-server-client-contracts.js'
export { qualifyCodexAppServerExecutable } from './codex-app-server-executable.js'

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const MAX_RETIRED_REQUEST_IDS = 1_024

/**
 * Private JSONL stdio transport for one Codex App Server process.
 *
 * The client owns exactly one initialize/initialized handshake. It retains no
 * provider frames: callers receive only decoded method/params events, while
 * protocol failures are reduced to stable error codes with no raw payload.
 *
 * Framing is delegated to `CodexAppServerFrameReader`; this class owns the
 * JSON-RPC layer above it -- request correlation, the terminal-failure latch,
 * and process cleanup.
 */
export class CodexAppServerStdioClient {
  private readonly child: ChildProcess
  private readonly limits: Required<CodexAppServerClientLimits>
  private readonly pending = new Map<number, PendingRequest>()
  private readonly completedRequestIds = new Set<number>()
  private readonly eventQueue: AsyncEventQueue<CodexAppServerInboundEvent>
  private readonly frameReader: CodexAppServerFrameReader
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
    // `fail()` sets `closing` alongside `terminalError`, and a pending promise
    // can only settle on a later tick, so within one `accept()` call this single
    // predicate is exactly the pair of guards the inlined loop used to apply
    // before reading and after each dispatched frame.
    this.frameReader = new CodexAppServerFrameReader(this.limits, {
      onFrame: (line) => { this.acceptFrame(line) },
      onFailure: (error) => { this.fail(error) },
      isActive: () => !this.terminalError && !this.closing,
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
      this.frameReader.accept(chunk, true)
    })
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.frameReader.accept(chunk, false)
    })
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
    return writeCodexAppServerFrame(
      this.child.stdin,
      frame,
      this.limits.maxLineBytes,
      timeoutMs,
      signal,
    )
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
