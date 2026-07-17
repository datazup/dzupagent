import { randomUUID } from "node:crypto";

import type {
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AdapterCapabilityProfile,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
  GovernanceEvent,
  HealthStatus,
  AdapterMonitorStatus,
  InteractionPolicy,
  ControlledExecutionHandle,
} from "../types.js";
import { withCorrelationId } from "../types.js";
import type { RawAgentEvent } from "@dzupagent/adapter-types";
import {
  isBinaryAvailable,
  spawnAndStreamJsonl,
} from "../utils/process-helpers.js";
import type { SpawnJsonlOptions } from "../utils/process-helpers.js";
import { InteractionResolver } from "../interaction/interaction-resolver.js";
import {
  GovernanceEmitter,
  type EmitRuleViolationOpts,
  type GuardrailsLike,
  type RuleViolation,
} from "./governance-emitter.js";
import {
  ArtifactWatcherHost,
  resolveWatcherPaths,
  type ArtifactWatcherHandle,
} from "./artifact-watcher-host.js";
import {
  buildEnv as buildEnvHelper,
  applyTraceEnv,
  filterSensitiveEnvVars,
} from "./env-builder.js";
import {
  normalizeAdapterError,
  shouldRethrowAdapterError,
  type NormalizedAdapterError,
} from "./adapter-error-normalizer.js";
import { createStdinResponder } from "./stdin-responder.js";
import { AdapterStreamRunner } from "./stream-runner.js";
import type { AdapterStreamSource } from "./stream-runner.js";
import type { RunEventStore } from "../runs/run-event-store.js";
import { buildPreflightValidator } from "../guardrails/preflight-validator.js";
import { ForgeError } from "@dzupagent/core/events";
import { createControlledExecutionHandle } from "../controlled-execution/create-controlled-handle.js";

// Backward-compat re-exports
export { filterSensitiveEnvVars };
export type { ArtifactWatcherHandle };

export interface PreparedCliRun {
  readonly args: string[];
  readonly cwd?: string | undefined;
  readonly env: Record<string, string>;
  readonly cleanup?: (() => void | Promise<void>) | undefined;
  readonly malformedLinePolicy?: "skip" | "error" | undefined;
  readonly stdoutMode?: SpawnJsonlOptions["stdoutMode"];
  readonly limits?: SpawnJsonlOptions["limits"];
}

/**
 * Shared base class for CLI-backed adapters (Gemini/Qwen/Crush). Centralizes
 * spawn + JSONL stream, lifecycle events, abort/interrupt, healthcheck, and
 * configuration. Cross-cutting concerns delegate to {@link GovernanceEmitter},
 * {@link ArtifactWatcherHost}, env-builder, and adapter-error-normalizer.
 */
export abstract class BaseCliAdapter implements AgentCLIAdapter {
  readonly providerId: AdapterProviderId;

  protected config: AdapterConfig;
  private readonly activeAbortControllers = new Set<AbortController>();
  private readonly activeInteractionResolvers = new Set<InteractionResolver>();
  private runStore: RunEventStore | null = null;

  private readonly governance: GovernanceEmitter;
  private readonly artifactWatcherHost: ArtifactWatcherHost;

  constructor(providerId: AdapterProviderId, config: AdapterConfig = {}) {
    this.providerId = providerId;
    this.config = { ...config };
    this.governance = new GovernanceEmitter(providerId);
    this.artifactWatcherHost = new ArtifactWatcherHost(providerId);
  }

  /**
   * Wire a RunEventStore so that raw provider events are persisted to
   * `raw-events.jsonl` on each call to `executeWithRaw`.
   */
  setRunStore(store: RunEventStore): void {
    this.runStore = store;
  }

  onGovernanceEvent(listener: (event: GovernanceEvent) => void): () => void {
    return this.governance.onGovernanceEvent(listener);
  }

  protected emitGovernanceEvent(event: GovernanceEvent): void {
    this.governance.emit(event);
  }

  emitRuleViolation(opts: EmitRuleViolationOpts): void {
    this.governance.emitRuleViolation(opts);
  }

  attachGuardrailsGovernance(guardrails: GuardrailsLike): void {
    this.governance.attachGuardrails(guardrails);
  }

