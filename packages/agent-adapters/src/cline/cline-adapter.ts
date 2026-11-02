import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdapterCapabilityProfile, AdapterConfig, AgentCLIAdapter, AgentEvent, AgentInput, HealthStatus } from '../types.js'
import { normalizeClineEvent } from './cline-events.js'
import type { ClineBinding, ClineChildMessage, ClineStart } from './cline-worker-protocol.js'
import { boundedFrame, CLINE_LIMITS, ClineQueue, isChildMessage, sameBinding } from './cline-worker-protocol.js'
import type { ClineTransport, ClineTransportFactory } from './cline-worker-transport.js'
import { createClineTransport, settleWithin } from './cline-worker-transport.js'

export interface ClineAdapterConfig extends AdapterConfig {
  /** Existing host-provisioned Cline directory. Never populated or copied by the adapter. */
  profileDir: string
  provider: string
  model: string
  enableTools?: boolean
  approvalTimeoutMs?: number
}
interface PendingApproval { respond(approved: boolean): void; dispose(): void; expiresAt: number }

/** Standalone Cline SDK: one local Node worker per execution, never a shared hub. */
export class ClineAdapter implements AgentCLIAdapter {
  readonly providerId = 'cline' as const
  readonly backend = 'sdk' as const
  private config: ClineAdapterConfig
  private readonly active = new Set<AbortController>()
  private readonly approvals = new Map<string, PendingApproval>()

  constructor(config: ClineAdapterConfig, private readonly transportFactory: ClineTransportFactory = createClineTransport) {
    validateConfig(config)
    this.config = { ...config }
  }

  getCapabilities(): AdapterCapabilityProfile {
    return { supportsResume: false, supportsFork: false, supportsToolCalls: true, emitsToolCalls: true,
      executesToolLoop: true, supportsStreaming: true, supportsCostUsage: false,
      nativeToolControls: { mode: true, allowlist: false, blocklist: false } }
  }

  execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const config = { ...this.config }
    validateConfig(config)
    validateInput(input, config)
    const controller = new AbortController()
    const iterator = this.run(input, config, controller)
    // AsyncGenerator.return alone queues behind a pending next; wake that read first.
    return {
      next: value => iterator.next(value),
      return: value => { controller.abort(); return iterator.return(value) },
      throw: error => { controller.abort(); return iterator.throw(error) },
      [Symbol.asyncIterator]() { return this },
    }
  }

  private async *run(input: AgentInput, config: ClineAdapterConfig, controller: AbortController): AsyncGenerator<AgentEvent, void, undefined> {
    const binding: ClineBinding = { version: 1, runId: randomUUID(), sessionId: randomUUID() }
    const queue = new ClineQueue<ClineChildMessage>()
    const began = Date.now()
    let transport: ClineTransport | undefined
    let terminal = false
    let failure: string | undefined
    let workerTerminal = false
    let resolveFailure!: () => void
    const failureSignal = new Promise<void>(resolve => { resolveFailure = resolve })
    let closing: Promise<void> | undefined
    let receivedBytes = 0
    const ownedApprovals = new Set<string>()
    const clearApprovals = () => {
      for (const [id, pending] of this.approvals) if (id.startsWith(`${binding.runId}:`)) pending.dispose()
    }
    const closeTransport = (): Promise<void> => {
      clearApprovals()
      if (!transport) return Promise.resolve()
      if (!closing) {
        const owned = transport
        closing = (async () => {
          await settleWithin(owned.send({ ...binding, type: 'cancel' }), 100)
          await owned.shutdown()
        })()
        // Observed even when cancellation happens while the consumer is paused at yield.
        void closing.catch(() => undefined)
      }
      return closing
    }
    const fail = (code: string) => {
      if (!terminal && !failure) { failure = code; queue.close(); resolveFailure(); void closeTransport().catch(() => undefined) }
    }
    const abort = () => fail('CLINE_CANCELLED')
    const forwardAbort = () => controller.abort()
    const onMessage = (message: unknown) => {
      if (terminal || failure || workerTerminal) return
      if (!isChildMessage(message) || !sameBinding(binding, message)) { fail('CLINE_IPC_INVALID'); return }
      receivedBytes += Buffer.byteLength(JSON.stringify(message))
      if (receivedBytes > CLINE_LIMITS.outputBytes || !queue.push(message)) fail('CLINE_OUTPUT_LIMIT')
      if (message.type === 'result' || message.type === 'fatal') workerTerminal = true
    }
    const send = (message: Parameters<ClineTransport['send']>[0]) => {
      if (!transport) { fail('CLINE_IPC_SEND_FAILED'); return }
      void transport.send(message).catch(() => fail('CLINE_IPC_SEND_FAILED'))
    }
    this.active.add(controller)
    controller.signal.addEventListener('abort', abort, { once: true })
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
    if (input.signal?.aborted || controller.signal.aborted) abort()
    const timer = setTimeout(() => fail('CLINE_TIMEOUT'), config.timeoutMs ?? 120_000)
    try {
      if (!failure) {
        // Factory resolution is raced against cancellation/timeout; a late child is always reaped.
        const opened = this.transportFactory(binding, onMessage, code => {
          if (!workerTerminal || !['CLINE_WORKER_EXITED', 'CLINE_WORKER_DISCONNECTED'].includes(code)) fail(code)
        })
        const raced = await Promise.race([
          opened.then(value => value),
          failureSignal.then(() => undefined),
        ])
        if (raced) transport = raced
        else {
          void opened.then(async value => { await value.shutdown() }).catch(() => undefined)
        }
      }
      const start = makeStart(input, config, binding)
      let ready = false
      while (!failure) {
        const message = await queue.next()
        if (failure || !message) break
        if (!ready) {
          if (message.type !== 'ready') { fail('CLINE_IPC_ORDER'); break }
          ready = true
          send(start)
          yield { type: 'adapter:started', providerId: this.providerId, sessionId: binding.sessionId,
            model: config.model, workingDirectory: start.cwd, timestamp: Date.now(), correlationId: input.correlationId }
        } else if (message.type === 'event') yield normalizeClineEvent(message.event, input.correlationId)
        else if (message.type === 'approval_request') {
          if (ownedApprovals.size >= CLINE_LIMITS.approvals || ownedApprovals.has(message.requestId)) { fail('CLINE_APPROVAL_LIMIT'); break }
          const id = `${binding.runId}:${message.requestId}`
          const expiresAt = Date.now() + start.approvalTimeoutMs
          ownedApprovals.add(message.requestId)
          const respond = (approved: boolean) => {
            clearTimeout(expiry)
            this.approvals.delete(id)
            ownedApprovals.delete(message.requestId)
            send({ ...binding, type: 'approval_response', requestId: message.requestId,
              approved: approved && !controller.signal.aborted && !failure && !terminal && Date.now() < expiresAt })
          }
          const expiry = setTimeout(() => respond(false), start.approvalTimeoutMs)
          this.approvals.set(id, { respond, expiresAt, dispose: () => {
            clearTimeout(expiry); this.approvals.delete(id); ownedApprovals.delete(message.requestId)
          } })
          if (config.interactionPolicy?.mode === 'auto-deny' || !start.enableTools) respond(false)
          else yield { type: 'adapter:interaction_required', providerId: this.providerId, interactionId: id,
            question: `Allow Cline tool ${message.toolName}?`, kind: 'permission', expiresAt,
            timestamp: Date.now(), correlationId: input.correlationId }
        } else if (message.type === 'result') {
          await closeTransport()
          terminal = true
          if (failure) yield failed(binding.sessionId, failure, input.correlationId)
          else if (message.success) yield { type: 'adapter:completed', providerId: this.providerId,
            sessionId: binding.sessionId, result: message.text, durationMs: Date.now() - began,
            ...(message.usage ? { usage: message.usage } : {}), timestamp: Date.now(), correlationId: input.correlationId }
          else yield failed(binding.sessionId, message.reason, input.correlationId)
          break
        } else if (message.type === 'fatal') { fail(message.code); break }
        else { fail('CLINE_IPC_ORDER'); break }
      }
      if (!terminal) { await closeTransport(); terminal = true; yield failed(binding.sessionId, failure ?? 'CLINE_WORKER_EXITED', input.correlationId) }
    } catch {
      if (!terminal) { terminal = true; yield failed(binding.sessionId, failure ?? 'CLINE_WORKER_START_FAILED', input.correlationId) }
    } finally {
      terminal = true
      clearTimeout(timer)
      queue.close()
      clearApprovals()
      input.signal?.removeEventListener('abort', forwardAbort)
      controller.signal.removeEventListener('abort', abort)
      this.active.delete(controller)
      await closeTransport().catch(() => undefined)
    }
  }

  respondInteraction(interactionId: string, answer: string): boolean {
    const pending = this.approvals.get(interactionId)
    if (!pending) return false
    pending.respond(answer.trim().toLowerCase() === 'yes' && Date.now() < pending.expiresAt)
    return true
  }
  async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> { throw new Error('CLINE_RESUME_UNSUPPORTED') }
  interrupt(): void { for (const controller of this.active) controller.abort() }
  configure(options: Partial<ClineAdapterConfig>): void {
    const next = { ...this.config, ...options }
    validateConfig(next)
    this.config = next
  }
  async healthCheck(): Promise<HealthStatus> {
    let sdkInstalled = false
    try { sdkInstalled = existsSync(fileURLToPath(import.meta.resolve('@cline/sdk'))) } catch { /* Optional dependency. */ }
    return { providerId: this.providerId, healthy: sdkInstalled, sdkInstalled, cliAvailable: false,
      ...(!sdkInstalled ? { lastError: 'CLINE_SDK_UNAVAILABLE' } : {}) }
  }
}

