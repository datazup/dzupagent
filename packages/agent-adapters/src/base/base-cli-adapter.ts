import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import { ForgeError } from '@dzupagent/core'

import type {
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AdapterCapabilityProfile,
  AgentEvent,
  AgentInput,
  GovernanceEvent,
  HealthStatus,
  EnvFilterConfig,
  InteractionPolicy,
} from '../types.js'
import { isBinaryAvailable, spawnAndStreamJsonl } from '../utils/process-helpers.js'
import type { SpawnJsonlOptions } from '../utils/process-helpers.js'
import { InteractionResolver } from '../interaction/interaction-resolver.js'
import type { InteractionKind } from '../interaction/interaction-detector.js'

/** Default patterns for sensitive env vars that should not leak to child processes */
const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  /SECRET/i,
  /PASSWORD/i,
  /PRIVATE_KEY/i,
  /^DATABASE_URL$/i,
  /^JWT_SECRET$/i,
  /^COOKIE_SECRET$/i,
  /TOKEN(?!_LIMIT|_COUNT|S_PER)/i,
]

/**
 * Filter sensitive environment variables based on the provided config.
 *
 * Removes entries whose keys match any blocked pattern, unless the key
 * is explicitly listed in `allowedVars`. Returns a new object; does not
 * mutate the input.
 */
export function filterSensitiveEnvVars(
  env: Record<string, string>,
  config?: EnvFilterConfig,
): Record<string, string> {
  if (config?.disableFilter) {
    return { ...env }
  }
  const patterns = [
    ...DEFAULT_SENSITIVE_PATTERNS,
    ...(config?.blockedPatterns ?? []),
  ]
  const allowed = new Set(config?.allowedVars ?? [])
  const result: Record<string, string> = {}
  for (const key of Object.keys(env)) {
    if (!allowed.has(key) && patterns.some((p) => p.test(key))) {
      continue
    }
    const val = env[key]
    if (val !== undefined) result[key] = val
  }
  return result
}

interface NormalizedAdapterError {
  message: string
  code?: string | undefined
  original: unknown
}

/**
 * Per-provider relative/home paths that DzupAgent knows may contain run
 * artifacts (sessions, memory snapshots, skill bundles). These are used to
 * seed the {@link ArtifactWatcher} on run start. Entries beginning with `~`
 * are resolved against {@link os.homedir}; other entries are treated as
 * relative to the run's working directory by the watcher integration.
 */
const PROVIDER_WATCH_SPECS: Partial<Record<string, string[]>> = {
  claude: ['.claude', '~/.claude'],
  codex: ['.codex', '~/.codex'],
  gemini: ['.gemini', '~/.gemini'],
  qwen: ['.qwen', '~/.qwen'],
  goose: ['.goosehints', '~/.config/goose', '~/.local/share/goose'],
  crush: ['.crush', '~/.config/crush', '~/.local/share/crush'],
}

/**
 * Resolve a provider watch-spec entry to an absolute path. `~` and `~/...`
 * are expanded against the current user's home directory; anything else is
 * resolved against the supplied working directory.
 */
function resolveWatchPath(entry: string, workingDirectory: string): string {
  if (entry === '~') return os.homedir()
  if (entry.startsWith('~/')) return `${os.homedir()}/${entry.slice(2)}`
  if (entry.startsWith('/')) return entry
  return `${workingDirectory.replace(/\/$/, '')}/${entry}`
}

/**
 * Opaque handle returned by an artifact-watcher implementation. The base
 * adapter only needs a way to stop a running watcher; the concrete type is
 * intentionally minimal so the adapter-monitor dependency stays optional.
 */
interface ArtifactWatcherHandle {
  stop: () => void
}

/**
 * Shared base class for CLI-backed adapters (Gemini/Qwen/Crush).
 *
 * Centralizes:
 * - process spawn + JSONL stream loop
 * - started/completed/failed lifecycle events
 * - abort composition and interrupt behavior
 * - common health-check + configuration updates
 */
