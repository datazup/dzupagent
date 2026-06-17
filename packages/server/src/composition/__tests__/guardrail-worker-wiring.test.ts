/**
 * P3 composition wiring: a host-level guardrail client must reach the run
 * worker so admission and final-cost recording share the same fleet backend.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from "@dzupagent/core";
import type { CostLedgerClient } from "@dzupagent/agent";

import { InMemoryRunQueue } from "../../queue/run-queue.js";
import { maybeStartRunWorker } from "../workers.js";
import type { ForgeServerConfig } from "../types.js";
import { startRunWorker } from "../../runtime/run-worker.js";

vi.mock("../../runtime/run-worker.js", () => ({
  startRunWorker: vi.fn(),
}));

function makeGuardrailClient(): CostLedgerClient {
  return {
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    incrByFloat: vi.fn(async () => 0),
  };
}

function baseConfig(
  overrides: Partial<ForgeServerConfig> = {},
): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  };
}

describe("composition guardrail worker wiring", () => {
  beforeEach(() => {
    vi.mocked(startRunWorker).mockClear();
  });

  it("forwards ForgeServerConfig.guardrailClient into startRunWorker", () => {
    const guardrailClient = makeGuardrailClient();
    const runExecutor = vi.fn(async () => ({ output: { ok: true } }));

    maybeStartRunWorker(
      baseConfig({
        runQueue: new InMemoryRunQueue(),
        guardrailClient,
      }),
      runExecutor,
    );

    expect(startRunWorker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startRunWorker).mock.calls[0]?.[0]).toMatchObject({
      guardrailClient,
      runExecutor,
    });
  });
});
