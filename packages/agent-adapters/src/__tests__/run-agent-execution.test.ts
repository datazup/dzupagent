import { ForgeError } from "@dzupagent/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  prepareAgentExecutionRunner,
  runAgentExecution,
  runPreparedAgentExecution,
} from "../integration/run-agent-execution.js";
import type {
  AgentExecutionRequest,
  PrepareAgentExecutionRunnerOptions,
} from "../integration/run-agent-execution.js";
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from "../types.js";

const adapterFactories = vi.hoisted(() => ({
  createClaudeBackendAdapter: vi.fn(),
  createCodexBackendAdapter: vi.fn(),
}));

vi.mock("../codex/codex-backend.js", () => ({
  createCodexBackendAdapter: adapterFactories.createCodexBackendAdapter,
}));

vi.mock("../claude/claude-backend.js", () => ({
  createClaudeBackendAdapter: adapterFactories.createClaudeBackendAdapter,
}));

const capabilities: AdapterCapabilityProfile = {
  supportsResume: true,
  supportsFork: false,
  supportsToolCalls: true,
  emitsToolCalls: true,
  executesToolLoop: true,
  supportsStreaming: true,
  supportsCostUsage: true,
};

interface FakeAdapterOptions {
  result?: string | undefined;
  usage?: AgentEvent extends infer _
    ? NonNullable<Extract<AgentEvent, { type: "adapter:completed" }>["usage"]>
    : never;
  fail?: { message: string; code?: string | undefined } | undefined;
  throwError?: unknown;
  onExecute?: ((input: AgentInput) => void) | undefined;
  onResume?: ((sessionId: string, input: AgentInput) => void) | undefined;
}

function createFakeAdapter(
  providerId: AdapterProviderId,
  options: FakeAdapterOptions = {}
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(
      input: AgentInput
    ): AsyncGenerator<AgentEvent, void, undefined> {
      options.onExecute?.(input);
      if (options.throwError) throw options.throwError;

      yield {
        type: "adapter:started",
        providerId,
        sessionId: `session-${providerId}`,
        timestamp: 100,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      };

      if (options.fail) {
        yield {
          type: "adapter:failed",
          providerId,
          error: options.fail.message,
          ...(options.fail.code ? { code: options.fail.code } : {}),
          timestamp: 101,
          ...(input.correlationId
            ? { correlationId: input.correlationId }
            : {}),
        };
        return;
      }

      yield {
        type: "adapter:completed",
        providerId,
        sessionId: `session-${providerId}`,
        result: options.result ?? `result:${providerId}`,
        ...(options.usage ? { usage: options.usage } : {}),
        durationMs: 12,
        timestamp: 112,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      };
    },
    async *resumeSession(
      sessionId: string,
      input: AgentInput
    ): AsyncGenerator<AgentEvent, void, undefined> {
      options.onResume?.(sessionId, input);
      yield {
        type: "adapter:completed",
        providerId,
        sessionId,
        result: options.result ?? `resumed:${providerId}`,
        ...(options.usage ? { usage: options.usage } : {}),
        durationMs: 12,
        timestamp: 112,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      };
    },
    interrupt() {},
    async healthCheck() {
      return {
        healthy: true,
        providerId,
        sdkInstalled: true,
        cliAvailable: true,
      };
    },
    configure() {},
    getCapabilities() {
      return capabilities;
    },
  };
}

function exactRequest(
  request: AgentExecutionRequest
): AgentExecutionRequest & {
  providerId: "codex" | "claude";
  backend: "cli" | "sdk";
  authMode: "subscription_cli" | "api_key";
} {
  const providerId = request.providerId ?? "codex";
  const backend = request.backend ?? "cli";
  const authMode = request.authMode ?? "subscription_cli";
  return {
    ...request,
    providerId,
    backend,
    authMode,
    profileRef:
      authMode === "subscription_cli"
        ? request.profileRef ?? `${providerId}-test-profile`
        : request.profileRef,
  };
}

