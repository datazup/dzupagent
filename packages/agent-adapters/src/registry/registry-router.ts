/**
 * AdapterRegistryRouter — routing strategy ownership and fallback execution.
 *
 * Responsible for:
 *  - Selecting the best adapter for a given task via the active strategy.
 *  - Building the fallback chain.
 *  - Driving the per-attempt execution loop and emitting the lifecycle
 *    events expected by downstream observers.
 *
 * Reads CRUD state from {@link AdapterRegistryCore} and circuit-breaker /
 * bookkeeping state from {@link AdapterHealthMonitor}.
 *
 * Two orthogonal concerns are delegated to focused leaf modules so this file
 * stays a routing/selection coordinator:
 *  - `./circuit-breaker-state.js` — post-attempt success/failure bookkeeping
 *    against the health monitor's circuit breaker and lifecycle event emission.
 *  - `./policy-attempt-projection.js` — resolving/compiling the active policy
 *    into the per-attempt adapter input and its conformance/legacy-option events.
 */

import { ForgeError } from "@dzupagent/core/advanced";
import type { DzupEventBus } from "@dzupagent/core/advanced";

import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from "../types.js";
import { PolicyConformanceChecker } from "../policy/policy-conformance.js";
import {
  POLICY_ACTIVE_OPTION_KEY,
  POLICY_CONFORMANCE_MODE_OPTION_KEY,
} from "../pipeline/policy-context-transport.js";
import {
  buildAttemptProgressEvent,
  buildFallbackOrder,
  buildRoutingProgressEvent,
  resolveTimeoutMs,
  runOneAttempt,
  setupAttemptTimeout,
  synthesizeFailureEvents,
} from "./adapter-registry-helpers.js";
import {
  handleAttemptException,
  handleAttemptFailure,
  handleAttemptSuccess,
  type RouterBusEvent,
} from "./circuit-breaker-state.js";
import {
  buildAttemptInput,
  emitWarnOnlyConformanceViolations,
} from "./policy-attempt-projection.js";
import type { AdapterHealthMonitor } from "./health-monitor.js";
import type { AdapterRegistryCore } from "./registry-core.js";
import { resolveTaskTenantId, TagBasedRouter } from "./task-router.js";

function isProviderRawStreamEvent(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "adapter:provider_raw" }> {
  return event.type === "adapter:provider_raw";
}

export class AdapterRegistryRouter {
  private strategy: TaskRoutingStrategy = new TagBasedRouter();
  private readonly policyConformanceChecker = new PolicyConformanceChecker();

  constructor(
    private readonly core: AdapterRegistryCore,
    private readonly health: AdapterHealthMonitor,
    private readonly defaultExecutionTimeoutMs: number | undefined
  ) {}

  /** Replace the active routing strategy. */
  setStrategy(strategy: TaskRoutingStrategy): void {
    this.strategy = strategy;
  }

  /** Get the best available adapter for a task using the active routing strategy. */
  getForTask(task: TaskDescriptor): {
    adapter: AgentCLIAdapter;
    decision: RoutingDecision;
  } {
    const healthyIds = this.core.getHealthyProviderIds();
    if (healthyIds.length === 0) {
      throw new ForgeError({
        code: "ALL_ADAPTERS_EXHAUSTED",
        message: "No healthy adapters available for routing",
        recoverable: false,
        suggestion:
          "Wait for circuit breakers to reset or register additional adapters",
      });
    }

    const decision = this.strategy.route(task, healthyIds);
    const targetId =
      decision.provider === "auto" ? healthyIds[0] : decision.provider;
    const adapter =
      targetId !== undefined
        ? this.core.get(targetId as AdapterProviderId)
        : undefined;

    if (!adapter) {
      throw new ForgeError({
        code: "ALL_ADAPTERS_EXHAUSTED",
        message: `Router selected provider "${String(
          targetId
        )}" but adapter was not found`,
        recoverable: false,
      });
    }

    return {
      adapter,
      decision: {
        ...decision,
        reason: `[tenant:${resolveTaskTenantId(task)}] ${decision.reason}`,
      },
    };
  }

