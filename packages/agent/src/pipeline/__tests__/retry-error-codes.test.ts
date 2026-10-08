/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-R1: exact error-code retry matching.
 *
 * When a retry policy carries `retryableErrorCodes`, a failed attempt is
 * retried iff its `errorMetadata.code` equals one listed code. Message
 * patterns are not consulted, so a code that only appears inside a message
 * never triggers a retry. Without the field, behaviour is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineDefinition } from "@dzupagent/core";

import { PipelineRuntime } from "../pipeline-runtime.js";
import type {
  NodeExecutor,
  NodeResult,
  RetryPolicy,
} from "../pipeline-runtime-types.js";
import { isRetryable, resolveRetryPolicy } from "../retry-policy.js";

function pipeline(retryPolicy: Record<string, unknown>): PipelineDefinition {
  return {
    id: "retry-codes",
    name: "Retry codes",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "A",
    nodes: [
      {
        id: "A",
        type: "agent",
        agentId: "a1",
        timeoutMs: 5000,
        retries: 3,
        retryPolicy,
      },
    ],
    edges: [],
  } as PipelineDefinition;
}

function scripted(results: Array<Omit<NodeResult, "nodeId" | "durationMs">>): {
  executor: NodeExecutor;
  calls: () => number;
} {
  let calls = 0;
  const executor: NodeExecutor = async (nodeId) => {
    const next = results[Math.min(calls, results.length - 1)]!;
    calls += 1;
    return { nodeId, durationMs: 1, ...next };
  };
  return { executor, calls: () => calls };
}

async function run(
  retryPolicy: Record<string, unknown>,
  results: Array<Omit<NodeResult, "nodeId" | "durationMs">>,
) {
  const { executor, calls } = scripted(results);
  const runtime = new PipelineRuntime({
    definition: pipeline(retryPolicy),
    nodeExecutor: executor,
  });
  const pending = runtime.execute();
  await vi.runAllTimersAsync();
  const result = await pending;
  return { result, calls: calls() };
}

const rateLimited = {
  output: undefined,
  error: "upstream said no",
  errorMetadata: { code: "RATE_LIMITED" },
};
const terminal = {
  output: undefined,
  error: "RATE_LIMITED appears only in this message",
  errorMetadata: { code: "BAD_INPUT" },
};

describe("isRetryable with retryableErrorCodes", () => {
  const policy: RetryPolicy = { retryableErrorCodes: ["RATE_LIMITED"] };

  it("matches the exact code only", () => {
    expect(isRetryable("anything", policy, "RATE_LIMITED")).toBe(true);
    expect(isRetryable("anything", policy, "RATE_LIMITED_2")).toBe(false);
    expect(isRetryable("RATE_LIMITED", policy, "BAD_INPUT")).toBe(false);
  });

  it("never retries without a code, and an empty list retries nothing", () => {
    expect(isRetryable("RATE_LIMITED", policy)).toBe(false);
    expect(isRetryable("x", { retryableErrorCodes: [] }, "RATE_LIMITED")).toBe(false);
  });

  it("ignores message patterns when codes are set", () => {
    expect(
      isRetryable("timeout", { retryableErrors: ["timeout"], retryableErrorCodes: ["X"] }, "Y"),
    ).toBe(false);
  });

  it("keeps the message-pattern behaviour when codes are absent", () => {
    expect(isRetryable("timeout", { retryableErrors: ["timeout"] }, "Y")).toBe(true);
    expect(isRetryable("whatever", undefined, "Y")).toBe(true);
  });

  it("merges codes node-first", () => {
    expect(
      resolveRetryPolicy({ retryableErrorCodes: ["A"] }, { retryableErrorCodes: ["B"] })
        ?.retryableErrorCodes,
    ).toEqual(["A"]);
    expect(
      resolveRetryPolicy({ jitter: false }, { retryableErrorCodes: ["B"] })?.retryableErrorCodes,
    ).toEqual(["B"]);
  });
});

describe("PipelineRuntime node retry with retryableErrorCodes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a listed code from errorMetadata and then succeeds", async () => {
    const { result, calls } = await run(
      { retryableErrorCodes: ["RATE_LIMITED"], initialBackoffMs: 1 },
      [rateLimited, rateLimited, { output: { ok: true } }],
    );
    expect(result.state).toBe("completed");
    expect(calls).toBe(3);
  });

  it("does not retry an unlisted code even when the message contains a listed code", async () => {
    const { result, calls } = await run(
      { retryableErrorCodes: ["RATE_LIMITED"], initialBackoffMs: 1 },
      [terminal, { output: { ok: true } }],
    );
    expect(result.state).toBe("failed");
    expect(calls).toBe(1);
  });

  it("stops at retries + 1 attempts", async () => {
    const { result, calls } = await run(
      { retryableErrorCodes: ["RATE_LIMITED"], initialBackoffMs: 1 },
      [rateLimited],
    );
    expect(result.state).toBe("failed");
    expect(calls).toBe(4);
  });
});
