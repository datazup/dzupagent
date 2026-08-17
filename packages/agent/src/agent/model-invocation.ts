/**
 * Model invocation coordinators for {@link DzupAgent}.
 *
 * Wraps `AgentMiddlewareRuntime.invokeModel` with the cross-cutting
 * concerns that every dispatch path needs:
 *
 *   - rate-limit gate ({@link awaitRateLimit})
 *   - circuit-breaker accounting (`registry.recordProviderSuccess` /
 *     `recordProviderFailure`)
 *   - distributed cost ledger ({@link recordDistributedCost})
 *   - optional same-run provider failover (`attemptWithFailover`)
 *
 * Two entry points:
 *
 *   - {@link invokeModelWithMiddleware} — picks the failover path when
 *     the agent has more than one tier candidate, otherwise dispatches
 *     directly with breaker accounting.
 *   - {@link transformToolResultWithMiddleware} — thin helper for the
 *     post-tool middleware hook; lifted alongside invocation so all
 *     middleware-wrapped surfaces live in one module.
 *
 * Extracted from `dzip-agent.ts` (MC-004). Re-exports `ProviderAttempt`
 * from `provider-failover.js` so callers have a single import site.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ModelRegistry } from "@dzupagent/core/llm";
import type { AgentMiddlewareRuntime } from "./middleware-runtime.js";
import {
  ModelCancellationError,
  ModelTimeoutError,
} from "./model-timeout-error.js";
import {
  attemptWithFailover,
  type ProviderAttempt,
} from "./provider-failover.js";
import {
  awaitRateLimit,
  CostCeilingExceededError,
  recordDistributedCost,
  type RateLimitCoordinatorDeps,
} from "./rate-limit-coordinator.js";

export type { ProviderAttempt } from "./provider-failover.js";

/**
 * Dispatch one model call under a deadline and the run's cancellation signal
 * (ORCH-DSL-L1-C-01).
 *
 * The model call is otherwise the only unbounded await in the hot loop: tool
 * calls are deadline-guarded, but a provider that accepts the connection and
 * then stalls hangs the run forever -- `maxIterations` never advances and the
 * token/cost budgets are never re-checked, because all three only tick when a
 * call *returns*.
 *
 * `signal` is threaded into the middleware runtime so providers that honour it
 * stop work at the source; the race additionally guarantees the *caller* is
 * released even when a provider ignores it.
 */
