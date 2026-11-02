import { randomUUID } from 'node:crypto'
import { BaseSdkAdapter } from '../base/base-sdk-adapter.js'
import { normalizeAdapterError } from '../base/adapter-error-normalizer.js'
import { InteractionResolver } from '../interaction/interaction-resolver.js'
import type { AdapterCapabilityProfile, AdapterConfig, AgentEvent, AgentInput, HealthStatus } from '../types.js'
import { PiEventMapper, PiEventQueue, piText } from './pi-events.js'
import { createPiSession, openPiManager, piError, piRunConfig } from './pi-session.js'
import type { PiErrorReason, PiRunConfig } from './pi-session.js'
import type { PiSdk, PiSdkLoader, PiSession, PiToolCall, PiToolDecision } from './pi-sdk-types.js'

/**
 * Pi SDK adapter. providerOptions requires existing absolute agentDir/sessionDir
 * and an explicit provider; config.model selects that provider's model. SDK
 * injection is for host integration/tests, never a second provider abstraction.
 */
export class PiAdapter extends BaseSdkAdapter<PiSdk> {
  readonly providerId = 'pi' as const
  private loaded: Promise<PiSdk> | undefined
  private readonly runs = new Set<PiRun>()

  constructor(config: AdapterConfig = {}, private readonly sdkLoader?: PiSdkLoader) {
    super(structuredClone(config))
  }

  override configure(config: Partial<AdapterConfig>): void {
    super.configure(structuredClone(config))
  }

  async loadSdk(): Promise<PiSdk> {
    this.loaded ??= (async () => {
      const sdk = this.sdkLoader ? await this.sdkLoader() : await this.loadOptionalSdkModule<PiSdk>(
        '@earendil-works/pi-coding-agent', { providerId: 'pi', installHint: 'Install @earendil-works/pi-coding-agent@1.5.0 in the consuming host' },
      )
      if (sdk.VERSION !== '1.5.0' || typeof sdk.createAgentSession !== 'function' ||
          typeof sdk.DefaultResourceLoader !== 'function' || typeof sdk.SettingsManager?.inMemory !== 'function' ||
          typeof sdk.ModelRuntime?.create !== 'function' || typeof sdk.readStoredCredential !== 'function' ||
          typeof sdk.SessionManager?.create !== 'function' ||
          typeof sdk.SessionManager?.findById !== 'function' || typeof sdk.SessionManager?.open !== 'function') {
        throw piError('ADAPTER_SDK_INCOMPATIBLE', 'Pi requires the verified 1.5.0 SDK exports')
      }
      return sdk
    })()
    return this.loaded
  }

  execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    let run: PiRun
    run = new PiRun(structuredClone(this.config), {
      ...input, options: structuredClone(input.options), policyContext: structuredClone(input.policyContext),
      outputSchema: structuredClone(input.outputSchema),
    }, () => this.loadSdk(), () => { this.runs.delete(run) })
    this.runs.add(run)
    return run.iterator()
  }

  resumeSession(sessionId: string, input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    return this.execute({ ...input, resumeSessionId: sessionId })
  }

  override respondInteraction(interactionId: string, answer: string): boolean {
    for (const run of this.runs) if (run.respond(interactionId, answer)) return true
    return false
  }

  interrupt(): void {
    for (const run of [...this.runs]) run.cancel('EXECUTION_CANCELLED', 'Pi execution interrupted')
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.loadSdk()
      return { healthy: true, providerId: 'pi', sdkInstalled: true, cliAvailable: false }
    } catch (error) {
      return { healthy: false, providerId: 'pi', sdkInstalled: false, cliAvailable: false, lastError: normalizeAdapterError(error).message }
    }
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true, supportsFork: false, supportsToolCalls: true,
      emitsToolCalls: true, executesToolLoop: true, supportsStreaming: true, supportsCostUsage: true,
      nativeToolControls: { mode: false, allowlist: true, blocklist: true },
      supportsZeroToolDispatch: false,
    }
  }
}

class PiRun {
  private readonly controller = new AbortController()
  private readonly queue: PiEventQueue
  private begun = false
  private terminal = false
  private closed = false
  private session: PiSession | undefined
  private disposed = false
  private unsubscribe: (() => void) | undefined
  private unhook: (() => void) | undefined
  private releaseSession: (() => void) | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private resolver: InteractionResolver | undefined
  private readonly interactions = new Set<string>()
  private settings: PiRunConfig | undefined
  private mapper: PiEventMapper | undefined
  private gateRegistered = false
  private sessionId: string | undefined
  private readonly startedAt = Date.now()
  // Captured for diagnostics only. New-run usage comes exclusively from events.
  lifetimeStatsAtStart: ReturnType<PiSession['getSessionStats']> | undefined
  private readonly callerAbort = () => this.cancel('EXECUTION_CANCELLED', 'Pi execution cancelled')

