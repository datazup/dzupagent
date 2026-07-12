/**
 * R3-ISO-03/04 — tenant isolation in post-run learning stages.
 *
 * - Cross-intent context transfer must be namespaced per tenant: two tenants
 *   sharing a `sessionId` (client-supplied, colliding or hostile) must never
 *   see each other's persisted context.
 * - Model-tier escalation state must be keyed per tenant: one tenant's
 *   consecutive low scores must not escalate the tier applied to another
 *   tenant's runs of the same agent + intent.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createEventBus,
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  RunContextTransfer,
} from "@dzupagent/core";
import { InMemoryStore } from "@langchain/langgraph";
import type { RunJob } from "../queue/run-queue.js";
import { runPostRunLearningStage } from "../runtime/run-stages-persistence.js";
import { dispatchExecutionStage } from "../runtime/run-stages-execution.js";
import type { StartRunWorkerOptions } from "../runtime/run-worker-types.js";
import { InMemoryRunQueue } from "../queue/run-queue.js";

function makeJob(overrides: Partial<RunJob> = {}): RunJob {
  return {
    id: "job-1",
    runId: "run-1",
    agentId: "agent-x",
    input: { message: "hi" },
    priority: 1,
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

const AGENT = {
  id: "agent-x",
  name: "Agent X",
  instructions: "test",
  modelTier: "chat",
};

function makeWorkerOptions(
  overrides: Partial<StartRunWorkerOptions> = {}
): StartRunWorkerOptions {
  return {
    runQueue: new InMemoryRunQueue({ concurrency: 1 }),
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    runExecutor: async () => ({ content: "ok" }),
    ...overrides,
  };
}

describe("cross-intent context transfer tenant isolation (R3-ISO-03)", () => {
  it("does not leak prior context across tenants sharing a sessionId", async () => {
    const contextTransfer = new RunContextTransfer({
      store: new InMemoryStore(),
    });
    const runStore = new InMemoryRunStore();
    const workerOptions = makeWorkerOptions({ runStore, contextTransfer });

    // Tenant A completes a generate_feature run in session "shared".
    const runA = await runStore.create({ agentId: "agent-x", input: "a" });
    await runPostRunLearningStage({
      workerOptions,
      job: makeJob({
        runId: runA.id,
        metadata: {
          tenantId: "tenant-A",
          sessionId: "shared",
          intent: "generate_feature",
        },
      }),
      agent: AGENT,
      input: "a",
      output: "tenant A secret output",
      additionalLogs: [],
      durationMs: 10,
    });

    // Tenant B starts an edit_feature run in the SAME session id — its
    // intent chain would match tenant A's saved context if unscoped.
    const capturedMetadata: Array<Record<string, unknown> | undefined> = [];
    const capturingOptions = makeWorkerOptions({
      runStore,
      contextTransfer,
      runExecutor: async (ctx) => {
        capturedMetadata.push(ctx.metadata);
        return { content: "ok" };
      },
    });
    const runB = await runStore.create({ agentId: "agent-x", input: "b" });
    await dispatchExecutionStage({
      workerOptions: capturingOptions,
      job: makeJob({
        runId: runB.id,
        metadata: {
          tenantId: "tenant-B",
          sessionId: "shared",
          intent: "edit_feature",
        },
      }),
      agent: AGENT,
      input: "b",
      signal: new AbortController().signal,
    });

    expect(capturedMetadata).toHaveLength(1);
    expect(capturedMetadata[0]?.["priorContext"]).toBeUndefined();
  });

  it("still transfers context within the same tenant and session", async () => {
    const contextTransfer = new RunContextTransfer({
      store: new InMemoryStore(),
    });
    const runStore = new InMemoryRunStore();
    const workerOptions = makeWorkerOptions({ runStore, contextTransfer });

    const runA = await runStore.create({ agentId: "agent-x", input: "a" });
    await runPostRunLearningStage({
      workerOptions,
      job: makeJob({
        runId: runA.id,
        metadata: {
          tenantId: "tenant-A",
          sessionId: "shared",
          intent: "generate_feature",
        },
      }),
      agent: AGENT,
      input: "a",
      output: "tenant A output",
      additionalLogs: [],
      durationMs: 10,
    });

    const capturedMetadata: Array<Record<string, unknown> | undefined> = [];
    const capturingOptions = makeWorkerOptions({
      runStore,
      contextTransfer,
      runExecutor: async (ctx) => {
        capturedMetadata.push(ctx.metadata);
        return { content: "ok" };
      },
    });
    const runA2 = await runStore.create({ agentId: "agent-x", input: "a2" });
    await dispatchExecutionStage({
      workerOptions: capturingOptions,
      job: makeJob({
        runId: runA2.id,
        metadata: {
          tenantId: "tenant-A",
          sessionId: "shared",
          intent: "edit_feature",
        },
      }),
      agent: AGENT,
      input: "a2",
      signal: new AbortController().signal,
    });

    const prior = capturedMetadata[0]?.["priorContext"] as
      | { fromIntent: string; summary: string }
      | undefined;
    expect(prior).toBeDefined();
    expect(prior?.fromIntent).toBe("generate_feature");
    expect(prior?.summary).toContain("tenant A output");
  });
});

describe("model-tier escalation tenant isolation (R3-ISO-04)", () => {
  it("keys escalation state per tenant for the same agent + intent", async () => {
    const recordedKeys: string[] = [];
    const escalationPolicy = {
      recordScore: vi.fn((key: string) => {
        recordedKeys.push(key);
        return {
          shouldEscalate: false,
          fromTier: "chat",
          toTier: "chat",
          reason: "below threshold count",
          consecutiveLowScores: 1,
        };
      }),
    };
    const reflector = {
      score: vi.fn(() => ({ overall: 0.1, dimensions: {}, flags: [] })),
    };
    const runStore = new InMemoryRunStore();
    const workerOptions = makeWorkerOptions({
      runStore,
      reflector,
      escalationPolicy,
    });

    for (const tenantId of ["tenant-A", "tenant-B"]) {
      const run = await runStore.create({ agentId: "agent-x", input: "x" });
      await runPostRunLearningStage({
        workerOptions,
        job: makeJob({
          runId: run.id,
          metadata: { tenantId, intent: "generate_feature", modelTier: "chat" },
        }),
        agent: AGENT,
        input: "x",
        output: "out",
        additionalLogs: [],
        durationMs: 10,
      });
    }

    expect(recordedKeys).toHaveLength(2);
    expect(recordedKeys[0]).not.toBe(recordedKeys[1]);
    expect(recordedKeys[0]).toContain("tenant-A");
    expect(recordedKeys[1]).toContain("tenant-B");
  });
});
