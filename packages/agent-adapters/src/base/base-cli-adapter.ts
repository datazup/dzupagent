import { randomUUID } from 'node:crypto'

import type {
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AdapterCapabilityProfile,
  AgentEvent,
  AgentStreamEvent,
  AgentInput,
  GovernanceEvent,
  HealthStatus,
  AdapterMonitorStatus,
  InteractionPolicy,
  ProviderRawStreamEvent,
  RawAgentEvent,
} from '../types.js'
import { withCorrelationId } from '../types.js'
import type { RunEventStore } from '../runs/run-event-store.js'
import { isBinaryAvailable, spawnAndStreamJsonl } from '../utils/process-helpers.js'
import type { SpawnJsonlOptions } from '../utils/process-helpers.js'
import { InteractionResolver } from '../interaction/interaction-resolver.js'
import {
  GovernanceEmitter,
  type EmitRuleViolationOpts,
  type GuardrailsLike,
  type RuleViolation,
} from './governance-emitter.js'
import {
  ArtifactWatcherHost,
  resolveWatcherPaths,
  type ArtifactWatcherHandle,
} from './artifact-watcher-host.js'
import {
  buildEnv as buildEnvHelper,
  applyTraceEnv,
  filterSensitiveEnvVars,
} from './env-builder.js'
import {
  normalizeAdapterError,
  shouldRethrowAdapterError,
  type NormalizedAdapterError,
} from './adapter-error-normalizer.js'
import { createStdinResponder } from './stdin-responder.js'
import { AdapterStreamRunner } from './stream-runner.js'
import type { AdapterStreamSource } from './stream-runner.js'

// Backward-compat re-exports
export { filterSensitiveEnvVars }
export type { ArtifactWatcherHandle }

/**
 * Shared base class for CLI-backed adapters (Gemini/Qwen/Crush). Centralizes
 * spawn + JSONL stream, lifecycle events, abort/interrupt, healthcheck, and
 * configuration. Cross-cutting concerns delegate to {@link GovernanceEmitter},
 * {@link ArtifactWatcherHost}, env-builder, and adapter-error-normalizer.
 */
export abstract class BaseCliAdapter implements AgentCLIAdapter {
  readonly providerId: AdapterProviderId

  protected config: AdapterConfig
  private currentAbortController: AbortController | null = null

  private readonly governance: GovernanceEmitter
  private readonly artifactWatcherHost: ArtifactWatcherHost

  /**
   * Optional per-run event store. When attached, every raw provider event
   * processed by the CLI stream is persisted to `raw-events.jsonl` (alongside
   * the live `adapter:provider_raw` emission). Wire via {@link setRunStore}.
   */
  private runStore: RunEventStore | null = null

  constructor(providerId: AdapterProviderId, config: AdapterConfig = {}) {
    this.providerId = providerId
    this.config = { ...config }
    this.governance = new GovernanceEmitter(providerId)
    this.artifactWatcherHost = new ArtifactWatcherHost(providerId)
  }

  /**
   * Attach (or clear) the {@link RunEventStore} used to persist raw provider
   * events for the current run. Pass `null` to detach. Persistence is
   * best-effort — store-side errors never break the adapter stream.
   *
   * Codex maintains its own raw channel via the SDK loop, so this CLI-level
   * persistence path is intentionally inert for the `codex` provider.
   */
  setRunStore(store: RunEventStore | null): void {
    this.runStore = store
  }

  onGovernanceEvent(listener: (event: GovernanceEvent) => void): () => void {
    return this.governance.onGovernanceEvent(listener)
  }

  protected emitGovernanceEvent(event: GovernanceEvent): void {
    this.governance.emit(event)
  }

  emitRuleViolation(opts: EmitRuleViolationOpts): void {
    this.governance.emitRuleViolation(opts)
  }

  attachGuardrailsGovernance(guardrails: GuardrailsLike): void {
    this.governance.attachGuardrails(guardrails)
  }

  validateAndEmitRules<TRule, TContext>(
    rules: TRule[],
    context: TContext,
    validator: (rules: TRule[], context: TContext) => ReadonlyArray<RuleViolation>,
    opts?: { runId?: string; sessionId?: string },
  ): ReadonlyArray<RuleViolation> {
    return this.governance.validateAndEmitRules(rules, context, validator, opts)
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    // Drop the side-channel raw events; execute() yields only normalized events.
    for await (const event of this.executeWithRaw(input)) {
      if (event.type !== 'adapter:provider_raw') {
        yield event
      }
    }
  }

