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

  // AGENT-H-28 reachability: `guardrailMaxCostUsd` is only applied alongside
  // `guardrailClient` — both the admission path and the post-run write return
  // early without a client. A ceiling set without one is therefore silently
  // ignored, which is indistinguishable at runtime from "no ceiling wanted"
  // and is the most expensive way to misconfigure this feature.
  describe("spend-ceiling misconfiguration guard", () => {
    it("throws when a ceiling is set without a guardrail client", () => {
      expect(() =>
        maybeStartRunWorker(
          baseConfig({
            runQueue: new InMemoryRunQueue(),
            guardrailMaxCostUsd: 25,
          }),
          vi.fn(async () => ({ output: { ok: true } })),
        ),
      ).toThrow(/guardrailMaxCostUsd is set but guardrailClient is not/);

      // The worker must NOT have started: booting with an unenforceable
      // ceiling is exactly the silent-overspend state being prevented.
      expect(startRunWorker).not.toHaveBeenCalled();
    });

    it("starts normally when both the ceiling and the client are supplied", () => {
      const guardrailClient = makeGuardrailClient();

      maybeStartRunWorker(
        baseConfig({
          runQueue: new InMemoryRunQueue(),
          guardrailClient,
          guardrailMaxCostUsd: 25,
        }),
        vi.fn(async () => ({ output: { ok: true } })),
      );

      expect(startRunWorker).toHaveBeenCalledTimes(1);
      // Assert the exact value reaches the worker, not merely that a key
      // exists — a ceiling that arrives as `undefined` enforces nothing.
      const forwarded = vi.mocked(startRunWorker).mock.calls[0]?.[0] as {
        guardrailMaxCostUsd?: number;
      };
      expect(forwarded.guardrailMaxCostUsd).toBe(25);
    });

    it("allows a client with no ceiling (track-only stays valid)", () => {
      maybeStartRunWorker(
        baseConfig({
          runQueue: new InMemoryRunQueue(),
          guardrailClient: makeGuardrailClient(),
        }),
        vi.fn(async () => ({ output: { ok: true } })),
      );

      expect(startRunWorker).toHaveBeenCalledTimes(1);
    });

    it("allows an explicit Infinity ceiling as track-only", () => {
      // `Infinity` is the DistributedCostLedger's own default, so passing it
      // explicitly is a legitimate "record spend, never abort".
      maybeStartRunWorker(
        baseConfig({
          runQueue: new InMemoryRunQueue(),
          guardrailClient: makeGuardrailClient(),
          guardrailMaxCostUsd: Number.POSITIVE_INFINITY,
        }),
        vi.fn(async () => ({ output: { ok: true } })),
      );

      expect(startRunWorker).toHaveBeenCalledTimes(1);
    });

    it("rejects a NaN ceiling, which can never compare true", () => {
      expect(() =>
        maybeStartRunWorker(
          baseConfig({
            runQueue: new InMemoryRunQueue(),
            guardrailClient: makeGuardrailClient(),
            guardrailMaxCostUsd: Number.NaN,
          }),
          vi.fn(async () => ({ output: { ok: true } })),
        ),
      ).toThrow(/non-negative number/);

      expect(startRunWorker).not.toHaveBeenCalled();
    });

    it("rejects a negative ceiling", () => {
      expect(() =>
        maybeStartRunWorker(
          baseConfig({
            runQueue: new InMemoryRunQueue(),
            guardrailClient: makeGuardrailClient(),
            guardrailMaxCostUsd: -1,
          }),
          vi.fn(async () => ({ output: { ok: true } })),
        ),
      ).toThrow(/non-negative number/);

      expect(startRunWorker).not.toHaveBeenCalled();
    });
  });
});