export abstract class BaseCliAdapter implements AgentCLIAdapter {
  readonly providerId: AdapterProviderId

  protected config: AdapterConfig
  private currentAbortController: AbortController | null = null

  /**
   * Active artifact-watcher handle for the current run, if any. Populated by
   * {@link startArtifactWatcher} on run start and cleared by
   * {@link stopArtifactWatcher} when the run ends (success, failure, or
   * cancellation). Remains `null` unless a concrete watcher is wired in via
   * {@link setArtifactWatcherFactory}.
   */
  private artifactWatcher: ArtifactWatcherHandle | null = null

  /**
   * Optional factory that creates an {@link ArtifactWatcherHandle} given a
   * list of absolute paths to watch. This indirection keeps the
   * `@datazup/dzupagent-adapter-monitor` package an *optional* peer: when the
   * dependency is not installed, the factory stays `null` and
   * {@link startArtifactWatcher} becomes a no-op.
   */
  private artifactWatcherFactory:
    | ((paths: string[], providerId: AdapterProviderId) => ArtifactWatcherHandle)
    | null = null

  /**
   * Listeners registered via {@link onGovernanceEvent}.  The governance
   * plane is a side-channel parallel to the primary AgentEvent stream — it
   * surfaces approval/authorization decisions, hook executions, rule
   * violations, and dangerous-command detections for auditing purposes.
   */
  private governanceListeners = new Set<(event: GovernanceEvent) => void>()

  constructor(providerId: AdapterProviderId, config: AdapterConfig = {}) {
    this.providerId = providerId
    this.config = { ...config }
  }

  /**
   * Subscribe to governance events emitted by this adapter.
   * Returns an unsubscribe function — call it when the consumer detaches
   * to prevent leaks.  Errors thrown inside listeners are swallowed so they
   * cannot break the adapter event loop.
   */
  onGovernanceEvent(listener: (event: GovernanceEvent) => void): () => void {
    this.governanceListeners.add(listener)
    return () => {
      this.governanceListeners.delete(listener)
    }
  }

