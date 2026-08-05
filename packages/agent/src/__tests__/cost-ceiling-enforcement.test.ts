/**
 * AGENT-H-28 — the fleet-wide cost ceiling is *enforced*, not merely observed.
 *
 * Before this, `recordDistributedCost` read `result.allowed` and emitted an
 * event on breach but always resolved normally, so nothing stopped a run that
 * had blown the fleet budget. These tests pin the enforcement seam:
 *
 *   - a confirmed breach throws `CostCeilingExceededError` (and still emits)
 *   - an under-cap call stays silent and does not throw
 *   - a ledger/Redis *failure* is still swallowed (fail-open contract intact)
 *
 * The last case is the one a naive fix breaks: raising the throw inside the
 * existing try/catch would have it swallowed by its own handler.
 */
import { describe, it, expect, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import {
  recordDistributedCost,
  CostCeilingExceededError,
  type RateLimitCoordinatorDeps,
} from "../agent/rate-limit-coordinator.js";
import { shouldRunFailover } from "../agent/provider-selection.js";
import type { DistributedCostLedger } from "../guardrails/distributed-budget.js";
import type { DzupEventBus } from "@dzupagent/core/events";

function makeEventBus(): DzupEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  } as unknown as DzupEventBus;
}

/** A message carrying real usage so `calculateCostCents` yields a non-zero cost. */
function makeMessage(): AIMessage {
  return new AIMessage({
    content: "ok",
    response_metadata: { model_name: "gpt-4o" },
    usage_metadata: {
      input_tokens: 1000,
      output_tokens: 1000,
      total_tokens: 2000,
    },
  });
}

function makeDeps(
  ledger: Pick<DistributedCostLedger, "record">,
  eventBus: DzupEventBus
): RateLimitCoordinatorDeps {
  return {
    agentId: "agent-1",
    tenantId: "tenant-1",
    rateLimiter: undefined,
    distributedRateLimiter: undefined,
    distributedCostLedger: ledger as DistributedCostLedger,
    eventBus,
  };
}

describe("recordDistributedCost — fleet-wide ceiling enforcement", () => {
  it("throws CostCeilingExceededError when the ledger reports a breach", async () => {
    const eventBus = makeEventBus();
    const ledger = {
      record: vi.fn(async () => ({ allowed: false, totalCostUsd: 42.5 })),
    };

    await expect(
      recordDistributedCost(makeDeps(ledger, eventBus), makeMessage())
    ).rejects.toBeInstanceOf(CostCeilingExceededError);

    expect(ledger.record).toHaveBeenCalledTimes(1);
  });

  it("carries the breach details on the thrown error", async () => {
    const ledger = {
      record: vi.fn(async () => ({ allowed: false, totalCostUsd: 42.5 })),
    };

    const err = await recordDistributedCost(
      makeDeps(ledger, makeEventBus()),
      makeMessage()
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CostCeilingExceededError);
    const typed = err as CostCeilingExceededError;
    expect(typed.tenantId).toBe("tenant-1");
    expect(typed.agentId).toBe("agent-1");
    expect(typed.totalCostUsd).toBe(42.5);
  });

  it("still emits the structured rate-limited event on breach", async () => {
    const eventBus = makeEventBus();
    const ledger = {
      record: vi.fn(async () => ({ allowed: false, totalCostUsd: 42.5 })),
    };

    await recordDistributedCost(
      makeDeps(ledger, eventBus),
      makeMessage()
    ).catch(() => {});

    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent:rate_limited",
        agentId: "agent-1",
      })
    );
  });

  it("does not throw or emit while under the ceiling", async () => {
    const eventBus = makeEventBus();
    const ledger = {
      record: vi.fn(async () => ({ allowed: true, totalCostUsd: 1.25 })),
    };

    await expect(
      recordDistributedCost(makeDeps(ledger, eventBus), makeMessage())
    ).resolves.toBeUndefined();

    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  // Redis fail-open is a documented contract (distributed-budget.ts:15-19) and
  // is deliberately NOT inverted by AGENT-H-28: an infra blip must not hard-stop
  // every run in the fleet. Only a *confirmed* over-cap read is fatal.
  it("swallows a ledger failure rather than aborting the run", async () => {
    const eventBus = makeEventBus();
    const ledger = {
      record: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };

    await expect(
      recordDistributedCost(makeDeps(ledger, eventBus), makeMessage())
    ).resolves.toBeUndefined();
  });

  // The throw lands inside a provider-failover `catch`. If the failover
  // policy treated it as retryable, hitting the cap would trigger a retry on
  // ANOTHER provider — spending more money past the ceiling. Pin that shut,
  // including against a host override that would otherwise retry everything.
  it("is never retried by provider failover, even under a retry-everything override", () => {
    const err = new CostCeilingExceededError("ceiling", {
      tenantId: "t",
      agentId: "a",
      totalCostUsd: 99,
    });

    const config = {
      providerFailover: { enabled: true, shouldRetry: () => true },
    } as unknown as Parameters<typeof shouldRunFailover>[0];

    expect(shouldRunFailover(config, err, [])).toBe(false);
    // Control: the same permissive policy DOES retry an ordinary error,
    // proving the `false` above comes from the ceiling check specifically.
    expect(shouldRunFailover(config, new Error("boom"), [])).toBe(true);
  });

  it("is a no-op when no distributed ledger is configured", async () => {
    const eventBus = makeEventBus();
    const deps: RateLimitCoordinatorDeps = {
      agentId: "agent-1",
      tenantId: "tenant-1",
      rateLimiter: undefined,
      distributedRateLimiter: undefined,
      distributedCostLedger: undefined,
      eventBus,
    };

    await expect(
      recordDistributedCost(deps, makeMessage())
    ).resolves.toBeUndefined();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