async function invokeModelBounded(
  deps: ModelInvocationDeps,
  model: BaseChatModel,
  messages: BaseMessage[]
): Promise<BaseMessage> {
  const timeoutMs = deps.modelTimeoutMs;
  const parentSignal = deps.signal;

  // Nothing to enforce -- keep the original single-await path so opted-out
  // callers see byte-identical behaviour.
  if (
    (timeoutMs === undefined || timeoutMs <= 0) &&
    parentSignal === undefined
  ) {
    return deps.middlewareRuntime.invokeModel(model, messages);
  }

  if (parentSignal?.aborted) throw new ModelCancellationError();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentAbortHandler: (() => void) | undefined;
  let abortKind: "timeout" | "run_cancelled" | undefined;

  const failFor = (reason: "timeout" | "run_cancelled"): Error =>
    reason === "timeout"
      ? new ModelTimeoutError(timeoutMs ?? 0)
      : new ModelCancellationError();

  const abortPromise = new Promise<never>((_resolve, reject) => {
    const requestAbort = (reason: "timeout" | "run_cancelled") => {
      if (abortKind !== undefined) return;
      abortKind = reason;
      controller.abort(failFor(reason));
      reject(failFor(reason));
    };
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => requestAbort("timeout"), timeoutMs);
    }
    if (parentSignal) {
      parentAbortHandler = () => requestAbort("run_cancelled");
      parentSignal.addEventListener("abort", parentAbortHandler, {
        once: true,
      });
    }
  });

  try {
    const invokePromise = deps.middlewareRuntime
      .invokeModel(model, messages, { signal: controller.signal })
      // A provider that honours the signal rejects with its own abort error;
      // remap so callers always see the model-shaped reason.
      .catch((err: unknown) => {
        if (abortKind !== undefined) throw failFor(abortKind);
        throw err;
      });
    return await Promise.race([invokePromise, abortPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (parentSignal && parentAbortHandler) {
      parentSignal.removeEventListener("abort", parentAbortHandler);
    }
  }
}

/**
 * Dependency bundle for {@link invokeModelWithMiddleware} and
 * {@link invokeModelWithProviderFailover}. Mirrors the agent-private
 * fields one-for-one so the call sites in `DzupAgent` can pass `this`
 * slices directly.
 */
export interface ModelInvocationDeps extends RateLimitCoordinatorDeps {
  middlewareRuntime: AgentMiddlewareRuntime;
  registry: ModelRegistry | undefined;
  resolvedProvider: string | undefined;
  /**
   * Per-call model deadline in ms (ORCH-DSL-L1-C-01). Undefined or <= 0 leaves
   * the call unbounded, preserving the pre-existing behaviour for callers that
   * have not opted in.
   */
  modelTimeoutMs?: number;
  /**
   * Run-scoped cancellation. When it aborts mid-call the invocation rejects
   * with {@link ModelCancellationError} instead of waiting for the provider.
   */
  signal?: AbortSignal;
  /**
   * Resolves the tier-fallback candidates for the *current* tool set.
   * Identical contract to the agent's private `getProviderAttempts`:
   * empty array means "no failover" (single-provider path).
   */
  getProviderAttempts: () => ProviderAttempt[];
  /**
   * Same-run failover policy. Receives the original (non-bound) tool-message
   * list so the caller can implement tool-result-aware retry rules.
   */
  shouldRunFailover: (err: Error, messages: BaseMessage[]) => boolean;
}

/**
 * Dispatch through the middleware runtime, applying the rate-limit
 * gate, breaker accounting, and distributed cost accounting.
 *
 * Picks the failover path when {@link ModelInvocationDeps.getProviderAttempts}
 * yields more than one candidate.
 */
export async function invokeModelWithMiddleware(
  deps: ModelInvocationDeps,
  model: BaseChatModel,
  messages: BaseMessage[]
): Promise<BaseMessage> {
  const attempts = deps.getProviderAttempts();
  if (attempts.length > 1) {
    return invokeModelWithProviderFailover(deps, attempts, messages);
  }

  await awaitRateLimit(deps);
  try {
    const result = await invokeModelBounded(deps, model, messages);
    // Feed the provider's circuit breaker a success signal. No-op when
    // the agent was constructed with an explicit model (no fallback
    // chain in play).
    if (deps.resolvedProvider && deps.registry) {
      deps.registry.recordProviderSuccess(deps.resolvedProvider);
    }
    await recordDistributedCost(deps, result);
    return result;
  } catch (err) {
    // AGENT-H-28: a breached spend ceiling is our own budget verdict, not a
    // provider fault. Feeding it to the circuit breaker would penalise a
    // perfectly healthy provider for our accounting decision.
    if (
      deps.resolvedProvider &&
      deps.registry &&
      !(err instanceof CostCeilingExceededError)
    ) {
      const asError = err instanceof Error ? err : new Error(String(err));
      // Registry filters to transient errors internally, so unconditional
      // is safe.
      deps.registry.recordProviderFailure(deps.resolvedProvider, asError);
    }
    throw err;
  }
}

/**
 * Multi-attempt variant: walks the tier-fallback chain via
 * {@link attemptWithFailover}, emitting `provider:*` lifecycle events
 * and recording success/failure on the same circuit breaker.
 */
export async function invokeModelWithProviderFailover(
  deps: ModelInvocationDeps,
  attempts: ProviderAttempt[],
  messages: BaseMessage[]
): Promise<BaseMessage> {
  return attemptWithFailover<BaseMessage>({
    attempts,
    phase: "invoke",
    agentId: deps.agentId,
    // Correlation id so `provider:run_attempt` / `run_selected` / `run_failure`
    // are attributable to a tenant (C-06 / M-29, partial: `runId` is not yet
    // threaded into this deps bundle — see TASK.md deferred scope).
    ...(deps.tenantId !== undefined && { tenantId: deps.tenantId }),
    eventBus: deps.eventBus,
    registry: deps.registry,
    beforeAttempt: async () => awaitRateLimit(deps),
    shouldRetry: (err) => deps.shouldRunFailover(err, messages),
    execute: async (attempt) => {
      const result = await invokeModelBounded(deps, attempt.model, messages);
      await recordDistributedCost(deps, result);
      return result;
    },
  });
}

/**
 * Thin wrapper over `AgentMiddlewareRuntime.transformToolResult` —
 * kept here so every middleware-wrapped surface lives in one module.
 */
export async function transformToolResultWithMiddleware(
  middlewareRuntime: AgentMiddlewareRuntime,
  toolName: string,
  input: Record<string, unknown>,
  result: string
): Promise<string> {
  return middlewareRuntime.transformToolResult(toolName, input, result);
}
