import { describe, expect, it } from "vitest";
import type { WorkerEvent, WorkerSpec } from "@dzupagent/agent-types/fleet";
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  AgentInputPolicy,
  HealthStatus,
  SessionInfo,
} from "@dzupagent/adapter-types";
import { ProviderAdapterRegistry } from "../../registry/adapter-registry.js";
import { AdapterFleetExecutor } from "../adapter-fleet-executor.js";
import { mapWorkerSpecToAgentExecution } from "../adapter-fleet-mapper.js";

describe("mapWorkerSpecToAgentExecution", () => {
  it("maps WorkerSpec AgentTask payload into adapter input and routing metadata", () => {
    const mapping = mapWorkerSpecToAgentExecution(makeSpec());

    expect(mapping.input.prompt).toContain("Implement adapter-backed fleet execution");
    expect(mapping.input.prompt).toContain("Acceptance criteria:");
    expect(mapping.input.prompt).toContain("- Focused mapper test passes");
    expect(mapping.input.prompt).toContain("Worker ID: worker-1");
    expect(mapping.input.prompt).toContain("Repo: dzupagent");
    expect(mapping.input.prompt).toContain("Task ID: task-1");
    expect(mapping.input.systemPrompt).toBe("Use TDD exactly.");
    expect(mapping.input.workingDirectory).toBe("/workspace/dzupagent");
    expect(mapping.input.maxTurns).toBe(8);
    expect(mapping.input.maxBudgetUsd).toBe(1.25);
    expect(mapping.input.options?.model).toBe("gpt-5-codex");
    expect(mapping.input.correlationId).toBe("corr-123");
    expect(mapping.input.outputSchema).toEqual({ type: "object" });
    expect(mapping.input.policyContext?.activePolicy?.sandboxMode).toBe("workspace-write");

    expect(mapping.task.preferredProvider).toBe("codex");
    expect(mapping.task.workingDirectory).toBe("/workspace/dzupagent");
    expect(mapping.task.requiresExecution).toBe(true);
    expect(mapping.task.requiresReasoning).toBe(true);
    expect(mapping.task.tags).toEqual(
      expect.arrayContaining(["fleet", "dzupagent", "feature"])
    );
  });

  it("ignores invalid config provider before falling back to payload provider", () => {
    const spec = makeSpec();
    spec.config.provider = "not-a-provider";
    spec.taskBundle.payload = {
      ...(spec.taskBundle.payload as Record<string, unknown>),
      provider: "codex",
    };

    const mapping = mapWorkerSpecToAgentExecution(spec);

    expect(mapping.task.preferredProvider).toBe("codex");
  });
});

describe("AdapterFleetExecutor", () => {
  it("executes a WorkerSpec through the registry and exposes worker events", async () => {
    const adapter = new FakeAgentCLIAdapter();
    const registry = new ProviderAdapterRegistry().register(adapter);
    const executor = new AdapterFleetExecutor({ registry });

    const handle = await executor.spawn(makeSpec());
    const events = await collectWorkerEvents(handle.events);
    const outcome = await handle.wait();

    expect(executor.id).toBe("adapter");
    expect(outcome).toEqual({ state: "completed", exitCode: 0 });
    expect(events.map((event) => event.kind)).toEqual([
      "step_start",
      "message",
      "step_done",
      "exit",
    ]);
    expect(adapter.capturedInput?.systemPrompt).toBe("Use TDD exactly.");
  });

  it("cancels by aborting active input and interrupting the active adapter", async () => {
    const adapter = new FakeAgentCLIAdapter({ waitForAbort: true });
    const registry = new ProviderAdapterRegistry().register(adapter);
    const executor = new AdapterFleetExecutor({ registry });

    const handle = await executor.spawn(makeSpec());
    const iterator = handle.events[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.kind).toBe("step_start");

    await handle.cancel("stop requested");
    const outcome = await handle.wait();

    expect(outcome.state).toBe("cancelled");
    expect(adapter.interruptCount).toBe(1);
    expect(adapter.capturedInput?.signal?.aborted).toBe(true);
  });
});

function makeSpec(): WorkerSpec {
  const runtimePolicy: AgentInputPolicy = {
    sandboxMode: "workspace-write",
    networkAccess: false,
  };

  return {
    workerId: "worker-1",
    repo: { name: "dzupagent", path: "/workspace/dzupagent" },
    repoPath: "/workspace/dzupagent",
    taskBundle: {
      id: "task-1",
      description: "Implement adapter-backed fleet execution",
      payload: {
        prompt: "Implement adapter-backed fleet execution",
        systemPrompt: "Use TDD exactly.",
        acceptanceCriteria: ["Focused mapper test passes"],
        correlationId: "corr-123",
        outputSchema: { type: "object" },
        tags: ["feature"],
      },
      dependsOn: [],
    },
    knowledgeHandle: { store: {} as never, scope: "run:run-1", repo: "dzupagent" },
    mailboxAddress: "mailbox:worker-1",
    config: {
      provider: "codex",
      model: "gpt-5-codex",
      maxTurns: 8,
      maxBudgetUsd: 1.25,
      runtimePolicy,
    },
  };
}

async function collectWorkerEvents(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const collected: WorkerEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

class FakeAgentCLIAdapter implements AgentCLIAdapter {
  readonly providerId = "codex";
  capturedInput: AgentInput | undefined;
  interruptCount = 0;

  constructor(private readonly options: { waitForAbort?: boolean } = {}) {}

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    this.capturedInput = input;
    yield {
      type: "adapter:started",
      providerId: this.providerId,
      sessionId: "session-1",
      timestamp: Date.now(),
    };

    if (this.options.waitForAbort) {
      await waitForAbort(input.signal);
      return;
    }

    yield {
      type: "adapter:message",
      providerId: this.providerId,
      content: "adapter response",
      role: "assistant",
      timestamp: Date.now(),
    };
    yield {
      type: "adapter:completed",
      providerId: this.providerId,
      sessionId: "session-1",
      result: "done",
      durationMs: 10,
      timestamp: Date.now(),
    };
  }

  async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {
    throw new Error("resumeSession is not implemented in FakeAgentCLIAdapter");
  }

  interrupt(): void {
    this.interruptCount += 1;
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: true,
      providerId: this.providerId,
      sdkInstalled: true,
      cliAvailable: true,
    };
  }

  configure(_opts: Partial<AdapterConfig>): void {}

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
    };
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [];
  }
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}
