import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ForgeError, type LlmInvocationRecord } from "@dzupagent/core";

import { OpenAIAdapter } from "../openai/openai-adapter.js";
import type {
  AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement,
  AgentEvent,
  AgentInput,
} from "../types.js";
import { collectEvents } from "./test-helpers.js";

const ZERO_TOOL_REQUIREMENT: AdapterExecutionControlRequirement = {
  schema: "dzupagent/adapter-execution-control-requirement/v1",
  tools: { mode: "none" },
};

const ZERO_TOOL_ADMISSION: AdapterExecutionControlAdmission = {
  schema: "dzupagent/adapter-execution-control-admission/v1",
  status: "admitted",
  providerId: "openai",
  requirementSha256:
    "sha256:e367236e0d9802cbfd0f42190c9173d577c12ad4cbdd8b258721900eb78e5731",
  tools: { mode: "none", enforcement: "provider-pre-dispatch" },
  blockers: [],
  effects: {
    credentialReads: 0,
    networkAttempts: 0,
    providerDispatches: 0,
    providerSpendUsd: 0,
  },
};

function zeroToolInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    prompt: "bounded OpenAI prompt",
    executionControlRequirement: ZERO_TOOL_REQUIREMENT,
    policyContext: {
      activePolicy: {
        toolPolicy: "strict",
        allowedTools: [],
        blockedTools: [],
      },
      conformanceMode: "strict",
    },
    options: {
      tools: [{ name: "hostile_tool", parameters: {} }],
      tool_choice: {
        type: "function",
        function: { name: "hostile_tool" },
      },
    },
    ...overrides,
  };
}

function rejectedZeroToolAdmission(
  blocker: string,
): AdapterExecutionControlAdmission {
  return {
    ...ZERO_TOOL_ADMISSION,
    status: "rejected",
    tools: { mode: "none", enforcement: "unsupported" },
    blockers: [blocker],
  };
}

async function captureFailureAndEvents(
  generator: AsyncGenerator<AgentEvent, void, undefined>,
): Promise<{ events: AgentEvent[]; failure: unknown }> {
  const events: AgentEvent[] = [];
  try {
    for await (const event of generator) events.push(event);
    return { events, failure: undefined };
  } catch (failure) {
    return { events, failure };
  }
}

function bodyOf(call: unknown): Record<string, unknown> {
  const [, init] = call as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** SSE byte stream from an array of `data: …` lines (terminator `\n` per line). */
function createSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = lines.join("\n") + "\n";
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function mockFetchResponse(
  body: ReadableStream<Uint8Array>,
  status = 200,
  ok = true
): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    body,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
    headers: new Headers(),
  } as unknown as Response;
}

