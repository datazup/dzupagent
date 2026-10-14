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
import type { AdapterPipeline } from "../pipeline/adapter-pipeline.js";
import { GuardrailsPipelineStep } from "../pipeline/guardrails-pipeline-step.js";
import { AdapterGuardrails } from "../guardrails/adapter-guardrails.js";
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
          ...(options.usage ? { usage: options.usage } : {}),
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
  it("a fresh final guard refusal after prepared-input reservation never invokes the adapter", async () => {
    let reserved = false;
    const invoked = vi.fn();
    const result = await runAgentExecution(exactRequest({ prompt: "inert", resumeSessionId: "native-session", approvedFallbackProviders: [] }), {
      materializeAdapter: () => createFakeAdapter("codex", { onResume: invoked }),
      assertPreparedInput: () => { reserved = true; },
      async *guardAdapterStart() {
        expect(reserved).toBe(true);
        throw new ForgeError({ code: "POLICY_DENIED", message: "fresh final guard refused", recoverable: false });
      },
    });
    expect(result.ok).toBe(false); expect(invoked).not.toHaveBeenCalled();
  });
  it("lets real guardrails install cancellation before freezing the prepared payload", async () => {
    const guardrails = new GuardrailsPipelineStep(undefined, new AdapterGuardrails({ maxIterations: 5 }));
    let finalSignal: AbortSignal | undefined;
    const pipeline = {
      approval: { wrap: (stream: AsyncGenerator<AgentEvent>) => stream },
      async prepare() {},
      wrapStream: (stream: AsyncGenerator<AgentEvent>, input: AgentInput) => guardrails.wrap(stream, input),
    } as unknown as AdapterPipeline;
    const result = await runAgentExecution(exactRequest({ prompt: "inert", resumeSessionId: "native-session", approvedFallbackProviders: [] }), {
      pipeline,
      async *guardAdapterStart(invoke, input) {
        expect(input?.prompt).toBe("inert"); expect(input?.resumeSessionId).toBe("native-session");
        Object.freeze(input?.options); Object.freeze(input);
        yield* invoke();
      },
      materializeAdapter: () => createFakeAdapter("codex", { onResume: (_id, input) => {
        // The registry creates an attempt object with a chained signal. Payload
        // identity, rather than object/signal identity, is the preserved boundary.
        expect(input.prompt).toBe("inert"); expect(input.resumeSessionId).toBe("native-session");
        expect(input.signal).toBeDefined(); expect(input.signal?.aborted).toBe(finalSignal?.aborted);
        expect(Object.isFrozen(input)).toBe(true);
      } }),
      assertPreparedInput: input => { finalSignal = input.signal; Object.freeze(input.options); Object.freeze(input); },
    });
    expect(finalSignal).toBeDefined(); expect(result.ok).toBe(true);
  });

  it("propagates real guardrail cancellation through the registry attempt signal", async () => {
    const controller = new AbortController();
    const guardrails = new GuardrailsPipelineStep(undefined, new AdapterGuardrails({ maxIterations: 5 }));
    const pipeline = { approval: { wrap: (stream: AsyncGenerator<AgentEvent>) => stream },
      async prepare() {}, wrapStream: (stream: AsyncGenerator<AgentEvent>, input: AgentInput) => guardrails.wrap(stream, input),
    } as unknown as AdapterPipeline;
    let propagated = false;
    await runAgentExecution(exactRequest({ prompt: "inert", signal: controller.signal,
      resumeSessionId: "native-session", approvedFallbackProviders: [] }), {
      pipeline, materializeAdapter: () => createFakeAdapter("codex", { onResume: (_id, input) => {
        controller.abort(); propagated = input.signal?.aborted === true;
      } }), assertPreparedInput: input => { Object.freeze(input.options); Object.freeze(input); },
    });
    expect(propagated).toBe(true);
  });
  it("waits for listeners and generator cleanup and preserves a late failure", async () => {
    const request = exactRequest({ prompt: "inert", resumeSessionId: "native-session", approvedFallbackProviders: [] });
    const adapter = createFakeAdapter("codex");
    let finalized = false, listened = false;
    adapter.resumeSession = async function* () {
      try {
        yield { type: "adapter:completed", providerId: "codex", sessionId: "native-session", result: "provisional", timestamp: 1, durationMs: 1 };
      } finally {
        await Promise.resolve(); finalized = true;
        throw new Error("late finalizer failure");
      }
    };
    const result = await runPreparedAgentExecution(request, prepareFakeRunner(request, adapter), {
      onEvent: async () => { await Promise.resolve(); listened = true; },
    });
    expect(finalized).toBe(true); expect(listened).toBe(true); expect(result.ok).toBe(false);
  });

  it("gates construction lazily, enriches once and retains the same pipeline", async () => {
    const order: string[] = [];
    const pipeline = {
      approval: { async *wrap(stream: AsyncGenerator<AgentEvent>, args: { requireApproval: boolean }) {
        if (args.requireApproval) { order.push("approval"); await Promise.resolve(); }
        yield* stream;
      } },
      async prepare({ input }: { input: AgentInput }) { order.push("ucl"); input.systemPrompt = "materialized standing context"; return input; },
      wrapStream(stream: AsyncGenerator<AgentEvent>, input: AgentInput) {
        order.push("controls"); input.signal = new AbortController().signal; return stream;
      },
    } as unknown as AdapterPipeline;
    const result = await runAgentExecution(exactRequest({ prompt: "inert", resumeSessionId: "native-session", approvedFallbackProviders: [] }), {
      pipeline, beforePrepare: () => { order.push("prepare"); },
      materializeAdapter: () => { order.push("materialize"); return createFakeAdapter("codex", {
        onResume: (_id, input) => { order.push("resume"); expect(input.systemPrompt).toBe("materialized standing context"); },
      }); },
      assertPreparedInput: input => { order.push("capacity"); expect(input.systemPrompt).toBe("materialized standing context"); },
    });
    expect(result.ok).toBe(true);
    expect(order).toEqual(["approval", "prepare", "materialize", "ucl", "controls", "capacity", "resume"]);
  });

  it("denied approval performs no adapter preparation or construction", async () => {
    const beforePrepare = vi.fn(), materializeAdapter = vi.fn(() => createFakeAdapter("codex"));
    const pipeline = { approval: { async *wrap() { throw new Error("approval denied"); } } } as unknown as AdapterPipeline;
    const result = await runAgentExecution(exactRequest({ prompt: "inert" }), { pipeline, beforePrepare, materializeAdapter });
    expect(result.ok).toBe(false); expect(beforePrepare).not.toHaveBeenCalled(); expect(materializeAdapter).not.toHaveBeenCalled();
  });
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

  it("projects the requested native session through the real registry without ordinary execute", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const onExecute = vi.fn();
    const onResume = vi.fn();
    const controller = new AbortController();
    const request = exactRequest({
      prompt: "continue exactly", resumeSessionId: sessionId,
      approvedFallbackProviders: [], workingDirectory: "/owned/repo",
      model: "fixed-model", reasoning: "high", timeoutMs: 1000,
      outputSchema: { type: "object" }, signal: controller.signal,
    });
    const prepared = prepareFakeRunner(request, createFakeAdapter("codex", {
      onExecute, onResume, usage: { inputTokens: 7, outputTokens: 3 },
    }));
    const result = await runPreparedAgentExecution(request, prepared);
    expect(result).toMatchObject({ ok: true, usage: { inputTokens: 7, outputTokens: 3 } });
    expect(result.events).toContainEqual(expect.objectContaining({ type: "adapter:completed", sessionId }));
    expect(onExecute).not.toHaveBeenCalled();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      resumeSessionId: sessionId, workingDirectory: request.workingDirectory,
      outputSchema: request.outputSchema, signal: expect.any(AbortSignal),
      options: expect.objectContaining({ model: "fixed-model", reasoning: "high", timeoutMs: 1000 }),
    }));
    expect(prepared.attestation.capabilityEvidence.required.supportsResume).toBe(true);
  });

  it.each(["", " spaced ", "bad\nidentity", null])("refuses invalid resume identity %j before materialization", (resumeSessionId) => {
    const materializeAdapter = vi.fn(() => createFakeAdapter("codex"));
    expect(() => prepareAgentExecutionRunner(exactRequest({
      prompt: "continue", resumeSessionId: resumeSessionId as unknown as string,
    }), { materializeAdapter })).toThrow("Resume requires an exact native session and no fallback");
    expect(materializeAdapter).not.toHaveBeenCalled();
  });

  it("refuses fallback and an unsupported or missing resume implementation", () => {
    const request = exactRequest({ prompt: "continue", resumeSessionId: "native-session" });
    const materializeAdapter = vi.fn(() => createFakeAdapter("codex"));
    expect(() => prepareAgentExecutionRunner({ ...request, approvedFallbackProviders: ["claude"] }, {
      materializeAdapter,
    })).toThrow("Resume requires an exact native session and no fallback");
    expect(materializeAdapter).not.toHaveBeenCalled();
    const unsupported = createFakeAdapter("codex");
    unsupported.getCapabilities = () => ({ ...capabilities, supportsResume: false });
    expect(() => prepareFakeRunner(request, unsupported)).toThrow("supportsResume");
    const missing = createFakeAdapter("codex");
    Reflect.deleteProperty(missing, "resumeSession");
    expect(() => prepareFakeRunner(request, missing)).toThrow("Resume method is required");
  });

  it.each([undefined, "foreign-session"])("refuses projection erasure/replacement %j without invocation", async (projectedId) => {
    const onExecute = vi.fn(), onResume = vi.fn();
    const request = exactRequest({ prompt: "continue", resumeSessionId: "native-session" });
    const prepared = prepareFakeRunner(request, createFakeAdapter("codex", { onExecute, onResume }), {
      projectInput: input => ({ ...input, resumeSessionId: projectedId }),
    });
    await expect(runPreparedAgentExecution(request, prepared)).resolves.toMatchObject({
      ok: false, code: "AGENT_EXECUTION_RESUME_MISMATCH",
    });
    expect(onExecute).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("pins preparation identity across changed requests and a late host start guard", async () => {
    const onExecute = vi.fn(), onResume = vi.fn();
    const request = exactRequest({ prompt: "continue", resumeSessionId: "native-session" });
    let projectedInput: AgentInput | undefined;
    const prepared = prepareFakeRunner(request, createFakeAdapter("codex", { onExecute, onResume }), {
      projectInput(input) { projectedInput = input; return input; },
      async *guardAdapterStart(invoke) {
        if (projectedInput) projectedInput.resumeSessionId = "foreign-session";
        yield* invoke();
      },
    });
    await expect(runPreparedAgentExecution({ ...request, resumeSessionId: "foreign-session" }, prepared)).resolves.toMatchObject({
      ok: false, code: "AGENT_EXECUTION_RESUME_MISMATCH",
    });
    const late = await runPreparedAgentExecution(request, prepared);
    expect(late.ok).toBe(false);
    expect(onExecute).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("keeps a pinned native session when one projection object serves repeated runs", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const onResume = vi.fn();
    const request = exactRequest({ prompt: "continue", resumeSessionId: sessionId, approvedFallbackProviders: [] });
    let shared: AgentInput | undefined;
    const prepared = prepareFakeRunner(request, createFakeAdapter("codex", { onResume }), {
      projectInput(input) { shared ??= input; return shared; },
    });
    await expect(runPreparedAgentExecution(request, prepared)).resolves.toMatchObject({ ok: true });
    await expect(runPreparedAgentExecution(request, prepared)).resolves.toMatchObject({ ok: true });
    expect(onResume).toHaveBeenCalledTimes(2);
    expect(() => { shared!.resumeSessionId = "foreign-session"; }).toThrow("Host start guard changed the prepared native session");
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
    expect(result).not.toHaveProperty("usage");
  });

  // DZA-GAP3-02-20261003-R1: cover both failure returns without provider calls.
  it.each([true, false])(
    "preserves failed usage when event projection terminates the stream: %s",
    async (terminal) => {
      const usage = {
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 3,
        cacheWriteTokens: 2,
        costCents: 9,
      };
      const request = exactRequest({ providerId: "claude", prompt: "Fail" });
      const preparedRunner = prepareFakeRunner(
        request,
        createFakeAdapter("claude", {
          fail: { message: "claude failed", code: "CLAUDE_FAILED" },
          usage,
        }),
        {
          projectEvent: (event) => ({
            events: [event],
            terminal: terminal && event.type === "adapter:failed",
          }),
        }
      );
      const result = await runPreparedAgentExecution(request, preparedRunner);

      expect(result).toMatchObject({
        ok: false,
        providerId: "claude",
        text: "",
        code: "CLAUDE_FAILED",
        error: {
          code: "CLAUDE_FAILED",
          message: "claude failed",
          providerId: "claude",
        },
        attemptedProviders: ["claude"],
      });
      const failure = result.events.find((event) => event.type === "adapter:failed");
      expect(failure).toMatchObject({ usage });
      expect(result.usage).toBe(usage);
      expect(result.events.some((event) => event.type === "adapter:completed")).toBe(false);
    }
  );

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