function prepareFakeRunner(
  request: AgentExecutionRequest,
  adapter: AgentCLIAdapter,
  options: Omit<PrepareAgentExecutionRunnerOptions, "materializeAdapter"> = {}
) {
  return prepareAgentExecutionRunner(request, {
    ...options,
    materializeAdapter: () => adapter,
  });
}

describe("runAgentExecution", () => {
  beforeEach(() => {
    adapterFactories.createCodexBackendAdapter.mockReset();
    adapterFactories.createClaudeBackendAdapter.mockReset();
  });

  it("materializes exactly the explicit Codex backend/auth selection and returns execution truth", async () => {
    const usage = { inputTokens: 10, outputTokens: 20 };
    const materializeAdapter = vi.fn<
      NonNullable<PrepareAgentExecutionRunnerOptions["materializeAdapter"]>
    >(() =>
      createFakeAdapter("codex", {
        result: "codex text",
        usage,
      })
    );

    const request = exactRequest({
        providerId: "codex",
        backend: "cli",
        authMode: "subscription_cli",
        profileRef: "codex-default",
        prompt: "Implement this",
        workingDirectory: "/repo",
        model: "gpt-test",
        reasoning: "medium",
        timeoutMs: 30_000,
        correlationId: "corr-1",
        runId: "run-1",
        packetId: "P001",
        sandboxMode: "workspace-write",
      });
    const result = await runAgentExecution(request, {
      materializeAdapter,
      requiredCapabilities: ["supportsStreaming", "executesToolLoop"],
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_025),
    });

    expect(result).toMatchObject({
      ok: true,
      providerId: "codex",
      model: "gpt-test",
      text: "codex text",
      usage,
      durationMs: 25,
      attemptedProviders: ["codex"],
      runnerAttestation: {
        selection: {
          providerId: "codex",
          backend: "cli",
          authMode: "subscription_cli",
          profileRef: "codex-default",
        },
        capabilityEvidence: {
          required: { supportsStreaming: true, executesToolLoop: true },
          exactMatch: true,
        },
      },
    });
    expect(result.events.map((event) => event.type)).toContain(
      "adapter:completed"
    );
    expect(materializeAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        backend: "cli",
        authMode: "subscription_cli",
        profileRef: "codex-default",
        config: expect.objectContaining({
          model: "gpt-test",
          timeoutMs: 30_000,
          workingDirectory: "/repo",
          sandboxMode: "workspace-write",
          reasoning: "medium",
          providerOptions: {
            runId: "run-1",
            packetId: "P001",
            correlationId: "corr-1",
          },
        } satisfies Partial<AdapterConfig>),
      })
    );
    expect(adapterFactories.createClaudeBackendAdapter).not.toHaveBeenCalled();
    const materializedConfig = materializeAdapter.mock.calls[0]![0].config;
    expect(materializedConfig.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it("uses the provider-native resume path when an exact session is projected", async () => {
    const onExecute = vi.fn();
    const onResume = vi.fn();
    const request = exactRequest({
      providerId: "codex",
      backend: "cli",
      authMode: "subscription_cli",
      profileRef: "codex-default",
      prompt: "continue",
      correlationId: "corr-resume",
    });
    const adapter = createFakeAdapter("codex", {
      result: "resumed result",
      onExecute,
      onResume,
    });
    const prepared = prepareFakeRunner(request, adapter, {
      projectInput(input) {
        return { ...input, resumeSessionId: "provider-session-1" };
      },
    });

    await expect(
      runPreparedAgentExecution(request, prepared)
    ).resolves.toMatchObject({
      ok: true,
      text: "resumed result",
      providerId: "codex",
    });
    expect(onExecute).not.toHaveBeenCalled();
    expect(onResume).toHaveBeenCalledWith(
      "provider-session-1",
      expect.objectContaining({
        prompt: "continue",
        correlationId: "corr-resume",
      })
    );
  });

  it("never ignores a subscription profile when no qualified materializer is injected", async () => {
    expect(() =>
      prepareAgentExecutionRunner({
        providerId: "codex",
        backend: "cli",
        authMode: "subscription_cli",
        profileRef: "codex-default",
        prompt: "test",
      })
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_EXECUTION_SUBSCRIPTION_MATERIALIZER_REQUIRED",
      })
    );
    expect(adapterFactories.createCodexBackendAdapter).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        providerId: "codex" as const,
        authMode: "subscription_cli" as const,
        profileRef: "codex-default",
      },
      "AGENT_EXECUTION_BACKEND_REQUIRED",
    ],
    [
      {
        providerId: "codex" as const,
        backend: "cli" as const,
        profileRef: "codex-default",
      },
      "AGENT_EXECUTION_AUTH_MODE_REQUIRED",
    ],
    [
      {
        providerId: "codex" as const,
        backend: "cli" as const,
        authMode: "subscription_cli" as const,
      },
      "AGENT_EXECUTION_PROFILE_REQUIRED",
    ],
  ])(
    "fails closed when materialization selection is incomplete %#",
    (selection, code) => {
      expect(() =>
        prepareAgentExecutionRunner(
          { ...selection, prompt: "test" },
          { materializeAdapter: () => createFakeAdapter("codex") }
        )
      ).toThrowError(expect.objectContaining({ code }));
    }
  );

  it("requires an injected key only when api_key authentication is selected", async () => {
    expect(() =>
      prepareAgentExecutionRunner(
        {
          providerId: "claude",
          backend: "sdk",
          authMode: "api_key",
          prompt: "test",
        },
        { resolveApiKey: () => "must-not-resolve" }
      )
    ).toThrowError(
      expect.objectContaining({ code: "AGENT_EXECUTION_SECRET_REF_REQUIRED" })
    );
    const request = exactRequest({
      providerId: "claude",
      backend: "sdk",
      authMode: "api_key",
      profileRef: undefined,
      secretRef: "test-claude-api-key",
      prompt: "test",
    });
    expect(() => prepareAgentExecutionRunner(request)).toThrowError(
      expect.objectContaining({ code: "AGENT_EXECUTION_API_KEY_REQUIRED" })
    );

    adapterFactories.createClaudeBackendAdapter.mockReturnValue(
      createFakeAdapter("claude")
    );
    const result = await runAgentExecution(request, {
      resolveApiKey: ({ providerId, secretRef }) => {
        expect(providerId).toBe("claude");
        expect(secretRef).toBe("test-claude-api-key");
        return "injected-only";
      },
    });
    expect(result.ok).toBe(true);
    expect(adapterFactories.createClaudeBackendAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "sdk", apiKey: "injected-only" })
    );
  });

  it("streams normalized events to an injected observer", async () => {
    const observed: AgentEvent[] = [];
    const request = exactRequest({ providerId: "codex", prompt: "observe" });
    const preparedRunner = prepareFakeRunner(
      request,
      createFakeAdapter("codex")
    );
    await runPreparedAgentExecution(request, preparedRunner, {
      onEvent: (event) => {
        observed.push(event);
      },
    });
    expect(observed.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["adapter:started", "adapter:completed"])
    );
  });

  it("binds an exact Claude selection to the attested adapter", async () => {
    const claudeInputs: AgentInput[] = [];
    const request = exactRequest({
      providerId: "claude",
      prompt: "Review this plan",
      timeoutMs: 5_000,
    });
    const preparedRunner = prepareFakeRunner(
      request,
      createFakeAdapter("claude", {
        result: "claude answer",
        onExecute: (input) => claudeInputs.push(input),
      })
    );
    const result = await runPreparedAgentExecution(request, preparedRunner);

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe("claude");
    expect(result.text).toBe("claude answer");
    expect(claudeInputs).toHaveLength(1);
  });

  it("rejects forged runners and arbitrary registry injection", async () => {
    const request = exactRequest({ providerId: "codex", prompt: "test" });
    const result = await runPreparedAgentExecution(
      request,
      {
        attestation: {
          schema: "dzupagent/prepared-agent-execution-runner-attestation/v1",
          selection: {
            providerId: "codex",
            backend: "cli",
            authMode: "subscription_cli",
            profileRef: "codex-test-profile",
          },
          capabilityEvidence: {
            required: {},
            observed: capabilities,
            exactMatch: true,
          },
          provenance: "agent-adapters-module-private-weakmap",
        },
      }
    );
    expect(result).toMatchObject({
      ok: false,
      code: "AGENT_EXECUTION_PREPARED_RUNNER_REQUIRED",
    });
  });

  it("fails preparation when exact required capability evidence is absent", () => {
    const request = exactRequest({ providerId: "codex", prompt: "test" });
    const adapter = createFakeAdapter("codex");
    adapter.getCapabilities = () => ({
      ...capabilities,
      executesToolLoop: false,
    });
    expect(() =>
      prepareFakeRunner(request, adapter, {
        requiredCapabilities: ["supportsStreaming", "executesToolLoop"],
      })
    ).toThrowError(
      expect.objectContaining({ code: "AGENT_EXECUTION_CAPABILITY_REQUIRED" })
    );
  });

  it("returns a structured failure from the exact prepared adapter", async () => {
    const request = exactRequest({
      providerId: "codex",
      prompt: "Fail",
      model: "model-x",
    });
    const preparedRunner = prepareFakeRunner(
      request,
      createFakeAdapter("codex", {
        fail: { message: "codex failed", code: "CODEX_FAILED" },
      })
    );
    const result = await runPreparedAgentExecution(request, preparedRunner);

    expect(result).toMatchObject({
      ok: false,
      providerId: "codex",
      model: "model-x",
      text: "",
      code: "CODEX_FAILED",
      error: {
        code: "CODEX_FAILED",
        message: "codex failed",
        providerId: "codex",
      },
      attemptedProviders: ["codex"],
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("maps optional SDK import failures into structured adapter failure state", async () => {
    const request = exactRequest({
      providerId: "codex",
      prompt: "Needs SDK",
    });
    const preparedRunner = prepareFakeRunner(
      request,
      createFakeAdapter("codex", {
        throwError: new ForgeError({
          code: "ADAPTER_SDK_NOT_INSTALLED",
          message: "@openai/codex-sdk is not installed",
          recoverable: false,
        }),
      })
    );
    const result = await runPreparedAgentExecution(request, preparedRunner);

    expect(result.ok).toBe(false);
    expect(result.text).toBe("");
    expect(result.code).toBe("ADAPTER_EXECUTION_FAILED");
    expect(result.error).toEqual(
      expect.objectContaining({
        code: "ADAPTER_EXECUTION_FAILED",
        message: "@openai/codex-sdk is not installed",
        providerId: "codex",
      })
    );
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "adapter:failed",
          providerId: "codex",
          error: "@openai/codex-sdk is not installed",
        }),
      ])
    );
  });

  it("projects timeout and packet metadata into AgentInput options", async () => {
    let captured: AgentInput | undefined;
    const request = exactRequest({
      providerId: "codex",
      prompt: "Capture input",
      timeoutMs: 1234,
      runId: "run-123",
      packetId: "P001",
      sandboxMode: "read-only",
      reasoning: "low",
      correlationId: "corr-123",
    });
    const preparedRunner = prepareFakeRunner(
      request,
      createFakeAdapter("codex", {
        onExecute: (input) => {
          captured = input;
        },
      }),
      {
        projectInput: (input) => ({
          ...input,
          options: { ...input.options, hostEvidence: "attested" },
        }),
      }
    );
    await runPreparedAgentExecution(request, preparedRunner);

    expect(captured).toMatchObject({
      prompt: "Capture input",
      correlationId: "corr-123",
      options: {
        timeoutMs: 1234,
        runId: "run-123",
        packetId: "P001",
        sandboxMode: "read-only",
        reasoning: "low",
        hostEvidence: "attested",
      },
    });
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });
});