function failed(sessionId: string, code: string, correlationId?: string): AgentEvent {
  return { type: 'adapter:failed', providerId: 'cline', sessionId, error: code, code, timestamp: Date.now(), correlationId }
}
function makeStart(input: AgentInput, config: ClineAdapterConfig, binding: ClineBinding): ClineStart {
  return { ...binding, type: 'start', profileDir: config.profileDir,
    cwd: input.workingDirectory ?? config.workingDirectory!, provider: config.provider, model: config.model,
    prompt: input.prompt, systemPrompt: input.systemPrompt ?? '', enableTools: config.enableTools ?? true,
    approvalTimeoutMs: config.approvalTimeoutMs ?? config.interactionPolicy?.askCaller?.timeoutMs ?? 30_000,
    ...(input.maxTurns ? { maxIterations: input.maxTurns } : {}) }
}
function validateConfig(config: ClineAdapterConfig): void {
  const allowed = new Set(['profileDir', 'provider', 'model', 'workingDirectory', 'enableTools', 'approvalTimeoutMs', 'timeoutMs', 'interactionPolicy'])
  for (const key of Object.keys(config)) if (!allowed.has(key) && config[key as keyof ClineAdapterConfig] !== undefined) throw new Error(`CLINE_UNSUPPORTED_CONFIG: ${key}`)
  if (typeof config.profileDir !== 'string' || !isAbsolute(config.profileDir) || config.profileDir.length > 512 ||
    typeof config.provider !== 'string' || !config.provider || config.provider.length > 512 ||
    typeof config.model !== 'string' || !config.model || config.model.length > 512) throw new Error('CLINE_EXPLICIT_PROFILE_PROVIDER_MODEL_REQUIRED')
  if (config.workingDirectory && !isAbsolute(config.workingDirectory)) throw new Error('CLINE_ABSOLUTE_CWD_REQUIRED')
  if (config.enableTools !== undefined && typeof config.enableTools !== 'boolean') throw new Error('CLINE_INVALID_TOOLS')
  for (const value of [config.timeoutMs, config.approvalTimeoutMs, config.interactionPolicy?.askCaller?.timeoutMs]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 300_000)) throw new Error('CLINE_INVALID_TIMEOUT')
  if (config.interactionPolicy && !['ask-caller', 'auto-deny'].includes(config.interactionPolicy.mode)) throw new Error('CLINE_AUTO_APPROVE_UNSUPPORTED')
  if (config.interactionPolicy?.askCaller?.timeoutFallback === 'auto-approve' || config.interactionPolicy?.defaultAnswers || config.interactionPolicy?.aiAutonomous) throw new Error('CLINE_AUTO_APPROVE_UNSUPPORTED')
}
function validateInput(input: AgentInput, config: ClineAdapterConfig): void {
  if (input.resumeSessionId !== undefined) throw new Error('CLINE_RESUME_UNSUPPORTED')
  if (input.maxBudgetUsd !== undefined || input.outputSchema !== undefined || input.executionControlRequirement !== undefined || input.policyContext !== undefined) throw new Error('CLINE_UNSUPPORTED_CONTROL')
  if (input.options && Object.keys(input.options).length) throw new Error('CLINE_UNSUPPORTED_OPTIONS')
  const cwd = input.workingDirectory ?? config.workingDirectory
  if (!cwd || !isAbsolute(cwd) || cwd.length > 512) throw new Error('CLINE_ABSOLUTE_CWD_REQUIRED')
  if (input.maxTurns !== undefined && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1)) throw new Error('CLINE_INVALID_MAX_TURNS')
  if (typeof input.prompt !== 'string' || (input.systemPrompt !== undefined && typeof input.systemPrompt !== 'string') ||
    !boundedFrame(makeStart(input, config, { version: 1, runId: '0'.repeat(36), sessionId: '0'.repeat(36) }))) throw new Error('CLINE_INPUT_LIMIT')
}
