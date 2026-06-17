/**
 * P3 residual — wiring the RedisGuardrailClient (a CostLedgerClient) into the
 * run admission stage and exposing a connection-based factory.
 *
 * These tests stay DB-free: the run store / event bus are `vi.fn()` mocks and
 * the agent is resolved from an inline stub. They assert the *shape* of the
 * derived agent spec the admission stage produces, not any Redis behaviour.
 */
import { describe, it, expect, vi } from "vitest";
import type { CostLedgerClient } from "@dzupagent/agent";
import type { AgentExecutionSpec, RunStore } from "@dzupagent/core/persistence";
import type { DzupEventBus } from "@dzupagent/core/events";
import { runAdmissionStage } from "../../runtime/run-stages-admission.js";
import {
  RedisGuardrailClient,
  createRedisGuardrailClientFromConnection,
  type RedisLikeConnection,
} from "../redis-guardrail-client.js";
import type { RunJob } from "../../queue/run-queue.js";

function makeJob(): RunJob {
  return {
    id: "job-1",
    runId: "run-1",
    agentId: "agent-1",
    input: { prompt: "hi" },
    metadata: {},
  } as RunJob;
}

function makeRunStore(): RunStore {
  return {
    update: vi.fn(async () => {}),
    addLog: vi.fn(async () => {}),
    addLogs: vi.fn(async () => {}),
    get: vi.fn(async () => null),
  } as unknown as RunStore;
}

function makeEventBus(): DzupEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  } as unknown as DzupEventBus;
}

function makeGuardrailClient(): CostLedgerClient {
  return {
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    incrByFloat: vi.fn(async () => 0),
  };
}

describe("runAdmissionStage guardrail-client wiring", () => {
  it("attaches the guardrail client as the distributed cost-ledger + rate-limiter when provided", async () => {
    const client = makeGuardrailClient();
    const agent: AgentExecutionSpec = {
      id: "agent-1",
      name: "Agent One",
      instructions: "do things",
      modelTier: "chat",
      guardrails: { maxCostCents: 500 },
    } as AgentExecutionSpec;

    const result = await runAdmissionStage({
      job: makeJob(),
      inputGuard: null,
      runStore: makeRunStore(),
      eventBus: makeEventBus(),
      resolveAgent: async () => agent,
      guardrailClient: client,
    });

    expect(result.rejected).toBe(false);
    if (result.rejected) return; // narrow
    const distributed = (result.agent.guardrails as Record<string, unknown>)[
      "distributed"
    ] as {
      costLedger: { client: unknown };
      rateLimiter: { client: unknown };
    };
    expect(distributed.costLedger.client).toBe(client);
    expect(distributed.rateLimiter.client).toBe(client);
    // Existing guardrail fields are preserved on the derived spec.
    expect(
      (result.agent.guardrails as Record<string, unknown>)["maxCostCents"]
    ).toBe(500);
    // The original agent object is NOT mutated.
    expect(
      (agent.guardrails as Record<string, unknown>)["distributed"]
    ).toBeUndefined();
  });

  it("leaves the agent guardrails unchanged when no guardrail client is provided", async () => {
    const guardrails = { maxCostCents: 500 };
    const agent: AgentExecutionSpec = {
      id: "agent-1",
      name: "Agent One",
      instructions: "do things",
      modelTier: "chat",
      guardrails,
    } as AgentExecutionSpec;

    const result = await runAdmissionStage({
      job: makeJob(),
      inputGuard: null,
      runStore: makeRunStore(),
      eventBus: makeEventBus(),
      resolveAgent: async () => agent,
    });

    expect(result.rejected).toBe(false);
    if (result.rejected) return; // narrow
    // Same reference back when no client wiring is requested.
    expect(result.agent.guardrails).toBe(guardrails);
    expect(
      (result.agent.guardrails as Record<string, unknown>)["distributed"]
    ).toBeUndefined();
  });

  it("createRedisGuardrailClientFromConnection returns a RedisGuardrailClient", () => {
    const conn: RedisLikeConnection = {
      incr: async () => 1,
      expire: async () => 1,
      get: async () => null,
      del: async () => 1,
      incrbyfloat: async () => "0",
    };
    const client = createRedisGuardrailClientFromConnection(conn);
    expect(client).toBeInstanceOf(RedisGuardrailClient);
  });
});
