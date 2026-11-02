import { randomUUID } from 'node:crypto'
import type { AdapterCapabilityProfile, AdapterConfig, AgentCLIAdapter, AgentEvent, AgentInput, HealthStatus, InteractionPolicy } from '../types.js'
import type { OpenCodeClient, OpenCodeEvent, OpenCodeMessage, OpenCodePart, OpenCodePromptResult, OpenCodeResult, OpenCodeSdk, OpenCodeSdkLoader } from './opencode-sdk-types.js'
import { requireData } from './opencode-sdk-types.js'
import { OpenCodeEvents, record } from './opencode-events.js'
import { abortable, attachedEndpoint, boundedInteger, explicitDirectory, OpenCodeQueue, OpenCodeSessions, subscribeEvents } from './opencode-session.js'

export interface OpenCodeAdapterConfig extends AdapterConfig {
  baseUrl?: string
  cwd?: string
  mode?: 'attached' | 'owned'
  /** Exact tool IDs allowed for this turn; omitted means all inventory IDs disabled. */
  allowedTools?: readonly string[]
  requestTimeoutMs?: number
  cleanupTimeoutMs?: number
  maxOutputBytes?: number
  maxQueuedEvents?: number
}
export interface OpenCodeAdapterDependencies { loadSdk?: OpenCodeSdkLoader; fetch?: typeof globalThis.fetch }
type QueueItem = { event: OpenCodeEvent } | { result: OpenCodePromptResult }
type Pending = { controller: AbortController; answer: (value: boolean) => void }

async function loadSdk(): Promise<OpenCodeSdk> {
  const name = '@opencode-ai/sdk/client'
  try { return await import(/* webpackIgnore: true */ name) as OpenCodeSdk }
  catch { throw new Error('ADAPTER_SDK_NOT_INSTALLED: @opencode-ai/sdk/client 1.19.5 required') }
}

/** Attached client only. No server lifecycle, ambient config, credential or provider APIs. */
export class OpenCodeAdapter implements AgentCLIAdapter {
  readonly providerId = 'opencode' as const
  private readonly sessions = new OpenCodeSessions()
  private readonly active = new Set<AbortController>()
  private readonly interactions = new Map<string, Pending>()
  private sdk: Promise<OpenCodeSdk> | undefined

  constructor(private config: OpenCodeAdapterConfig = {}, private readonly dependencies: OpenCodeAdapterDependencies = {}) {}

  configure(options: Partial<OpenCodeAdapterConfig>): void { this.config = { ...this.config, ...options } }
  getCapabilities(): AdapterCapabilityProfile {
    return { supportsResume: true, supportsFork: false, supportsToolCalls: true, emitsToolCalls: true,
      executesToolLoop: true, supportsStreaming: true, supportsCostUsage: false,
      nativeToolControls: { allowlist: true, blocklist: true } }
  }
  async warmup(): Promise<void> { this.validate({ prompt: '' }); await this.getSdk() }
  async healthCheck(): Promise<HealthStatus> {
    try { this.validate({ prompt: '' }); await this.getSdk(); return { healthy: true, providerId: this.providerId, sdkInstalled: true, cliAvailable: false } }
    catch { return { healthy: false, providerId: this.providerId, sdkInstalled: false, cliAvailable: false, lastError: 'OpenCode optional client unavailable' } }
  }
  private getSdk(): Promise<OpenCodeSdk> {
    return this.sdk ??= Promise.resolve().then(this.dependencies.loadSdk ?? loadSdk).catch(() => {
      throw new Error('ADAPTER_SDK_NOT_INSTALLED: @opencode-ai/sdk/client 1.19.5 required')
    })
  }
  interrupt(): void { for (const controller of this.active) controller.abort() }
  respondInteraction(id: string, answer: string): boolean {
    const pending = this.interactions.get(id)
    if (!pending || pending.controller.signal.aborted) return false
    this.interactions.delete(id)
    pending.answer(/^(yes|approve|once)$/i.test(answer.trim()))
    return true
  }

  execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> { return this.iterator(input) }
  resumeSession(id: string, input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    return this.iterator({ ...input, resumeSessionId: id })
  }
  private iterator(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const controller = new AbortController()
    const source = this.run({ ...input }, controller)
    // Native generator.return() queues behind pending next(); abort it first.
    return {
      next: value => source.next(value),
      return: value => { controller.abort(); return source.return(value) },
      throw: error => { controller.abort(); return source.throw(error) },
      [Symbol.asyncIterator]() { return this },
    }
  }