  async *executeWithRaw(
    input: AgentInput,
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const sessionId = randomUUID()
    const startTime = Date.now()
    const runIdForContext = input.correlationId ?? sessionId
    this.governance.setRunContext({ runId: runIdForContext, sessionId })

    await this.assertReady()

    // Start artifact watcher (no-op when no factory wired).
    const workingDirectory =
      input.workingDirectory ?? this.config.workingDirectory ?? process.cwd()
    this.startArtifactWatcher(
      resolveWatcherPaths(this.providerId, input, workingDirectory),
    )

    const policy = this.resolveInteractionPolicy(input)
    const resolver = policy.mode !== 'auto-approve' ? new InteractionResolver(policy) : null
    const pendingEvents: AgentEvent[] = []

    // Raw provider events captured per record by mapRawEvent and drained into
    // the outer stream immediately before the normalized events of the same
    // record. Codex maintains its own raw channel, so we skip CLI-level raw
    // emission for that provider to avoid double-emitting.
    const emitsRaw = this.providerId !== 'codex'
    const pendingRawEvents: ProviderRawStreamEvent[] = []
    let rawOrdinal = 0

    // Per-run mutable state consumed by the AdapterStreamSource methods.
    let hasCompleted = false
    let hasFailed = false
    const captured: { error: NormalizedAdapterError | null } = { error: null }

    const adapter = this
    const source: AdapterStreamSource<Record<string, unknown>> = {
      providerId: this.providerId,
      async *open(_input: AgentInput, signal: AbortSignal) {
        const spawnOpts: SpawnJsonlOptions = {
          cwd: _input.workingDirectory ?? adapter.config.workingDirectory,
          env: adapter.buildSpawnEnv(_input),
          signal,
          timeoutMs: adapter.config.timeoutMs,
        }
        if (resolver) {
          spawnOpts.stdinResponder = createStdinResponder({
            providerId: adapter.providerId,
            resolver,
            policy,
            input: _input,
            sessionId,
            pendingEvents,
            governance: adapter.governance,
          })
        }
        const args = adapter.buildArgs(_input)
        try {
          yield* spawnAndStreamJsonl(adapter.getBinaryName(), args, spawnOpts)
        } catch (err: unknown) {
          // Capture for ForgeError rethrow + custom adapter:failed emission;
          // also rethrow so the runner's catch path triggers its lifecycle
          // bookkeeping (abort handling, finally cleanup).
          captured.error = adapter.normalizeError(err)
          throw err
        }
      },
      mapRawEvent(record: Record<string, unknown>): AgentEvent | AgentEvent[] | null {
        const events: AgentEvent[] = []
        for (const evt of pendingEvents.splice(0)) events.push(evt)

        // Capture + persist the raw provider event (non-Codex providers only).
        // The runner only yields AgentEvents, so we buffer the side-channel
        // ProviderRawStreamEvent here and drain it in the outer loop right
        // before this record's normalized events.
        if (emitsRaw) {
          const rawEvent: RawAgentEvent = {
            providerId: adapter.providerId,
            runId: runIdForContext,
            sessionId,
            providerEventId: `${adapter.providerId}:${sessionId}:${rawOrdinal}`,
            timestamp: Date.now(),
            source: 'stdout',
            payload: record,
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          }
          rawOrdinal += 1
          pendingRawEvents.push({ type: 'adapter:provider_raw', rawEvent })
          // Best-effort persistence — store-side errors never break the stream.
          void adapter.runStore?.appendRaw(rawEvent)
        }

        // Emit governance:hook_executed for recognized hook records.
        adapter.governance.emitHookExecutedIfRecognized(record, {
          runId: input.correlationId ?? sessionId,
          sessionId,
        })

        const mapped = adapter.mapProviderEvent(record, sessionId)
        if (mapped) {
          const event = withCorrelationId(mapped, input.correlationId)
          if (event.type === 'adapter:completed') hasCompleted = true
          if (event.type === 'adapter:failed') hasFailed = true
          events.push(event)
        }
        return events.length === 0 ? null : events
      },
    }

    const runner = new AdapterStreamRunner<Record<string, unknown>>({
      emitStartedImmediately: true,
      emitFailedOnAbort: true,
      initialSessionId: sessionId,
      startedExtra: {
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
        ...(this.config.model !== undefined ? { model: this.config.model } : {}),
      },
      onAbortController: (ctrl) => {
        this.currentAbortController = ctrl
      },
    })

    try {
      // Track whether the runner emitted its own adapter:failed (from its
      // catch path) so we can suppress the synthetic adapter:completed.
      for await (const event of runner.run(source, input, input.signal)) {
        // Drain raw events captured for the just-processed record so each
        // adapter:provider_raw is emitted immediately before that record's
        // normalized event(s).
        for (const raw of pendingRawEvents.splice(0)) yield raw

        if (event.type === 'adapter:failed') {
          hasFailed = true
          // Re-emit the runner's adapter:failed but normalize the error code
          // back to the captured original (legacy preserves spawn error code).
          if (captured.error) {
            yield withCorrelationId({
              type: 'adapter:failed',
              providerId: adapter.providerId,
              sessionId,
              error: captured.error.message,
              code: captured.error.code,
              timestamp: Date.now(),
            }, input.correlationId)
            continue
          }
        }
        yield event
      }

      // Flush raw events captured for records that produced no normalized
      // events (e.g. governance-only records or records mapProviderEvent
      // skipped), then any resolver events emitted after the stream ended.
      for (const raw of pendingRawEvents.splice(0)) yield raw
      for (const evt of pendingEvents.splice(0)) yield evt

      // Synthesise adapter:completed when the stream ended without a terminal.
      if (!hasCompleted && !hasFailed) {
        yield withCorrelationId({
          type: 'adapter:completed',
          providerId: this.providerId,
          sessionId,
          result: '',
          durationMs: Date.now() - startTime,
          timestamp: Date.now(),
        }, input.correlationId)
      }
    } finally {
      resolver?.dispose()
      this.currentAbortController = null
      this.stopArtifactWatcher()
      this.governance.setRunContext(null)
    }

    // Preserve legacy semantics: rethrow ForgeError originals after the
    // adapter:failed event has been yielded so the host can observe them.
    if (captured.error && this.shouldRethrow(captured.error.original)) {
      throw captured.error.original
    }
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    yield* this.execute({ ...input, resumeSessionId: sessionId })
  }

