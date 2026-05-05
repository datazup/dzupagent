import { randomUUID } from 'node:crypto'

import type {
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AdapterCapabilityProfile,
  AgentEvent,
  AgentInput,
  GovernanceEvent,
  HealthStatus,
  AdapterMonitorStatus,
  InteractionPolicy,
} from '../types.js'
import { withCorrelationId } from '../types.js'
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

  constructor(providerId: AdapterProviderId, config: AdapterConfig = {}) {
    this.providerId = providerId
    this.config = { ...config }
    this.governance = new GovernanceEmitter(providerId)
    this.artifactWatcherHost = new ArtifactWatcherHost(providerId)
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
    const sessionId = randomUUID()
    const startTime = Date.now()
    const runIdForContext = input.correlationId ?? sessionId
    this.governance.setRunContext({ runId: runIdForContext, sessionId })

    await this.assertReady()

    yield withCorrelationId({
      type: 'adapter:started',
      providerId: this.providerId,
      sessionId,
      timestamp: startTime,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      model: this.config.model,
      workingDirectory: input.workingDirectory ?? this.config.workingDirectory,
      isResume: !!input.resumeSessionId,
    }, input.correlationId)

    // Start artifact watcher (no-op when no factory wired).
    const workingDirectory =
      input.workingDirectory ?? this.config.workingDirectory ?? process.cwd()
    this.startArtifactWatcher(
      resolveWatcherPaths(this.providerId, input, workingDirectory),
    )

    this.currentAbortController = new AbortController()
    const combinedSignal = input.signal
      ? AbortSignal.any([this.currentAbortController.signal, input.signal])
      : this.currentAbortController.signal

    const policy = this.resolveInteractionPolicy(input)
    const resolver = policy.mode !== 'auto-approve' ? new InteractionResolver(policy) : null
    const pendingEvents: AgentEvent[] = []

    const spawnOpts: SpawnJsonlOptions = {
      cwd: input.workingDirectory ?? this.config.workingDirectory,
      env: this.buildSpawnEnv(input),
      signal: combinedSignal,
      timeoutMs: this.config.timeoutMs,
    }
    if (resolver) {
      spawnOpts.stdinResponder = createStdinResponder({
        providerId: this.providerId,
        resolver,
        policy,
        input,
        sessionId,
        pendingEvents,
        governance: this.governance,
      })
    }

    try {
      let hasCompleted = false
      let hasFailed = false
      const args = this.buildArgs(input)
      for await (const record of spawnAndStreamJsonl(this.getBinaryName(), args, spawnOpts)) {
        for (const evt of pendingEvents.splice(0)) yield evt

        // Emit governance:hook_executed for recognized hook records.
        this.governance.emitHookExecutedIfRecognized(record, {
          runId: input.correlationId ?? sessionId,
          sessionId,
        })

        const mapped = this.mapProviderEvent(record, sessionId)
        if (!mapped) continue

        const event = withCorrelationId(mapped, input.correlationId)
        if (event.type === 'adapter:completed') hasCompleted = true
        if (event.type === 'adapter:failed') hasFailed = true
        yield event
      }

      for (const evt of pendingEvents.splice(0)) yield evt

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
    } catch (err: unknown) {
      const normalized = this.normalizeError(err)
      yield withCorrelationId({
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: normalized.message,
        code: normalized.code,
        timestamp: Date.now(),
      }, input.correlationId)

      if (this.shouldRethrow(normalized.original)) throw normalized.original
    } finally {
      resolver?.dispose()
      this.currentAbortController = null
      this.stopArtifactWatcher()
      this.governance.setRunContext(null)
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