  private validate(input: AgentInput) {
    if (typeof input.prompt !== 'string' || (input.systemPrompt !== undefined && typeof input.systemPrompt !== 'string')) throw new Error('Invalid OpenCode prompt')
    const config = { ...this.config }
    const supportedConfig = new Set(['baseUrl', 'cwd', 'workingDirectory', 'mode', 'allowedTools', 'requestTimeoutMs', 'cleanupTimeoutMs', 'maxOutputBytes', 'maxQueuedEvents', 'timeoutMs', 'model', 'interactionPolicy'])
    if (Object.entries(config).some(([key, value]) => value !== undefined && !supportedConfig.has(key))) throw new Error('Unsupported OpenCode configuration control')
    if (config.mode !== undefined && config.mode !== 'attached') throw new Error('OpenCode owned-server mode unsupported')
    const endpoint = attachedEndpoint(config.baseUrl)
    const cwd = explicitDirectory(input.workingDirectory ?? config.cwd ?? config.workingDirectory)
    const options = input.options ?? {}
    if (!record(options)) throw new Error('Invalid OpenCode options')
    const supported = new Set(['allowedTools', 'blockedTools', 'interactionPolicy'])
    if (Object.keys(options).some(key => !supported.has(key))) throw new Error('Unsupported OpenCode option')
    if (config.sandboxMode !== undefined || config.apiKey !== undefined || config.env !== undefined || config.envFilter !== undefined ||
        config.providerOptions !== undefined || config.reasoning !== undefined || config.thinkingBudgetTokens !== undefined ||
        config.promptCache !== undefined || config.skipGitRepoCheck !== undefined || input.maxTurns !== undefined ||
        input.maxBudgetUsd !== undefined || input.outputSchema !== undefined || input.executionControlRequirement !== undefined) {
      throw new Error('Unsupported OpenCode sandbox, credential, budget, turn, schema or execution control')
    }
    const policy = input.policyContext?.activePolicy
    if (input.policyContext && (input.policyContext.executionPolicy !== undefined || input.policyContext.projectedGuardrails !== undefined ||
        (policy && Object.keys(policy).some(key => !['allowedTools', 'blockedTools'].includes(key))))) {
      throw new Error('Unsupported OpenCode execution policy')
    }
    const strings = (value: unknown): string[] => {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item || item.length > 256)) throw new Error('Invalid OpenCode tool list')
      if (value.length > 1024) throw new Error('OpenCode tool list too large')
      return [...new Set(value as string[])]
    }
    let allowed = strings(options['allowedTools'] ?? config.allowedTools ?? [])
    if (policy?.allowedTools) { const subset = strings(policy.allowedTools); allowed = allowed.filter(tool => subset.includes(tool)) }
    const blocked = strings(options['blockedTools'] ?? [])
    blocked.push(...strings(policy?.blockedTools ?? []))
    allowed = allowed.filter(tool => !blocked.includes(tool))
    const selectedInteraction = (options['interactionPolicy'] ?? config.interactionPolicy ?? { mode: 'ask-caller' }) as InteractionPolicy
    const interaction = { ...selectedInteraction, askCaller: selectedInteraction.askCaller ? { ...selectedInteraction.askCaller } : undefined }
    if (!interaction || !['auto-approve', 'auto-deny', 'ask-caller'].includes(interaction.mode) || interaction.askCaller?.timeoutFallback === 'auto-approve') throw new Error('Unsupported OpenCode interaction policy')
    const interactionMs = boundedInteger(interaction.askCaller?.timeoutMs, 60000, 120000)
    let model: { providerID: string; modelID: string } | undefined
    if (config.model !== undefined) {
      if (typeof config.model !== 'string') throw new Error('Invalid OpenCode model')
      const slash = config.model.indexOf('/')
      if (slash < 1 || slash === config.model.length - 1) throw new Error('OpenCode model must be provider/model')
      model = { providerID: config.model.slice(0, slash), modelID: config.model.slice(slash + 1) }
    }
    return { endpoint, cwd, allowed, blocked, interaction, interactionMs, model,
      timeout: boundedInteger(config.timeoutMs, 120000, 3600000),
      requestTimeout: boundedInteger(config.requestTimeoutMs, 30000, 3600000),
      cleanupTimeout: boundedInteger(config.cleanupTimeoutMs, 2000, 10000),
      maxBytes: boundedInteger(config.maxOutputBytes, 1024 * 1024, 16 * 1024 * 1024),
      maxQueue: boundedInteger(config.maxQueuedEvents, 128, 1024) }
  }

  private async *run(input: AgentInput, controller: AbortController): AsyncGenerator<AgentEvent, void, undefined> {
    let sessionID: string | undefined
    let client: OpenCodeClient | undefined
    let stream: AsyncIterator<OpenCodeEvent> | undefined
    let release: (() => void) | undefined
    let stopped = false
    let succeeded = false
    let createdHere = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let terminal: AgentEvent | undefined
    let transportFailure: Error | undefined
    const permissions = new Set<string>()
    const signal = controller.signal
    const abort = () => controller.abort()
    let settings: ReturnType<OpenCodeAdapter['validate']> | undefined
    const base = () => ({ providerId: this.providerId, timestamp: Date.now(), correlationId: input.correlationId })
    const startedAt = Date.now()
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) controller.abort()
    try {
      if (this.active.size >= 32) throw new Error('OpenCode active turn limit')
      this.active.add(controller)
      settings = this.validate(input)
      const cfg = settings
      timeout = setTimeout(abort, cfg.timeout)
      if (signal.aborted) throw new Error('OpenCode operation cancelled')
      if (input.resumeSessionId) this.sessions.assert(input.resumeSessionId, cfg.endpoint, cfg.cwd)
      const sdk = await abortable(this.getSdk(), signal)
      const fetcher = this.boundedFetch(cfg.endpoint, cfg.requestTimeout, cfg.maxBytes, signal)
      try { client = sdk.createOpencodeClient({ baseUrl: cfg.endpoint, directory: cfg.cwd, fetch: fetcher }) }
      catch { throw new Error('OpenCode client initialization failed') }
      const request = { query: { directory: cfg.cwd }, signal, throwOnError: true as const }
      if (input.resumeSessionId) {
        sessionID = input.resumeSessionId
        release = await this.sessions.lock(sessionID, cfg.endpoint, cfg.cwd, signal)
      }
      const inventory = await this.request(() => client!.tool.ids(request), signal)
      if (!Array.isArray(inventory) || inventory.length > 1024 || inventory.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(inventory).size !== inventory.length) throw new Error('Invalid OpenCode tool inventory')
      if ([...cfg.allowed, ...cfg.blocked].some(id => !inventory.includes(id))) throw new Error('Unknown OpenCode tool ID')
      const tools: Record<string, boolean> = Object.fromEntries(inventory.map(id => [id, cfg.allowed.includes(id)]))
      if (!sessionID) {
        this.sessions.assertCapacity()
        const creation = Promise.resolve().then(() => client!.session.create({ ...request, body: { title: 'DzupAgent' } }))
        // A client that settles after cancellation still gets an independent abort.
        void creation.then(result => {
          if (signal.aborted && result.data?.id) void this.cleanupSession(client!, result.data.id, cfg.cwd, cfg.cleanupTimeout)
        }, () => undefined)
        const created = await this.request(() => creation, signal)
        if (!created.id || typeof created.id !== 'string' || created.id.length > 256 || this.sessions.has(created.id)) throw new Error('Invalid or reused OpenCode session ID')
        sessionID = created.id
        createdHere = true
        if (created.directory !== cfg.cwd) throw new Error('OpenCode created session at an unexpected cwd')
        this.sessions.add(sessionID, cfg.endpoint, cfg.cwd)
        release = await this.sessions.lock(sessionID, cfg.endpoint, cfg.cwd, signal)
      }
      const messageID = `msg_${randomUUID().replaceAll('-', '')}`
      const events = new OpenCodeEvents(sessionID, messageID, startedAt, cfg.maxBytes, new Set(cfg.allowed), input.correlationId)
      const queue = new OpenCodeQueue<QueueItem>(cfg.maxQueue, error => { transportFailure = error; controller.abort() })
      stream = subscribeEvents(fetcher, cfg.endpoint, cfg.cwd, signal, cfg.maxBytes)
      // The SSE connection is lazy. Start reading and require the first event
      // before sending the prompt, so a permission cannot outrun subscription.
      const first = await abortable(Promise.resolve(stream.next()), signal)
      if (first.done) throw new Error('OpenCode subscription closed before prompt')
      queue.push({ event: first.value })
      const iterator = stream
      void (async () => {
        try {
          while (!stopped && !signal.aborted) {
            const next = await abortable(Promise.resolve(iterator.next()), signal)
            if (stopped) break
            if (next.done) throw new Error('OpenCode subscription closed during prompt')
            queue.push({ event: next.value })
          }
        } catch { if (!stopped && !signal.aborted) queue.fail(new Error('OpenCode event subscription failed')) }
      })()
      const prompt = Promise.resolve().then(() => client!.session.prompt({ ...request, path: { id: sessionID! }, body: {
        messageID, parts: [{ type: 'text', text: input.prompt }], tools,
        ...(input.systemPrompt !== undefined ? { system: input.systemPrompt } : {}),
        ...(cfg.model ? { model: cfg.model } : {}),
      } }))
      void prompt.then(result => {
        if (stopped || signal.aborted) return
        try { queue.push({ result: requireData(result) }) }
        catch { queue.fail(new Error('OpenCode prompt failed')) }
      }, () => queue.fail(new Error('OpenCode prompt failed')))
      yield { ...base(), type: 'adapter:started', sessionId: sessionID, workingDirectory: cfg.cwd, isResume: !!input.resumeSessionId }
      const seenPermissions = new Set<string>()
      while (true) {
        const item = await queue.next(signal)
        if (!item) throw new Error('OpenCode event queue closed')
        if ('result' in item) {
          const completed = events.complete(item.result)
          for (const event of completed.events) { if (signal.aborted) throw new Error('OpenCode operation cancelled'); yield event }
          if (completed.text) yield { ...base(), type: 'adapter:stream_delta', content: completed.text }
          if (signal.aborted) throw new Error('OpenCode operation cancelled')
          succeeded = true
          terminal = { ...base(), type: 'adapter:completed', sessionId: sessionID, result: completed.text, usage: completed.usage, durationMs: Date.now() - startedAt }
          break
        }
        const event = item.event
        if (!record(event) || !record(event.properties)) continue
        const properties = event.properties
        if (event.type === 'message.updated' && record(properties['info'])) events.acceptMessage(properties['info'] as unknown as OpenCodeMessage)
        if (event.type === 'message.part.updated' && record(properties['part'])) {
          for (const mapped of events.tool(properties['part'] as unknown as OpenCodePart)) yield mapped
        }
        if (event.type !== 'permission.updated' || properties['sessionID'] !== sessionID ||
            typeof properties['messageID'] !== 'string' || !events.messages.has(properties['messageID']) ||
            !record(properties['time']) || typeof properties['time']['created'] !== 'number' || properties['time']['created'] < startedAt ||
            typeof properties['id'] !== 'string' || !properties['id'] || seenPermissions.has(properties['id'])) continue
        const permissionID = properties['id']
        events.bound(permissionID)
        seenPermissions.add(permissionID); permissions.add(permissionID)
        const interactionId = randomUUID()
        const question = typeof properties['title'] === 'string' ? properties['title'] : 'OpenCode tool permission'
        events.bound(question)
        let approved = false
        let resolvedBy: 'auto-approve' | 'auto-deny' | 'caller' | 'timeout-fallback' = 'auto-deny'
        if (typeof properties['type'] === 'string' && cfg.allowed.includes(properties['type'])) {
          if (cfg.interaction.mode === 'auto-approve') { approved = true; resolvedBy = 'auto-approve' }
          if (cfg.interaction.mode === 'ask-caller') {
            let timedOut = false
            let answer!: (value: boolean) => void
            const waiting = new Promise<boolean>(resolve => { answer = resolve })
            this.interactions.set(interactionId, { controller, answer })
            const timer = setTimeout(() => { timedOut = true; answer(false) }, cfg.interactionMs)
            try {
              yield { ...base(), type: 'adapter:interaction_required', interactionId, question, kind: 'permission', expiresAt: Date.now() + cfg.interactionMs }
              approved = await abortable(waiting, signal)
              resolvedBy = timedOut ? 'timeout-fallback' : 'caller'
            } finally { clearTimeout(timer); this.interactions.delete(interactionId) }
          }
        }
        if (signal.aborted) throw new Error('OpenCode operation cancelled')
        await this.request(() => client!.postSessionIdPermissionsPermissionId({ ...request, path: { id: sessionID!, permissionID }, body: { response: approved ? 'once' : 'reject' } }), signal)
        permissions.delete(permissionID)
        yield { ...base(), type: 'adapter:interaction_resolved', interactionId, question, answer: approved ? 'once' : 'reject', resolvedBy }
      }
    } catch (error) {
      terminal = { ...base(), type: 'adapter:failed', sessionId: sessionID,
        code: transportFailure ? 'ADAPTER_EXECUTION_FAILED' : signal.aborted ? 'ADAPTER_CANCELLED' : error instanceof Error && error.message.startsWith('ADAPTER_SDK_NOT_INSTALLED') ? 'ADAPTER_SDK_NOT_INSTALLED' : 'ADAPTER_EXECUTION_FAILED',
        error: transportFailure?.message ?? (signal.aborted ? 'OpenCode operation cancelled or timed out' : error instanceof Error ? error.message : 'OpenCode execution failed') }
    } finally {
      stopped = true
      if (timeout) clearTimeout(timeout)
      controller.abort()
      input.signal?.removeEventListener('abort', abort)
      for (const [id, pending] of this.interactions) if (pending.controller === controller) { pending.answer(false); this.interactions.delete(id) }
      if (settings) {
        const cleanup = new AbortController()
        const timer = setTimeout(() => cleanup.abort(), settings.cleanupTimeout)
        const tasks: Promise<unknown>[] = []
        if (stream?.return) tasks.push(abortable(Promise.resolve().then(() => stream!.return!()), cleanup.signal))
        if (client && sessionID && !succeeded && (release || createdHere)) tasks.push(this.cleanupSession(client, sessionID, settings.cwd, settings.cleanupTimeout, [...permissions]))
        await Promise.allSettled(tasks)
        clearTimeout(timer)
      }
      // A bounded abort attempt does not prove a remote prompt stopped. Never
      // resume an uncertain session (including queued continuations of it).
      if (sessionID && !succeeded && (release || createdHere)) this.sessions.retire(sessionID)
      release?.()
      this.active.delete(controller)
    }
    if (terminal) {
      if (input.signal?.aborted) terminal = { ...base(), type: 'adapter:failed', sessionId: sessionID, code: 'ADAPTER_CANCELLED', error: 'OpenCode operation cancelled or timed out' }
      yield terminal
    }
  }

  private async request<T>(send: () => Promise<OpenCodeResult<T>>, signal: AbortSignal): Promise<T> {
    try { return requireData(await abortable(Promise.resolve().then(send), signal)) }
    catch { throw new Error('OpenCode request failed') }
  }

  private async cleanupSession(client: OpenCodeClient, id: string, cwd: string, timeoutMs: number, permissions: string[] = []): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const request = { query: { directory: cwd }, signal: controller.signal, throwOnError: true as const }
    try {
      await Promise.allSettled([
        ...permissions.map(permissionID => abortable(Promise.resolve().then(() => client.postSessionIdPermissionsPermissionId({ ...request, path: { id, permissionID }, body: { response: 'reject' } })), controller.signal)),
        abortable(Promise.resolve().then(() => client.session.abort({ ...request, path: { id } })), controller.signal),
      ])
    } finally { clearTimeout(timer) }
  }

  private boundedFetch(endpoint: string, timeoutMs: number, maxBytes: number, turnSignal: AbortSignal): typeof globalThis.fetch {
    const nativeFetch = this.dependencies.fetch ?? globalThis.fetch
    return async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).origin !== endpoint) throw new Error('OpenCode request escaped attached endpoint')
      const controller = new AbortController()
      // Cleanup requests carry their own signal and must survive turn cancellation.
      const parent = init?.signal ?? request.signal ?? turnSignal
      const abort = () => controller.abort()
      parent.addEventListener('abort', abort, { once: true })
      if (parent.aborted) controller.abort()
      const timer = setTimeout(abort, timeoutMs)
      const finish = () => { clearTimeout(timer); parent.removeEventListener('abort', abort) }
      try {
        const pending = nativeFetch(request, { signal: controller.signal, redirect: 'error', credentials: 'omit' })
        void pending.then(response => {
          if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined)
        }, () => undefined)
        const response = await abortable(pending, controller.signal)
        if (!response.body) { finish(); return response }
        const reader = response.body.getReader()
        let bytes = 0
        const body = new ReadableStream<Uint8Array>({
          async pull(target) {
            try {
              const next = await abortable(reader.read(), controller.signal)
              if (next.done) { finish(); target.close(); return }
              bytes += next.value.byteLength
              if (bytes > maxBytes) throw new Error('OpenCode response byte limit exceeded')
              target.enqueue(next.value)
            } catch (error) { finish(); controller.abort(); void reader.cancel().catch(() => undefined); target.error(error) }
          },
          cancel() { finish(); controller.abort(); void reader.cancel().catch(() => undefined) },
        })
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      } catch (error) { finish(); throw error }
    }
  }
}
