/**
 * Rate-limit + distributed-cost coordination for {@link DzupAgent}.
 *
 * Centralises the two pre/post hooks that wrap every model invocation:
 *
 *   - {@link awaitRateLimit} — gated *before* dispatch. Honours the
 *     distributed limiter (MC-07) when configured, falls back to the
 *     local TokenBucket otherwise. Emits a structured
 *     `agent:rate_limited` event on either path.
 *   - {@link recordDistributedCost} — runs *after* a successful
 *     invocation. Updates the distributed cost ledger (MC-07), emits
 *     `agent:rate_limited` when the fleet ceiling is reached, and then
 *     throws {@link CostCeilingExceededError} to abort the run
 *     (AGENT-H-28). Ledger/Redis *failures* are still swallowed so
 *     observational accounting never breaks the run — only a confirmed
 *     breach is fatal.
 *
 * Extracted from `dzip-agent.ts` (MC-004) so the agent class stays a
 * thin coordinator and these hooks can be unit-tested in isolation.
 */
import type { BaseMessage } from "@langchain/core/messages";
import {
  calculateCostCents,
  extractTokenUsage,
  type TokenBucket,
} from "@dzupagent/core/llm";
import type { DzupEventBus } from "@dzupagent/core/events";
import type { DistributedRateLimiter } from "../guardrails/distributed-rate-limiter.js";
import type {
  CostLedgerRecordResult,
  DistributedCostLedger,
} from "../guardrails/distributed-budget.js";

/**
 * Thrown by {@link recordDistributedCost} when the fleet-wide cumulative
 * spend ceiling (`guardrails.distributed.costLedger.maxCostUsd`) has been
 * reached or exceeded.
 *
 * This aborts the in-flight run. It is raised only on a *successful*
 * ledger read reporting `allowed === false`; ledger/Redis failures
 * degrade to a per-process total and never produce this error.
 */
export class CostCeilingExceededError extends Error {
  readonly tenantId: string;
  readonly agentId: string;
  readonly totalCostUsd: number;

  constructor(
    message: string,
    details: { tenantId: string; agentId: string; totalCostUsd: number }
  ) {
    super(message);
    this.name = "CostCeilingExceededError";
    this.tenantId = details.tenantId;
    this.agentId = details.agentId;
    this.totalCostUsd = details.totalCostUsd;
  }
}

/**
 * Dependency bundle for {@link awaitRateLimit} and
 * {@link recordDistributedCost}. Mirrors the agent-private fields one-for-one
 * so the call sites in `DzupAgent` can pass `this` slices directly.
 */
export interface RateLimitCoordinatorDeps {
  agentId: string;
  tenantId: string;
  rateLimiter: TokenBucket | undefined;
  distributedRateLimiter: DistributedRateLimiter | undefined;
  distributedCostLedger: DistributedCostLedger | undefined;
  eventBus: DzupEventBus | undefined;
}

/**
 * Pre-invocation rate-limit gate.
 *
 * Distributed first: when configured, the fleet-wide ceiling owns the
 * gate. A `false` return means the shared window is exhausted; we
 * surface that as a structured event and throw so callers see the same
 * shape as the local TokenBucket failure.
 */
export async function awaitRateLimit(
  deps: RateLimitCoordinatorDeps
): Promise<void> {
  const { agentId, tenantId, rateLimiter, distributedRateLimiter, eventBus } =
    deps;

  if (distributedRateLimiter) {
    let allowed = true;
    try {
      allowed = await distributedRateLimiter.tryConsume(tenantId, agentId);
    } catch (err) {
      // The limiter handles its own fallback; an exception here only
      // happens when both Redis and the local limiter throw. Treat
      // as fail-open per the distributed-rate-limiter contract.
      eventBus?.emit({
        type: "agent:rate_limited",
        agentId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!allowed) {
      const reason = `Distributed rate limit exceeded for ${tenantId}:${agentId}`;
      eventBus?.emit({
        type: "agent:rate_limited",
        agentId,
        reason,
      });
      throw new Error(reason);
    }
    return;
  }

  if (!rateLimiter) return;
  try {
    await rateLimiter.waitUntilAvailable(1);
  } catch (err) {
    // Surface a structured event before propagating so operators can
    // distinguish client-side throttling from provider-side failures.
    eventBus?.emit({
      type: "agent:rate_limited",
      agentId,
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Record the cost of a successful LLM invocation against the
 * distributed cost ledger (MC-07). Best-effort: failures emit a
 * structured event but never propagate so the agent run continues.
 */
export async function recordDistributedCost(
  deps: RateLimitCoordinatorDeps,
  message: BaseMessage,
  modelName?: string
): Promise<void> {
  const { agentId, tenantId, distributedCostLedger, eventBus } = deps;
  if (!distributedCostLedger) return;

  // Accounting itself is best-effort: a ledger/Redis failure must never
  // break the run (the ledger already degrades to a per-process total
  // internally). Only a *successful* read of `allowed === false` is a
  // real breach, so the breach throw is deliberately raised OUTSIDE this
  // try/catch — otherwise it would be swallowed by its own handler.
  let breach: CostLedgerRecordResult | undefined;
  try {
    const usage = extractTokenUsage(message, modelName);
    const costCents = calculateCostCents(usage);
    const costUsd = costCents / 100;
    const result = await distributedCostLedger.record(
      tenantId,
      agentId,
      costUsd
    );
    if (!result.allowed) breach = result;
  } catch {
    // Cost recording is observational; never fail the run.
  }

  if (!breach) return;

  // AGENT-H-28: the fleet-wide ceiling is enforced, not merely observed.
  // Mirrors `awaitRateLimit`, which already throws when the shared
  // rate-limit window is exhausted.
  const reason = `Distributed cost ceiling reached for ${tenantId}:${agentId} (totalUsd=${breach.totalCostUsd})`;
  eventBus?.emit({
    type: "agent:rate_limited",
    agentId,
    reason,
  });
  throw new CostCeilingExceededError(reason, {
    tenantId,
    agentId,
    totalCostUsd: breach.totalCostUsd,
  });
}
