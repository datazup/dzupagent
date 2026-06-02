import { describe, it, expect, vi } from "vitest";
import type { AgentInput } from "@dzupagent/adapter-types";
import { RegistrySubagentExecutor } from "../registry-subagent-executor.js";
import type { ProviderAdapterRegistry } from "../../registry/adapter-registry.js";

/** Minimal adapter that yields a scripted event stream. */
function fakeAdapter(
  events: Array<Record<string, unknown>>,
  capture?: (input: AgentInput) => void,
) {
  return {
    providerId: "claude",
    async *execute(input: AgentInput) {
      capture?.(input);
      for (const e of events) {
        yield e as never;
      }
    },
  };
}

/** A registry stub exposing only what the executor uses. */
function fakeRegistry(adapter: unknown): {
  registry: ProviderAdapterRegistry;
  recordSuccess: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
} {
  const recordSuccess = vi.fn();
  const recordFailure = vi.fn();
  const registry = {
    getHealthy: () => adapter,
    get: () => adapter,
    recordSuccess,
    recordFailure,
  } as unknown as ProviderAdapterRegistry;
  return { registry, recordSuccess, recordFailure };
}

const ctx = () => ({ taskId: "t1", signal: new AbortController().signal });

describe("RegistrySubagentExecutor", () => {
  it("maps a completed stream to a SubagentResult and records success", async () => {
    const adapter = fakeAdapter([
      { type: "adapter:message", content: "working" },
      {
        type: "adapter:completed",
        result: "final answer",
        usage: { inputTokens: 3, outputTokens: 10 },
      },
    ]);
    const { registry, recordSuccess } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);

    const result = await exec.run({ agentId: "claude", input: "do it" }, ctx());
    expect(result).toEqual({
      output: "final answer",
      usage: { inputTokens: 3, outputTokens: 10 },
    });
    expect(recordSuccess).toHaveBeenCalledWith("claude");
  });

  it("forwards progress events to onProgress", async () => {
    const adapter = fakeAdapter([
      { type: "adapter:progress", message: "step 1" },
      { type: "adapter:completed", result: "done" },
    ]);
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);
    const notes: string[] = [];

    await exec.run(
      { agentId: "claude", input: "x" },
      {
        taskId: "t1",
        signal: new AbortController().signal,
        onProgress: (n) => notes.push(n),
      },
    );
    expect(notes).toContain("step 1");
  });

  it("throws and records failure when the stream fails with no result", async () => {
    const adapter = fakeAdapter([
      { type: "adapter:failed", error: "provider exploded" },
    ]);
    const { registry, recordFailure } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);

    await expect(
      exec.run({ agentId: "claude", input: "x" }, ctx()),
    ).rejects.toThrow("provider exploded");
    expect(recordFailure).toHaveBeenCalled();
  });

  it("passes the abort signal into AgentInput", async () => {
    let seen: AgentInput | undefined;
    const adapter = fakeAdapter(
      [{ type: "adapter:completed", result: "ok" }],
      (input) => {
        seen = input;
      },
    );
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);
    const signal = new AbortController().signal;

    await exec.run({ agentId: "claude", input: "x" }, { taskId: "t1", signal });
    expect(seen?.signal).toBe(signal);
  });

  it("serialises object input to a JSON prompt", async () => {
    let seen: AgentInput | undefined;
    const adapter = fakeAdapter(
      [{ type: "adapter:completed", result: "ok" }],
      (input) => {
        seen = input;
      },
    );
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);

    await exec.run({ agentId: "claude", input: { task: "survey" } }, ctx());
    expect(seen?.prompt).toBe(JSON.stringify({ task: "survey" }));
  });

  it("throws when the provider is not registered", async () => {
    const registry = {
      getHealthy: () => undefined,
      get: () => undefined,
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    } as unknown as ProviderAdapterRegistry;
    const exec = new RegistrySubagentExecutor(registry);
    await expect(
      exec.run({ agentId: "ghost", input: "x" }, ctx()),
    ).rejects.toThrow(/not registered/);
  });
});