  async *executeWithFallback(
    input: AgentInput,
    task: TaskDescriptor
  ): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.executeWithFallbackWithRaw(input, task)) {
      if (!isProviderRawStreamEvent(event)) yield event;
    }
  }

  async *executeWithFallbackWithRaw(
    input: AgentInput,
    task: TaskDescriptor
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const healthyIds = this.core.getHealthyProviderIds();
    if (healthyIds.length === 0) {
      throw new ForgeError({
        code: "ALL_ADAPTERS_EXHAUSTED",
        message: "No healthy adapters available",
        recoverable: false,
      });
    }

    const decision = this.strategy.route(task, healthyIds);
    const ordered = buildFallbackOrder(
      decision,
      healthyIds,
      task.approvedFallbackProviders
    );
    const effectiveTimeoutMs = resolveTimeoutMs(
      input,
      this.defaultExecutionTimeoutMs
    );

    yield buildRoutingProgressEvent({
      providerId:
        ordered[0] ??
        (decision.provider !== "auto" ? decision.provider : healthyIds[0]),
      decision,
      ordered,
      input,
      message: `[tenant:${resolveTaskTenantId(
        task
      )}] Registry routing → primary=${
        decision.provider !== "auto" ? decision.provider : ordered[0] ?? "auto"
      } fallbacks=${ordered.slice(1).join(",") || "none"}`,
    });

    let lastError: Error | undefined;
    const emittedLegacyOptionWarnings = new Set<
      | typeof POLICY_ACTIVE_OPTION_KEY
      | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY
    >();

    for (let attemptIdx = 0; attemptIdx < ordered.length; attemptIdx++) {
      const providerId = ordered[attemptIdx];
      if (providerId === undefined) continue;
      const adapter = this.core.get(providerId);
      if (!adapter || !this.health.canExecute(providerId)) continue;

      const attemptError = yield* this.runAttempt(
        adapter,
        providerId,
        attemptIdx,
        ordered,
        input,
        effectiveTimeoutMs,
        emittedLegacyOptionWarnings
      );
      if (attemptError === undefined) return; // success returns early
      lastError = attemptError;
    }

    throw synthesizeFailureEvents(ordered, lastError, task);
  }

  /**
   * Execute a single attempt and return the resulting `lastError` (or
   * `undefined` on success — caller treats that as a successful return).
   *
   * Thin orchestrator: emits the start progress event, runs the adapter via
   * {@link runOneAttempt}, then dispatches the outcome to a focused handler.
   */
  private async *runAttempt(
    adapter: AgentCLIAdapter,
    providerId: AdapterProviderId,
    attemptIdx: number,
    ordered: AdapterProviderId[],
    input: AgentInput,
    effectiveTimeoutMs: number | undefined,
    emittedLegacyOptionWarnings: Set<
      | typeof POLICY_ACTIVE_OPTION_KEY
      | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY
    >
  ): AsyncGenerator<AgentStreamEvent, Error | undefined, undefined> {
    const startMs = Date.now();
    const attemptRunId = `${providerId}-${startMs}`;

    yield this.buildStartProgress(
      providerId,
      attemptIdx,
      ordered.length,
      input
    );

    const {
      controller: attemptAbort,
      timeoutHandle,
      getDidTimeout,
    } = setupAttemptTimeout(effectiveTimeoutMs, input.signal);

    try {
      const projected = buildAttemptInput(
        this.policyConformanceChecker,
        this.emit,
        input,
        providerId,
        attemptAbort.signal,
        attemptIdx,
        ordered.length,
        emittedLegacyOptionWarnings
      );
      emitWarnOnlyConformanceViolations(
        this.emit,
        providerId,
        projected.conformanceMode,
        projected.conformanceViolations,
        attemptIdx,
        input.correlationId
      );
      for (const warningEvent of projected.warningEvents) {
        yield warningEvent;
      }
      for (const warningEvent of projected.legacyOptionWarningEvents) {
        yield warningEvent;
      }
      this.emit({
        type: "agent:started",
        agentId: providerId,
        runId: attemptRunId,
      });
      const outcome = yield* runOneAttempt(
        adapter,
        projected.attemptInput,
        providerId,
        effectiveTimeoutMs,
        getDidTimeout
      );

      if (outcome.kind === "success") {
        handleAttemptSuccess(
          this.health,
          this.emit,
          providerId,
          attemptRunId,
          startMs,
          outcome.usage
        );
        return undefined;
      }
      return handleAttemptFailure(
        this.health,
        this.emit,
        providerId,
        attemptRunId,
        outcome.message,
        outcome.code
      );
    } catch (err) {
      return yield* handleAttemptException(
        this.health,
        this.emit,
        err,
        providerId,
        attemptRunId,
        effectiveTimeoutMs,
        getDidTimeout()
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /** Build the per-attempt `adapter:progress` event with the appropriate fallback message. */
  private buildStartProgress(
    providerId: AdapterProviderId,
    attemptIdx: number,
    totalAttempts: number,
    input: AgentInput
  ): Extract<AgentStreamEvent, { type: "adapter:progress" }> {
    return buildAttemptProgressEvent({
      providerId,
      attemptIdx,
      totalAttempts,
      input,
      message:
        attemptIdx === 0
          ? `Executing primary provider ${providerId}`
          : `Falling back to ${providerId} (attempt ${
              attemptIdx + 1
            }/${totalAttempts})`,
    });
  }

  private emit = (event: RouterBusEvent): void => {
    const bus: DzupEventBus | undefined = this.core.getEventBus();
    bus?.emit(event);
  };
}