  validateAndEmitRules<TRule, TContext>(
    rules: TRule[],
    context: TContext,
    validator: (
      rules: TRule[],
      context: TContext
    ) => ReadonlyArray<RuleViolation>,
    opts?: { runId?: string; sessionId?: string }
  ): ReadonlyArray<RuleViolation> {
    return this.governance.validateAndEmitRules(
      rules,
      context,
      validator,
      opts
    );
  }

  async *execute(
    input: AgentInput
  ): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.executeWithRaw(input)) {
      if (event.type !== "adapter:provider_raw") {
        yield event;
      }
    }
  }

  /**
   * Like {@link execute} but also yields `adapter:provider_raw` events
   * immediately before each normalized event they correspond to. Raw events
   * are also persisted to the attached {@link RunEventStore} (if any), except
   * for the `codex` provider which has its own raw channel.
   */
  async *executeWithRaw(
    input: AgentInput
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const sessionId = randomUUID();
    const startTime = Date.now();
    const runIdForContext = input.correlationId ?? sessionId;
    this.governance.setRunContext({ runId: runIdForContext, sessionId });

    await this.assertReady(input);

    // Start artifact watcher (no-op when no factory wired).
    const workingDirectory =
      input.workingDirectory ?? this.config.workingDirectory ?? process.cwd();
    this.startArtifactWatcher(
      resolveWatcherPaths(this.providerId, input, workingDirectory)
    );

    const policy = this.resolveInteractionPolicy(input);
    const resolver =
      policy.mode !== "auto-approve" ? new InteractionResolver(policy) : null;
    if (resolver) this.activeInteractionResolvers.add(resolver);
    const pendingEvents: AgentEvent[] = [];

    // Per-run mutable state consumed by the AdapterStreamSource methods.
    let hasCompleted = false;
    let hasFailed = false;
    let rawOrdinal = 0;
    const captured: { error: NormalizedAdapterError | null } = { error: null };

    // Codex has its own raw channel — skip CLI raw emission for it.
    const emitRaw = this.providerId !== "codex";
    const store = this.runStore;

    const adapter = this;
    const source: AdapterStreamSource<Record<string, unknown>> = {
      providerId: this.providerId,
      async *open(_input: AgentInput, signal: AbortSignal) {
        const prepared = await adapter.prepareCliRun(_input);
        const spawnOpts: SpawnJsonlOptions = {
          cwd: prepared.cwd,
          env: prepared.env,
          signal,
          timeoutMs: adapter.config.timeoutMs,
          malformedLinePolicy: prepared.malformedLinePolicy,
          stdoutMode: prepared.stdoutMode,
          limits: prepared.limits,
        };
        if (resolver) {
          spawnOpts.stdinResponder = createStdinResponder({
            providerId: adapter.providerId,
            resolver,
            policy,
            input: _input,
            sessionId,
            pendingEvents,
            governance: adapter.governance,
          });
        }
        try {
          yield* spawnAndStreamJsonl(adapter.getBinaryName(), prepared.args, spawnOpts);
        } catch (err: unknown) {
          // Capture for ForgeError rethrow + custom adapter:failed emission;
          // also rethrow so the runner's catch path triggers its lifecycle
          // bookkeeping (abort handling, finally cleanup).
          captured.error = adapter.normalizeError(err);
          throw err;
        } finally {
          await prepared.cleanup?.();
        }
      },
      mapRawEvent(
        record: Record<string, unknown>,
        _context: import("./stream-runner.js").StreamContext
      ): AgentEvent | AgentEvent[] | null {
        const events: AgentEvent[] = [];
        for (const evt of pendingEvents.splice(0)) events.push(evt);

        // Emit governance:hook_executed for recognized hook records.
        adapter.governance.emitHookExecutedIfRecognized(record, {
          runId: input.correlationId ?? sessionId,
          sessionId,
        });

        const mapped = adapter.mapProviderEvent(record, sessionId);
        if (mapped) {
          const mappedEvents = Array.isArray(mapped) ? mapped : [mapped];
          for (const mappedEvent of mappedEvents) {
            const event = withCorrelationId(mappedEvent, input.correlationId);
            if (event.type === "adapter:completed") hasCompleted = true;
            if (event.type === "adapter:failed") hasFailed = true;
            events.push(event);
          }
        }
        return events.length === 0 ? null : events;
      },
    };

    let runAbortController: AbortController | null = null;
    const runner = new AdapterStreamRunner<Record<string, unknown>>({
      emitStartedImmediately: true,
      emitFailedOnAbort: true,
      initialSessionId: sessionId,
      startedExtra: {
        ...(input.systemPrompt !== undefined
          ? { systemPrompt: input.systemPrompt }
          : {}),
        ...(this.config.model !== undefined
          ? { model: this.config.model }
          : {}),
      },
      onAbortController: (ctrl) => {
        runAbortController = ctrl;
        this.activeAbortControllers.add(ctrl);
      },
    });

    // Intercept the runner so we can inject raw events before each batch.
    // We do this by hooking into the source's mapRawEvent indirectly: we
    // override source.mapRawEvent to also capture the raw record, then emit
    // the ProviderRawStreamEvent before the normalized events below.
    const rawQueue: RawAgentEvent[] = [];
    const originalMapRawEvent = source.mapRawEvent!.bind(source);
    source.mapRawEvent = (
      record: Record<string, unknown>,
      context: import("./stream-runner.js").StreamContext
    ) => {
      if (emitRaw) {
        rawOrdinal += 1;
        const providerEventId = `${adapter.providerId}-raw-${rawOrdinal}`;
        const rawEvent: RawAgentEvent = {
          providerId: adapter.providerId,
          runId: input.correlationId ?? sessionId,
          sessionId,
          providerEventId,
          timestamp: Date.now(),
          source: "stdout",
          payload: record,
          ...(input.correlationId !== undefined
            ? { correlationId: input.correlationId }
            : {}),
        };
        rawQueue.push(rawEvent);
        // Fire-and-forget persistence — errors are swallowed by RunEventStore
        if (store) {
          void store.appendRaw(rawEvent);
        }
      }
      return originalMapRawEvent(record, context);
    };

    try {
      // Track whether the runner emitted its own adapter:failed (from its
      // catch path) so we can suppress the synthetic adapter:completed.
      for await (const event of runner.run(source, input, input.signal)) {
        // Flush any pending raw events before each batch of normalized events.
        while (rawQueue.length > 0) {
          yield { type: "adapter:provider_raw", rawEvent: rawQueue.shift()! };
        }

        if (event.type === "adapter:failed") {
          hasFailed = true;
          // Re-emit the runner's adapter:failed but normalize the error code
          // back to the captured original (legacy preserves spawn error code).
          if (captured.error) {
            yield withCorrelationId(
              {
                type: "adapter:failed",
                providerId: adapter.providerId,
                sessionId,
                error: captured.error.message,
                code: captured.error.code,
                timestamp: Date.now(),
              },
              input.correlationId
            );
            continue;
          }
        }
        yield event;
      }

      // Flush any pending events emitted by the resolver after the stream ended.
      for (const evt of pendingEvents.splice(0)) yield evt;

      // Synthesise adapter:completed when the stream ended without a terminal.
      if (!hasCompleted && !hasFailed) {
        yield withCorrelationId(
          {
            type: "adapter:completed",
            providerId: this.providerId,
            sessionId,
            result: "",
            durationMs: Date.now() - startTime,
            timestamp: Date.now(),
          },
          input.correlationId
        );
      }
    } finally {
      resolver?.dispose();
      if (resolver) this.activeInteractionResolvers.delete(resolver);
      if (runAbortController) this.activeAbortControllers.delete(runAbortController);
      this.stopArtifactWatcher();
      this.governance.setRunContext(null);
    }

    // Preserve legacy semantics: rethrow ForgeError originals after the
    // adapter:failed event has been yielded so the host can observe them.
    if (captured.error && this.shouldRethrow(captured.error.original)) {
      throw captured.error.original;
    }
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput
  ): AsyncGenerator<AgentEvent, void, undefined> {
    yield* this.execute({ ...input, resumeSessionId: sessionId });
  }

  respondInteraction(interactionId: string, answer: string): boolean {
    for (const resolver of this.activeInteractionResolvers) {
      if (resolver.respond(interactionId, answer)) return true;
    }
    return false;
  }

  interrupt(): void {
    for (const controller of this.activeAbortControllers) controller.abort();
    this.activeAbortControllers.clear();
  }

  executeControlled(input: AgentInput): ControlledExecutionHandle {
    return createControlledExecutionHandle({
      providerId: this.providerId,
      backend: "cli",
      input,
      execute: (runInput) => this.execute(runInput),
    });
  }

  async healthCheck(): Promise<HealthStatus> {
    const binary = this.getBinaryName();
    const cliAvailable = await isBinaryAvailable(binary);
    return {
      healthy: cliAvailable,
      providerId: this.providerId,
      sdkInstalled: cliAvailable,
      cliAvailable,
      lastError: cliAvailable
        ? undefined
        : this.getUnavailableBinaryMessage(binary),
      monitorStatus: this.getMonitorStatus(),
    };
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts };
  }

  /** Wire an artifact-watcher factory. See {@link ArtifactWatcherHost}. */
  setArtifactWatcherFactory(
    factory:
      | ((
          paths: string[],
          providerId: AdapterProviderId
        ) => ArtifactWatcherHandle)
      | null
  ): void {
    this.artifactWatcherHost.setFactory(factory);
  }

  getMonitorStatus(): AdapterMonitorStatus {
    return this.artifactWatcherHost.getStatus();
  }

  protected startArtifactWatcher(paths: string[]): void {
    this.artifactWatcherHost.start(paths);
  }

  protected stopArtifactWatcher(): void {
    this.artifactWatcherHost.stop();
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    };
  }

  protected getUnavailableBinaryMessage(b: string): string {
    return `'${b}' binary not found in PATH`;
  }

  protected buildEnv(): Record<string, string> {
    return buildEnvHelper(this.config);
  }

  protected buildSpawnEnv(input: AgentInput): Record<string, string> {
    // Honors subclass overrides of buildEnv (e.g. Qwen sets DASHSCOPE_API_KEY).
    return filterSensitiveEnvVars(
      applyTraceEnv(this.buildEnv(), input),
      this.config.envFilter
    );
  }

  protected async prepareCliRun(input: AgentInput): Promise<PreparedCliRun> {
    return {
      args: this.buildArgs(input),
      cwd: input.workingDirectory ?? this.config.workingDirectory,
      env: this.buildSpawnEnv(input),
    };
  }

  protected normalizeError(err: unknown): NormalizedAdapterError {
    return normalizeAdapterError(err);
  }

  protected shouldRethrow(err: unknown): boolean {
    return shouldRethrowAdapterError(err);
  }

  /**
   * Pre-execution preflight gate. Runs the built-in validators (budget sanity,
   * skill-tool coverage) before any process is spawned. Subclasses may override
   * to add provider-specific checks — call `super.assertReady(input)` first.
   *
   * Throws a descriptive Error when any validator returns `ok: false`.
   */
  protected async assertReady(input?: AgentInput): Promise<void> {
    if (!input) return;
    const validator = buildPreflightValidator();
    const result = await validator.validate(input, {
      providerId: this.providerId,
    });
    if (!result.ok) {
      const errors = result.issues
        .filter((i) => i.severity === "error")
        .map((i) => `[${i.code}] ${i.message}`)
        .join("; ");
      throw new ForgeError({
        code: "VALIDATION_FAILED",
        message: `Preflight validation failed for provider "${this.providerId}": ${errors}`,
        recoverable: false,
        context: { providerId: this.providerId, issues: result.issues },
      });
    }
  }

  protected resolveInteractionPolicy(input: AgentInput): InteractionPolicy {
    const perCall = input.options?.["interactionPolicy"];
    if (
      perCall !== null &&
      typeof perCall === "object" &&
      "mode" in (perCall as object)
    ) {
      return perCall as InteractionPolicy;
    }
    return this.config.interactionPolicy ?? { mode: "auto-approve" };
  }

  protected abstract getBinaryName(): string;
  protected abstract buildArgs(input: AgentInput): string[];
  protected abstract mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string
  ): AgentEvent | AgentEvent[] | undefined;
}