  interrupt(): void {
    if (!this.currentAbortController) return
    this.currentAbortController.abort()
    this.currentAbortController = null
  }

  async healthCheck(): Promise<HealthStatus> {
    const binary = this.getBinaryName()
    const cliAvailable = await isBinaryAvailable(binary)
    return {
      healthy: cliAvailable,
      providerId: this.providerId,
      sdkInstalled: cliAvailable,
      cliAvailable,
      lastError: cliAvailable ? undefined : this.getUnavailableBinaryMessage(binary),
      monitorStatus: this.getMonitorStatus(),
    }
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  /** Wire an artifact-watcher factory. See {@link ArtifactWatcherHost}. */
  setArtifactWatcherFactory(
    factory:
      | ((paths: string[], providerId: AdapterProviderId) => ArtifactWatcherHandle)
      | null,
  ): void {
    this.artifactWatcherHost.setFactory(factory)
  }

  getMonitorStatus(): AdapterMonitorStatus {
    return this.artifactWatcherHost.getStatus()
  }

  protected startArtifactWatcher(paths: string[]): void {
    this.artifactWatcherHost.start(paths)
  }

  protected stopArtifactWatcher(): void {
    this.artifactWatcherHost.stop()
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    }
  }

  protected getUnavailableBinaryMessage(b: string): string { return `'${b}' binary not found in PATH` }

  protected buildEnv(): Record<string, string> {
    return buildEnvHelper(this.config)
  }

  protected buildSpawnEnv(input: AgentInput): Record<string, string> {
    // Honors subclass overrides of buildEnv (e.g. Qwen sets DASHSCOPE_API_KEY).
    return applyTraceEnv(this.buildEnv(), input)
  }

  protected normalizeError(err: unknown): NormalizedAdapterError {
    return normalizeAdapterError(err)
  }

  protected shouldRethrow(err: unknown): boolean {
    return shouldRethrowAdapterError(err)
  }

  protected async assertReady(): Promise<void> {
    // default: no preflight checks
  }

  protected resolveInteractionPolicy(input: AgentInput): InteractionPolicy {
    const perCall = input.options?.['interactionPolicy']
    if (perCall !== null && typeof perCall === 'object' && 'mode' in (perCall as object)) {
      return perCall as InteractionPolicy
    }
    return this.config.interactionPolicy ?? { mode: 'auto-approve' }
  }

  protected abstract getBinaryName(): string
  protected abstract buildArgs(input: AgentInput): string[]
  protected abstract mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined
}