  constructor(
    private readonly config: AdapterConfig, private readonly input: AgentInput,
    private readonly loadSdk: PiSdkLoader, private readonly onFinish: () => void,
  ) {
    const capacity = config.providerOptions?.['queueCapacity']
    this.queue = new PiEventQueue(typeof capacity === 'number' && Number.isSafeInteger(capacity) && capacity > 0 && capacity <= 65_536 ? capacity : 256)
  }

  iterator(): AsyncGenerator<AgentEvent, void, undefined> {
    const self = this
    // An async-generator finally cannot run while next() is suspended. These
    // structural methods cancel FIRST, waking a pending next() immediately.
    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (!self.begun && !self.closed && !self.terminal) {
          self.begun = true
          void self.produce().catch(error => self.fail(error)).finally(() => {
            self.cleanup(false)
            self.releaseSession?.()
            self.releaseSession = undefined
          })
        }
        return self.queue.next()
      },
      async return() {
        self.closed = true
        self.cancel('EXECUTION_CANCELLED', 'Pi iterator closed')
        self.queue.close()
        return { done: true, value: undefined }
      },
      async throw(error: unknown) {
        self.closed = true
        self.cancel('EXECUTION_CANCELLED', 'Pi iterator threw')
        self.queue.close()
        throw error
      },
    }
  }

  respond(id: string, answer: string): boolean {
    if (this.terminal || this.controller.signal.aborted || !this.interactions.has(id)) return false
    return this.resolver?.respond(id, answer) ?? false
  }

  cancel(code: PiErrorReason, message: string): void {
    if (this.terminal) return
    this.controller.abort()
    this.fail(piError(code, message))
  }

  private publish(event: AgentEvent): void {
    if (this.terminal) return
    if (!this.queue.push(event)) this.cancel('ADAPTER_EVENT_QUEUE_OVERFLOW', 'Pi event queue exceeded its bounded capacity')
  }

  private finish(event: AgentEvent): void {
    if (this.terminal) return
    this.terminal = true
    this.queue.finish(event)
    this.cleanup(this.controller.signal.aborted)
    this.onFinish()
  }

  private fail(error: unknown): void {
    const normalized = normalizeAdapterError(error)
    this.finish({ type: 'adapter:failed', providerId: 'pi', sessionId: this.sessionId,
      error: normalized.message, code: normalized.code, usage: this.mapper?.usage.snapshot(),
      timestamp: Date.now(), correlationId: this.input.correlationId })
  }

  private cleanup(abort: boolean): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.input.signal?.removeEventListener('abort', this.callerAbort)
    this.interactions.clear()
    this.resolver?.dispose() // Only deny-on-dispose policies reach this point.
    this.resolver = undefined
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    const unhook = this.unhook
    this.unhook = undefined
    try { unsubscribe?.() } catch { /* Teardown must continue. */ }
    try { unhook?.() } catch { /* Teardown must continue. */ }
    if (this.session && !this.disposed) {
      this.disposed = true
      if (abort) {
        try { void this.session.abort().catch(() => undefined) } catch { /* Synchronous abort failure is observed too. */ }
      }
      try { this.session.dispose() } catch { /* No second terminal event on cleanup failure. */ }
    }
  }

  private checkCancelled(): void {
    if (this.controller.signal.aborted) throw piError('EXECUTION_CANCELLED', 'Pi execution cancelled')
  }

  private async produce(): Promise<void> {
    this.input.signal?.addEventListener('abort', this.callerAbort, { once: true })
    if (this.input.signal?.aborted) { this.callerAbort(); return }
    this.settings = piRunConfig(this.config, this.input)
    const settings = this.settings
    this.resolver = new InteractionResolver(settings.interactionPolicy)
    this.timer = setTimeout(() => this.cancel('EXECUTION_TIMEOUT', 'Pi execution timed out'), settings.timeoutMs)
    const sdk = await this.loadSdk()
    this.checkCancelled()
    const { manager, release } = openPiManager(sdk, settings, this.input.resumeSessionId)
    this.releaseSession = release
    this.checkCancelled()
    this.session = await createPiSession(sdk, settings, manager, this.controller.signal, api => {
      this.checkCancelled()
      if (this.gateRegistered) throw piError('ADAPTER_SDK_INCOMPATIBLE', 'Pi approval extension registered twice')
      this.unhook = api.on('tool_call', event => this.approveTool(event))
      this.gateRegistered = true
    })
    this.checkCancelled()
    if (!this.gateRegistered) throw piError('ADAPTER_SDK_INCOMPATIBLE', 'Pi did not load the required host approval extension')
    this.sessionId = this.session.sessionId
    if (!this.sessionId || this.sessionId !== manager.getSessionId()) throw piError('SESSION_INVALID', 'Pi runtime session ID does not match its manager')
    this.lifetimeStatsAtStart = structuredClone(this.session.getSessionStats())
    this.mapper = new PiEventMapper(this.session.messages, this.input.correlationId)
    this.unsubscribe = this.session.subscribe(event => {
      if (this.terminal) return
      try {
        const mapped = this.mapper!.map(event)
        if (mapped) this.publish(mapped)
      } catch (error) {
        this.controller.abort()
        this.fail(error)
      }
    })
    this.publish({ type: 'adapter:started', providerId: 'pi', sessionId: this.sessionId, timestamp: Date.now(),
      model: settings.model, workingDirectory: settings.cwd, isResume: this.input.resumeSessionId !== undefined,
      correlationId: this.input.correlationId })
    this.checkCancelled()
    // Await the whole prompt, not agent_end, and always observe its rejection.
    await this.session.prompt(this.input.prompt, { expandPromptTemplates: false, source: 'rpc' })
    this.checkCancelled()
    const latest = this.mapper.latest
    if (this.mapper.aborted || latest?.stopReason === 'aborted') throw piError('EXECUTION_CANCELLED', 'Pi provider aborted the run')
    if (latest?.stopReason === 'error') throw piError('PROVIDER_ERROR', latest.errorMessage ?? 'Pi provider failed')
    if (!latest || !['stop', 'length'].includes(latest.stopReason ?? '') || latest.deferred !== undefined ||
        this.session.isStreaming || this.session.isRetrying || this.session.pendingMessageCount > 0 ||
        this.session.state.pendingToolCalls.size > 0 || this.mapper.pendingTools.size > 0 ||
        (Array.isArray(latest.content) && latest.content.some(block => block.type === 'toolCall'))) {
      throw piError('ADAPTER_INCOMPLETE_RESULT', 'Pi prompt settled without a finalized assistant answer')
    }
    this.finish({ type: 'adapter:completed', providerId: 'pi', sessionId: this.sessionId,
      result: piText(latest.content), usage: this.mapper.usage.snapshot(), durationMs: Date.now() - this.startedAt,
      timestamp: Date.now(), correlationId: this.input.correlationId })
  }

  private async approveTool(event: PiToolCall): Promise<PiToolDecision | undefined> {
    const denied = { block: true, reason: 'Host denied Pi tool execution', terminate: true } as const
    if (this.terminal || this.controller.signal.aborted || !this.resolver || !this.settings ||
        !event || event.type !== 'tool_call' || typeof event.toolCallId !== 'string' || !event.toolCallId ||
        typeof event.toolName !== 'string' || !event.toolName || event.input === null ||
        typeof event.input !== 'object' || Array.isArray(event.input)) return denied
    let serializedInput: string
    try { serializedInput = JSON.stringify(event.input) } catch { return denied }
    const id = `pi:${randomUUID()}`
    const question = `Allow Pi tool ${event.toolName}? ${serializedInput}`
    const resolver = this.resolver
    this.interactions.add(id)
    try {
      // resolve() synchronously registers ask-caller before publication.
      const answerPromise = resolver.resolve({ interactionId: id, question, kind: 'permission' })
      if (this.settings.interactionPolicy.mode === 'ask-caller') {
        this.publish({ type: 'adapter:interaction_required', providerId: 'pi', interactionId: id, question,
          kind: 'permission', expiresAt: Date.now() + (this.settings.interactionPolicy.askCaller?.timeoutMs ?? 60_000),
          timestamp: Date.now(), correlationId: this.input.correlationId })
      }
      const result = await answerPromise
      // Cancellation wins even if a yes response has already resolved the promise.
      if (this.terminal || this.controller.signal.aborted || !this.interactions.has(id)) return denied
      this.publish({ type: 'adapter:interaction_resolved', providerId: 'pi', interactionId: id, question,
        answer: result.answer, resolvedBy: result.resolvedBy, timestamp: Date.now(), correlationId: this.input.correlationId })
      return !this.terminal && !this.controller.signal.aborted && JSON.stringify(event.input) === serializedInput &&
        result.answer.trim().toLowerCase() === 'yes' ? undefined : denied
    } catch {
      return denied
    } finally {
      this.interactions.delete(id)
    }
  }
}