describe("OpenAIAdapter", () => {
  const originalEnv = process.env["OPENAI_API_KEY"];

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["OPENAI_API_KEY"] = originalEnv;
    } else {
      delete process.env["OPENAI_API_KEY"];
    }
  });

  it("getCapabilities returns correct profile", () => {
    const adapter = new OpenAIAdapter();
    expect(adapter.getCapabilities()).toEqual({
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: false,
      supportsStreaming: true,
      supportsCostUsage: true,
      supportsZeroToolDispatch: true,
      nativeToolControls: {
        mode: true,
        allowlist: true,
        blocklist: true,
      },
    });
  });

  it("emitsToolCalls but does NOT execute an autonomous tool loop (AGENT-H-04)", () => {
    // Fetch-based adapter: surfaces tool_call deltas but stops at the first
    // tool_call with no result. A router must NOT select it for autonomous
    // tool-using work based on supportsToolCalls alone.
    const caps = new OpenAIAdapter().getCapabilities();
    expect(caps.emitsToolCalls).toBe(true);
    expect(caps.executesToolLoop).toBe(false);
  });

  describe("zero-tool admission and direct entrypoints", () => {
    it("admits only the concrete OpenAI provider final empty projection", () => {
      const adapter = new OpenAIAdapter();

      expect(adapter.providerId).toBe("openai");
      expect(adapter.admitExecutionControls?.(
        zeroToolInput(),
        ZERO_TOOL_REQUIREMENT,
      )).toEqual(ZERO_TOOL_ADMISSION);
      expect(adapter.admitExecutionControls?.(
        { prompt: "legacy hostile input", options: zeroToolInput().options },
        ZERO_TOOL_REQUIREMENT,
      )).toEqual(
        rejectedZeroToolAdmission("zero_tool_dispatch_not_enforced"),
      );
    });

    it.each(["chat-completions", "responses"] as const)(
      "supports non-streaming %s with the same exact zero-tool AgentInput",
      async (transport) => {
        const fetchImpl = vi.fn().mockResolvedValue(
          transport === "responses"
            ? new Response(JSON.stringify({
                output: [{
                  type: "message",
                  content: [{ type: "output_text", text: "ok" }],
                }],
              }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              })
            : {
                ok: true,
                status: 200,
                statusText: "OK",
                json: () => Promise.resolve({
                  choices: [{ message: { content: "ok" } }],
                }),
                text: () => Promise.resolve(""),
                body: null,
                headers: new Headers(),
              } as Response,
        );
        const adapter = new OpenAIAdapter({
          apiKey: "fixture-key",
          transport,
          fetchImpl: fetchImpl as typeof fetch,
        });

        await expect(adapter.run(zeroToolInput())).resolves.toEqual({
          content: "ok",
        });

        const body = bodyOf(fetchImpl.mock.calls[0]);
        const messages = transport === "responses"
          ? body["input"]
          : body["messages"];
        expect(messages).toEqual([
          { role: "user", content: "bounded OpenAI prompt" },
        ]);
        expect("tools" in body).toBe(false);
        expect("tool_choice" in body).toBe(false);
      },
    );

    it("reuses the exact public-admission projection without rereading hostile options", async () => {
      const reads = { toolChoice: 0, tools: 0 };
      const options: Record<string, unknown> = {};
      Object.defineProperties(options, {
        tools: {
          enumerable: true,
          get() {
            reads.tools += 1;
            return [{ name: `hostile_${reads.tools}`, parameters: {} }];
          },
        },
        tool_choice: {
          enumerable: true,
          get() {
            reads.toolChoice += 1;
            return { type: "function", function: { name: "hostile" } };
          },
        },
      });
      const input = zeroToolInput({ options });
      const fetchImpl = vi.fn().mockResolvedValue(mockFetchResponse(
        createSSEStream([
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          "data: [DONE]",
        ]),
      ));
      const adapter = new OpenAIAdapter({
        apiKey: "fixture-key",
        fetchImpl: fetchImpl as typeof fetch,
      });

      expect(adapter.admitExecutionControls?.(
        input,
        ZERO_TOOL_REQUIREMENT,
      )).toEqual(ZERO_TOOL_ADMISSION);
      await collectEvents(adapter.execute(input));

      expect(reads).toEqual({ toolChoice: 1, tools: 1 });
      const body = bodyOf(fetchImpl.mock.calls[0]);
      expect("tools" in body).toBe(false);
      expect("tool_choice" in body).toBe(false);
    });

    it("self-admits a legitimate direct execute exactly once", async () => {
      const reads = { toolChoice: 0, tools: 0 };
      const options: Record<string, unknown> = {};
      Object.defineProperties(options, {
        tools: {
          enumerable: true,
          get() {
            reads.tools += 1;
            return [{ name: "hostile_tool", parameters: {} }];
          },
        },
        tool_choice: {
          enumerable: true,
          get() {
            reads.toolChoice += 1;
            return "required";
          },
        },
      });
      const fetchImpl = vi.fn().mockResolvedValue(mockFetchResponse(
        createSSEStream(["data: [DONE]"]),
      ));
      const adapter = new OpenAIAdapter({
        apiKey: "fixture-key",
        fetchImpl: fetchImpl as typeof fetch,
      });

      await collectEvents(adapter.execute(zeroToolInput({ options })));

      expect(reads).toEqual({ toolChoice: 1, tools: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        name: "malformed requirement",
        input: () => zeroToolInput({
          executionControlRequirement: {
            schema: "dzupagent/adapter-execution-control-requirement/v1",
            tools: { mode: "all" },
          } as unknown as AdapterExecutionControlRequirement,
        }),
        blocker: "execution_control_requirement_invalid",
      },
      {
        name: "conflicting strict policy",
        input: () => zeroToolInput({
          policyContext: {
            activePolicy: {
              toolPolicy: "strict",
              allowedTools: ["hostile_tool"],
              blockedTools: [],
            },
            conformanceMode: "strict",
          },
        }),
        blocker: "execution_control_policy_inconsistent",
      },
    ])(
      "rejects $name before credential reads, start events, or fetch",
      async ({ input, blocker }) => {
        let credentialReads = 0;
        const config = { fetchImpl: vi.fn() as typeof fetch };
        Object.defineProperty(config, "apiKey", {
          enumerable: true,
          get() {
            credentialReads += 1;
            return "must-not-be-read";
          },
        });
        const adapter = new OpenAIAdapter(config);

        const result = await captureFailureAndEvents(adapter.execute(input()));

        expect({
          credentialReads,
          events: result.events,
          fetchCalls: vi.mocked(config.fetchImpl).mock.calls.length,
        }).toEqual({ credentialReads: 0, events: [], fetchCalls: 0 });
        expect(result.failure).toMatchObject({
          code: "CAPABILITY_DENIED",
          recoverable: false,
          context: { admission: rejectedZeroToolAdmission(blocker) },
        });
      },
    );

    it("rejects an accessor requirement without invoking it or reading credentials", async () => {
      let credentialReads = 0;
      let requirementReads = 0;
      const config = { fetchImpl: vi.fn() as typeof fetch };
      Object.defineProperty(config, "apiKey", {
        enumerable: true,
        get() {
          credentialReads += 1;
          return "must-not-be-read";
        },
      });
      const input = zeroToolInput();
      Object.defineProperty(input, "executionControlRequirement", {
        configurable: true,
        enumerable: true,
        get() {
          requirementReads += 1;
          throw new Error("requirement getter must not run");
        },
      });
      const adapter = new OpenAIAdapter(config);

      const result = await captureFailureAndEvents(adapter.execute(input));

      expect({
        credentialReads,
        events: result.events,
        fetchCalls: vi.mocked(config.fetchImpl).mock.calls.length,
        requirementReads,
      }).toEqual({
        credentialReads: 0,
        events: [],
        fetchCalls: 0,
        requirementReads: 0,
      });
      expect(result.failure).toMatchObject({
        code: "CAPABILITY_DENIED",
        recoverable: false,
        context: {
          admission: rejectedZeroToolAdmission(
            "execution_control_requirement_invalid",
          ),
        },
      });
    });

    it("rejects a stale public snapshot without rebuilding or dispatching", async () => {
      const input = zeroToolInput();
      let credentialReads = 0;
      const config = { fetchImpl: vi.fn() as typeof fetch };
      Object.defineProperty(config, "apiKey", {
        enumerable: true,
        get() {
          credentialReads += 1;
          return "must-not-be-read";
        },
      });
      const adapter = new OpenAIAdapter(config);
      adapter.admitExecutionControls?.(input, ZERO_TOOL_REQUIREMENT);
      input.policyContext!.activePolicy.allowedTools = ["hostile_tool"];

      const result = await captureFailureAndEvents(adapter.execute(input));

      expect({
        credentialReads,
        events: result.events,
        fetchCalls: vi.mocked(config.fetchImpl).mock.calls.length,
      }).toEqual({ credentialReads: 0, events: [], fetchCalls: 0 });
      expect(result.failure).toMatchObject({
        code: "CAPABILITY_DENIED",
        recoverable: false,
      });
    });

    it("fails closed instead of replaying one admission for another request", async () => {
      class ReplayAdmissionAdapter extends OpenAIAdapter {
        private cachedAdmission: AdapterExecutionControlAdmission | undefined;

        override admitExecutionControls(
          input: AgentInput,
          requirement: AdapterExecutionControlRequirement,
        ): AdapterExecutionControlAdmission {
          this.cachedAdmission ??= super.admitExecutionControls(
            input,
            requirement,
          );
          return this.cachedAdmission;
        }
      }

      const fetchImpl = vi.fn().mockResolvedValue(mockFetchResponse(
        createSSEStream(["data: [DONE]"]),
      ));
      const adapter = new ReplayAdmissionAdapter({
        apiKey: "fixture-key",
        fetchImpl: fetchImpl as typeof fetch,
      });
      await collectEvents(adapter.execute(zeroToolInput({ prompt: "first" })));

      const result = await captureFailureAndEvents(
        adapter.execute(zeroToolInput({ prompt: "second" })),
      );

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.events).toEqual([]);
      expect(result.failure).toMatchObject({
        code: "CAPABILITY_DENIED",
        recoverable: false,
        context: {
          executionControlBlocker:
            "execution_control_request_snapshot_missing",
        },
      });
    });
  });

  it("throws when no API key is configured", async () => {
    const adapter = new OpenAIAdapter();
    await expect(
      adapter.execute({ prompt: "hello" }).next()
    ).rejects.toMatchObject({
      code: "ADAPTER_EXECUTION_FAILED",
    });
  });

  it("execute yields started -> stream_delta -> completed for a mock SSE response", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":12,"completion_tokens":4}}',
      "data: [DONE]",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    );

    const adapter = new OpenAIAdapter({ apiKey: "test-key" });
    const events = await collectEvents(adapter.execute({ prompt: "Hi" }));

    expect(events.map((e) => e.type)).toEqual([
      "adapter:started",
      "adapter:stream_delta",
      "adapter:stream_delta",
      "adapter:completed",
    ]);

    const started = events[0];
    if (started?.type === "adapter:started") {
      expect(started.prompt).toBe("Hi");
      expect(started.isResume).toBe(false);
      expect(started.model).toBe("gpt-4o-mini");
    }

    const completed = events[3];
    if (completed?.type === "adapter:completed") {
      expect(completed.result).toBe("Hello world");
      expect(completed.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
      expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("emits adapter:completed without usage when stream omits usage chunk", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"x"}}]}',
      "data: [DONE]",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    );

    const adapter = new OpenAIAdapter({ apiKey: "k" });
    const events = await collectEvents(adapter.execute({ prompt: "p" }));

    const completed = events.find((e) => e.type === "adapter:completed");
    expect(completed).toBeDefined();
    if (completed?.type === "adapter:completed") {
      expect(completed.result).toBe("x");
      expect(completed.usage).toBeUndefined();
    }
  });

  it("reads API key from OPENAI_API_KEY env var when config absent", async () => {
    process.env["OPENAI_API_KEY"] = "env-key";
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"k"}}]}',
      "data: [DONE]",
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAIAdapter();
    await collectEvents(adapter.execute({ prompt: "hi" }));

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer env-key");
  });

  it("uses model from input options over config default", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"x"}}]}',
      "data: [DONE]",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    );

    const adapter = new OpenAIAdapter({ apiKey: "k", model: "gpt-4o" });
    const events = await collectEvents(
      adapter.execute({ prompt: "hi", options: { model: "gpt-4o-mini" } })
    );

    const started = events[0];
    if (started?.type === "adapter:started") {
      expect(started.model).toBe("gpt-4o-mini");
    }
  });

  it("includes system prompt in messages when provided", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"y"}}]}',
      "data: [DONE]",
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAIAdapter({ apiKey: "k" });
    await collectEvents(
      adapter.execute({ prompt: "hi", systemPrompt: "You are helpful." })
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string
    ) as {
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      stream_options?: unknown;
    };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("honours custom baseURL for OpenAI-compatible endpoints", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"k"}}]}',
      "data: [DONE]",
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAIAdapter({
      apiKey: "k",
      baseURL: "https://my-proxy.example.com/v1",
    });
    await collectEvents(adapter.execute({ prompt: "p" }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://my-proxy.example.com/v1/chat/completions");
  });

  it("allows operator-configured local OpenAI-compatible endpoints", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"k"}}]}',
      "data: [DONE]",
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)));

    const adapter = new OpenAIAdapter({
      apiKey: "k",
      baseURL: "http://127.0.0.1:11434/v1",
      fetchImpl: fetchMock as typeof fetch,
    });
    await collectEvents(adapter.execute({ prompt: "p" }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("yields adapter:failed for non-200 responses with a normalized error code (body not leaked)", async () => {
    const errorBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ...mockFetchResponse(errorBody, 429, false),
        text: () => Promise.resolve("Rate limit exceeded"),
      })
    );

    const adapter = new OpenAIAdapter({ apiKey: "k" });
    const events = await collectEvents(adapter.execute({ prompt: "test" }));

    expect(events.map((e) => e.type)).toEqual([
      "adapter:started",
      "adapter:failed",
    ]);
    const failed = events[1];
    if (failed?.type === "adapter:failed") {
      expect(failed.error).toContain("429");
      // Raw upstream body must NOT leak into the surfaced error message.
      expect(failed.error).not.toContain("Rate limit exceeded");
      expect(failed.code).toBe("PROVIDER_RATE_LIMITED");
    }
  });

  it("yields adapter:failed when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error"))
    );

    const adapter = new OpenAIAdapter({ apiKey: "k" });
    const events = await collectEvents(adapter.execute({ prompt: "test" }));

    expect(events.map((e) => e.type)).toEqual([
      "adapter:started",
      "adapter:failed",
    ]);
    const failed = events[1];
    if (failed?.type === "adapter:failed") {
      expect(failed.error).toBe("Network error");
    }
  });

  it("interrupt aborts the in-flight request", async () => {
    let capturedSignal: AbortSignal | undefined;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        capturedSignal = opts.signal ?? undefined;
        markFetchStarted();
        return new Promise((_resolve, reject) => {
          if (opts.signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
          }
          opts.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      })
    );

    const adapter = new OpenAIAdapter({ apiKey: "k" });
    const gen = adapter.execute({ prompt: "test" });
    const started = await gen.next();
    const restEventsPromise = collectEvents(gen);

    await fetchStarted;
    adapter.interrupt();

    const events = [
      ...(started.value ? [started.value] : []),
      ...(await restEventsPromise),
    ];

    expect(capturedSignal?.aborted).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      "adapter:started",
      "adapter:failed",
    ]);
    const failed = events[1];
    if (failed?.type === "adapter:failed") {
      expect(failed.code).toBe("AGENT_ABORTED");
    }
  });

  it("resumeSession throws ForgeError (capability declares supportsResume=false)", async () => {
    const adapter = new OpenAIAdapter({ apiKey: "k" });
    await expect(
      adapter.resumeSession("sess-1", { prompt: "hi" }).next()
    ).rejects.toBeInstanceOf(ForgeError);
  });

  it("healthCheck returns healthy when API key configured", async () => {
    const adapter = new OpenAIAdapter({ apiKey: "k" });
    const status = await adapter.healthCheck();
    expect(status.healthy).toBe(true);
    expect(status.lastError).toBeUndefined();
  });

  it("healthCheck returns unhealthy when no API key", async () => {
    const adapter = new OpenAIAdapter();
    const status = await adapter.healthCheck();
    expect(status.healthy).toBe(false);
    expect(status.lastError).toBe("No API key configured");
  });

  it("configure merges new options into existing config", async () => {
    const adapter = new OpenAIAdapter({ apiKey: "old", model: "gpt-4o" });
    adapter.configure({ apiKey: "new", baseURL: "https://x.example.com/v1" });

    const sseLines = [
      'data: {"choices":[{"delta":{"content":"z"}}]}',
      "data: [DONE]",
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)));
    vi.stubGlobal("fetch", fetchMock);

    await collectEvents(adapter.execute({ prompt: "p" }));

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x.example.com/v1/chat/completions");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer new");
  });

  it("run() non-streaming method returns content + usage from JSON response", async () => {
    const auditSink = vi.fn<(record: LlmInvocationRecord) => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "Hello back" } }],
            usage: { prompt_tokens: 8, completion_tokens: 3 },
          }),
        text: () => Promise.resolve(""),
        body: null,
        headers: new Headers(),
      })
    );

    const adapter = new OpenAIAdapter({
      apiKey: "k",
      auditSink,
      auditRunId: "run-1",
      auditTenantId: "tenant-1",
    });
    const result = await adapter.run("Hello", { systemPrompt: "be brief" });

    expect(result.content).toBe("Hello back");
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 3 });
    expect(auditSink).toHaveBeenCalledTimes(1);
    expect(auditSink.mock.calls[0]![0]).toMatchObject({
      providerId: "openai",
      model: "gpt-4o-mini",
      runId: "run-1",
      tenantId: "tenant-1",
      promptCharCount: "Hello".length,
      systemPromptCharCount: "be brief".length,
      status: "completed",
      usage: {
        promptTokens: 8,
        completionTokens: 3,
        totalTokens: 11,
      },
    });
  });

  it("run() omits usage when JSON response has no usage block", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          Promise.resolve({ choices: [{ message: { content: "ok" } }] }),
        text: () => Promise.resolve(""),
        body: null,
        headers: new Headers(),
      })
    );

    const adapter = new OpenAIAdapter({ apiKey: "k" });
    const result = await adapter.run("Hello");
    expect(result.content).toBe("ok");
    expect(result.usage).toBeUndefined();
  });

  it("run() emits failed audit records and preserves thrown errors", async () => {
    const auditSink = vi.fn<(record: LlmInvocationRecord) => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );

    const adapter = new OpenAIAdapter({
      apiKey: "k",
      auditSink,
      model: "gpt-4o",
    });
    await expect(adapter.run("Hello")).rejects.toThrow("network down");

    expect(auditSink).toHaveBeenCalledTimes(1);
    expect(auditSink.mock.calls[0]![0]).toMatchObject({
      providerId: "openai",
      model: "gpt-4o",
      promptCharCount: "Hello".length,
      status: "failed",
      errorCode: "ADAPTER_EXECUTION_FAILED",
    });
  });

  it("run() swallows audit sink errors so audit failures do not break calls", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auditSink = vi.fn<(record: LlmInvocationRecord) => void>(() => {
      throw new Error("sink down");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          Promise.resolve({ choices: [{ message: { content: "ok" } }] }),
        text: () => Promise.resolve(""),
        body: null,
        headers: new Headers(),
      })
    );

    const adapter = new OpenAIAdapter({ apiKey: "k", auditSink });
    const result = await adapter.run("Hello");

    expect(result.content).toBe("ok");
    expect(auditSink).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[OpenAIAdapter] audit sink failed:",
      "sink down"
    );
  });
});