  /**
   * Emit a governance event to all registered listeners.
   *
   * Subclasses and internal helpers call this to publish approval requests,
   * hook executions, rule violations, or dangerous-command alerts.  Listener
   * errors are intentionally swallowed to protect the event loop.
   */
  protected emitGovernanceEvent(event: GovernanceEvent): void {
    for (const listener of this.governanceListeners) {
      try {
        listener(event)
      } catch {
        /* listener errors must not break the adapter event loop */
      }
    }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const sessionId = randomUUID()
    const startTime = Date.now()

    await this.assertReady()

    yield {
      type: 'adapter:started',
      providerId: this.providerId,
      sessionId,
      timestamp: startTime,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      model: this.config.model,
      workingDirectory: input.workingDirectory ?? this.config.workingDirectory,
      isResume: !!input.resumeSessionId,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    }

    // ArtifactWatcher integration: start watcher on run begin, stop on end
    // (requires @datazup/dzupagent-adapter-monitor peer). When the peer is
    // not wired via setArtifactWatcherFactory this call is a no-op.
    const watchSpec = PROVIDER_WATCH_SPECS[this.providerId] ?? []
    const workingDirectory =
      input.workingDirectory ?? this.config.workingDirectory ?? process.cwd()
    const resolvedPaths = watchSpec.map((p) => resolveWatchPath(p, workingDirectory))
    this.startArtifactWatcher(resolvedPaths)

    this.currentAbortController = new AbortController()
    const combinedSignal = input.signal
      ? AbortSignal.any([this.currentAbortController.signal, input.signal])
      : this.currentAbortController.signal

    const args = this.buildArgs(input)
    const env = this.buildEnv()

    // Set up interaction handling
    const policy = this.resolveInteractionPolicy(input)
    const resolver = policy.mode !== 'auto-approve' ? new InteractionResolver(policy) : null
    // Events generated by the stdinResponder closure are drained before each record
    const pendingEvents: AgentEvent[] = []

    const spawnOpts: SpawnJsonlOptions = {
      cwd: input.workingDirectory ?? this.config.workingDirectory,
      env,
      signal: combinedSignal,
      timeoutMs: this.config.timeoutMs,
    }

    if (resolver) {
      spawnOpts.stdinResponder = async (
        _record: Record<string, unknown>,
        question: string,
        kind: InteractionKind,
      ): Promise<string | null> => {
        const interactionId = randomUUID()
        const timeoutMs = policy.askCaller?.timeoutMs ?? 60_000
        const now = Date.now()
        // runId defaults to correlationId when present, else the sessionId.
        const runId = input.correlationId ?? sessionId

        if (policy.mode === 'ask-caller') {
          pendingEvents.push({
            type: 'adapter:interaction_required',
            providerId: this.providerId,
            interactionId,
            question,
            kind,
            timestamp: now,
            expiresAt: now + timeoutMs,
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          })
        }

        // Governance side-channel: mirror every interaction request as an
        // approval_requested event regardless of policy mode so the audit
        // trail captures auto-approved prompts too.
        this.emitGovernanceEvent({
          type: 'governance:approval_requested',
          runId,
          sessionId,
          interactionId,
          providerId: this.providerId,
          timestamp: now,
          prompt: question,
        })

        const result = await resolver.resolve({ interactionId, question, kind })

        pendingEvents.push({
          type: 'adapter:interaction_resolved',
          providerId: this.providerId,
          interactionId,
          question,
          answer: result.answer,
          resolvedBy: result.resolvedBy,
          timestamp: Date.now(),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        })

        // Governance side-channel: mirror resolution with a normalized
        // resolution field distinct from the detailed resolvedBy.
        this.emitGovernanceEvent({
          type: 'governance:approval_resolved',
          runId,
          sessionId,
          interactionId,
          providerId: this.providerId,
          timestamp: Date.now(),
          resolution: mapResolvedByToResolution(result.resolvedBy),
        })

        return result.answer
      }
    }

    try {
      let hasCompleted = false
      let hasFailed = false

      for await (const record of spawnAndStreamJsonl(this.getBinaryName(), args, spawnOpts)) {
        // Drain any interaction events accumulated during stdinResponder
        for (const evt of pendingEvents.splice(0)) {
          yield evt
        }

        // Detect hook execution records from the provider JSONL stream and
        // emit governance:hook_executed so the audit plane captures them.
        // Providers signal hook runs via type: 'hook_execution' or a hookName
        // field at the top level of the JSONL record.
        const recordType = typeof record.type === 'string' ? record.type : ''
        if (
          recordType === 'hook_execution' ||
          (typeof record.hookName === 'string' && record.hookName.length > 0)
        ) {
          const hookName = (record.hookName as string | undefined) ?? recordType
          const exitCode =
            typeof record.exitCode === 'number' ? record.exitCode :
            typeof record.exit_code === 'number' ? record.exit_code :
            undefined
          const runId = input.correlationId ?? sessionId
          this.emitGovernanceEvent({
            type: 'governance:hook_executed',
            runId,
            sessionId,
            providerId: this.providerId,
            timestamp: Date.now(),
            hookName,
            ...(exitCode !== undefined ? { exitCode } : {}),
          })
        }

        const event = this.mapProviderEvent(record, sessionId)
        if (!event) continue

        if (input.correlationId) {
          ;(event as unknown as Record<string, unknown>).correlationId = input.correlationId
        }

        if (event.type === 'adapter:completed') {
          hasCompleted = true
        }
        if (event.type === 'adapter:failed') {
          hasFailed = true
        }
        yield event
      }

      // Drain any remaining interaction events
      for (const evt of pendingEvents.splice(0)) {
        yield evt
      }

      if (!hasCompleted && !hasFailed) {
        yield {
          type: 'adapter:completed',
          providerId: this.providerId,
          sessionId,
          result: '',
          durationMs: Date.now() - startTime,
          timestamp: Date.now(),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        }
      }
    } catch (err: unknown) {
      const normalized = this.normalizeError(err)
      yield {
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: normalized.message,
        code: normalized.code,
        timestamp: Date.now(),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }

      if (this.shouldRethrow(normalized.original)) {
        throw normalized.original
      }
    } finally {
      resolver?.dispose()
      this.currentAbortController = null
      this.stopArtifactWatcher()
    }
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const modifiedInput: AgentInput = {
      ...input,
      resumeSessionId: sessionId,
    }
    yield* this.execute(modifiedInput)
  }

  interrupt(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
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
    }
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  /**
   * Wire an artifact-watcher implementation. Intended for hosts that depend
   * on `@datazup/dzupagent-adapter-monitor` to pass a factory that returns a
   * concrete {@link ArtifactWatcher} handle.  When no factory is set, the
   * watcher integration becomes a no-op — the base package stays free of
   * the optional peer dependency while still supporting the run lifecycle
   * hook points.
   */
  setArtifactWatcherFactory(
    factory:
      | ((paths: string[], providerId: AdapterProviderId) => ArtifactWatcherHandle)
      | null,
  ): void {
    this.artifactWatcherFactory = factory
  }

  /**
   * Begin watching the supplied paths for the duration of the current run.
   * Called automatically by {@link execute} right after the
   * `adapter:started` event has been yielded. No-op when no factory has
   * been wired or when the provider has no registered watch-spec.
   */
  protected startArtifactWatcher(paths: string[]): void {
    if (this.artifactWatcher) return
    if (!this.artifactWatcherFactory) return
    if (paths.length === 0) return
    try {
      this.artifactWatcher = this.artifactWatcherFactory(paths, this.providerId)
    } catch {
      // Watcher start failures must not break the run — best-effort only.
      this.artifactWatcher = null
    }
  }

  /**
   * Stop the active artifact watcher, if any. Invoked in the `finally`
   * block of {@link execute} so it runs on success, failure, and
   * cancellation paths.
   */
  protected stopArtifactWatcher(): void {
    if (!this.artifactWatcher) return
    try {
      this.artifactWatcher.stop()
    } catch {
      // swallow — stopping is best-effort
    }
    this.artifactWatcher = null
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

  protected getUnavailableBinaryMessage(binary: string): string {
    return `'${binary}' binary not found in PATH`
  }

  protected buildEnv(): Record<string, string> {
    const raw = filterSensitiveEnvVars(
      { ...process.env } as Record<string, string>,
      this.config.envFilter,
    )
    if (this.config.env) {
      Object.assign(raw, this.config.env)
    }
    return raw
  }

  protected normalizeError(err: unknown): NormalizedAdapterError {
    if (err instanceof Error) {
      return {
        message: err.message,
        code: ForgeError.is(err) ? err.code : undefined,
        original: err,
      }
    }
    return {
      message: String(err),
      code: undefined,
      original: err,
    }
  }

  protected shouldRethrow(err: unknown): boolean {
    return ForgeError.is(err)
  }

  protected async assertReady(): Promise<void> {
    // default: no preflight checks
  }

  /**
   * Resolve the effective interaction policy for a given input.
   * Per-call options override the adapter-level config; config overrides the default.
   */
  protected resolveInteractionPolicy(input: AgentInput): InteractionPolicy {
    const perCall = input.options?.['interactionPolicy']
    if (
      perCall !== null &&
      typeof perCall === 'object' &&
      'mode' in (perCall as object)
    ) {
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

/**
 * Map an interaction-resolver `resolvedBy` value to the normalized
 * governance `resolution` field.  Everything that is not an explicit
 * caller-provided allow/deny is classified as `auto`.
 */
function mapResolvedByToResolution(
  resolvedBy: 'auto-approve' | 'auto-deny' | 'default-answers' | 'ai-autonomous' | 'caller' | 'timeout-fallback',
): 'approved' | 'denied' | 'auto' {
  if (resolvedBy === 'auto-approve') return 'approved'
  if (resolvedBy === 'auto-deny') return 'denied'
  return 'auto'
}
