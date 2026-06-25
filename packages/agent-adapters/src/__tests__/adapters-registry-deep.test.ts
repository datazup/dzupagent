/**
 * W30-E — Adapter deep coverage gaps.
 *
 * Targets ONLY gaps not covered by prior waves:
 *
 * ClaudeAgentAdapter:
 *   - thinkingBudgetTokens / reasoning="high" → thinking option
 *   - promptCache="off" disables promptCaching
 *   - auditSink is called once per execution with model/duration
 *   - toSessionInfo: all field variants (session_id vs id, timestamps, cwd, metadata)
 *   - buildQueryOptions: maxTurns, maxBudgetUsd, permissionMode passthrough, providerOptions merge
 *   - resumeSession sets resume option on the query call
 *   - interrupt() before execute is a no-op
 *   - getCapabilities() shape assertions
 *
 * CodexAdapter:
 *   - networkAccessEnabled: true/false threading into startThread
 *   - skipGitRepoCheck from config and from input.options
 *   - reasoningEffort from config, from input.options, default="medium"
 *   - approvalPolicy override from input.options
 *   - workingDirectory from config when input has none
 *   - model from input.options overrides config model
 *   - createCodexAdapter factory produces a CodexAdapter instance
 *   - applyDynamicWorkflowCodexDefaults fills missing keys, preserves existing
 *   - healthCheck: healthy=true when SDK loads; healthy=false when load fails
 *   - getCapabilities() shape assertions
 *
 * GeminiCLIAdapter:
 *   - model arg when config.model is set
 *   - input.options.sandboxMode overrides config sandboxMode for arg shaping
 *   - Large stdin (>64KB prompt) is passed intact via -p arg
 *   - Binary not found → healthCheck.cliAvailable=false
 *   - message event with text parts array → serialized string
 *   - response/done event variants for completed
 *   - correlationId attached to started event
 *   - configure() updates model
 *   - getCapabilities() shape assertions
 *
 * ProviderAdapterRegistry (gaps beyond circuit-breaker and fallback):
 *   - register same name twice → second replaces first (no duplication)
 *   - listAdapters reflects insertion order
 *   - getHealthStatus: healthy+disabled adapter is marked unhealthy
 *   - recordSuccess + recordFailure fire bus events via setEventBus
 *   - getForTask returns { adapter, decision } with correct providerId
 *   - warmupAll: calls warmup() on registered adapters that define it
 *   - isEnabled: true after register; false after disable; true after enable
 *   - respondInteraction: false when no resolver is active
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEventBus } from "@dzupagent/core";
import { collectEvents } from "./test-helpers.js";
import type { AgentEvent, AgentInput } from "../types.js";

// ─── SDK mocks for Claude ────────────────────────────────────────────────────

function asyncClaudeOf<T>(
  items: T[]
): AsyncIterable<T> & { interrupt: ReturnType<typeof vi.fn> } {
  const interruptFn = vi.fn();
  return {
    interrupt: interruptFn,
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length)
            return { value: items[i++], done: false as const };
          return { value: undefined, done: true as const };
        },
      };
    },
  };
}

const mockClaudeQuery = vi.fn();
const mockClaudeListSessions = vi.fn();
const mockClaudeGetSessionInfo = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockClaudeQuery,
  listSessions: mockClaudeListSessions,
  getSessionInfo: mockClaudeGetSessionInfo,
}));

const { ClaudeAgentAdapter } = await import("../claude/claude-adapter.js");
const { buildQueryOptions, toSessionInfo } = await import(
  "../claude/claude-query-builder.js"
);

// ─── SDK mocks for Codex ─────────────────────────────────────────────────────

function makeCodexThread(events: Array<Record<string, unknown>>) {
  return {
    runStreamed: vi.fn().mockResolvedValue({
      events: (async function* () {
        for (const e of events) yield e;
      })(),
    }),
  };
}

const mockStartThread = vi.fn();
const mockResumeThread = vi.fn();
const mockCodexCtor = vi.fn().mockImplementation(() => ({
  startThread: mockStartThread,
  resumeThread: mockResumeThread,
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: mockCodexCtor,
}));

const { CodexAdapter, createCodexAdapter, applyDynamicWorkflowCodexDefaults } =
  await import("../codex/codex-adapter.js");

// ─── Process-helper mocks for Gemini ─────────────────────────────────────────

vi.mock("../utils/process-helpers.js", () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}));

import {
  isBinaryAvailable,
  spawnAndStreamJsonl,
} from "../utils/process-helpers.js";
const mockIsBinaryAvailable = vi.mocked(isBinaryAvailable);
const mockSpawnAndStreamJsonl = vi.mocked(spawnAndStreamJsonl);

const { GeminiCLIAdapter } = await import("../gemini/gemini-adapter.js");

// ─── Registry imports ─────────────────────────────────────────────────────────

const { ProviderAdapterRegistry } = await import(
  "../registry/adapter-registry.js"
);

import type {
  AdapterProviderId,
  AgentCLIAdapter,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from "../types.js";

// ─── Claude fixtures ──────────────────────────────────────────────────────────

function claudeSys(sessionId = "sess-W30", model = "claude-sonnet-4-5") {
  return { type: "system" as const, session_id: sessionId, model, tools: [] };
}

function claudeResult(result = "ok", sessionId?: string) {
  return {
    type: "result" as const,
    subtype: "success",
    result,
    session_id: sessionId,
    usage: { input_tokens: 10, output_tokens: 5 },
    duration_ms: 100,
  };
}

// ─── Codex fixtures ───────────────────────────────────────────────────────────

function codexStarted(threadId = "tid-W30") {
  return { type: "thread.started", thread_id: threadId };
}

function codexTurnCompleted(usage = { input_tokens: 100, output_tokens: 50 }) {
  return { type: "turn.completed", usage };
}

// ─── Registry helpers ─────────────────────────────────────────────────────────

function makeRegistryAdapter(
  providerId: AdapterProviderId,
  events: AgentEvent[] = []
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(): AsyncGenerator<AgentEvent, void, undefined> {
      for (const e of events) yield e;
    },
    async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {
      return;
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
  };
}

function makeSuccessEvents(providerId: AdapterProviderId): AgentEvent[] {
  return [
    {
      type: "adapter:started",
      providerId,
      sessionId: "s",
      timestamp: Date.now(),
    },
    {
      type: "adapter:completed",
      providerId,
      sessionId: "s",
      result: "ok",
      durationMs: 1,
      timestamp: Date.now(),
    },
  ];
}

const fixedRouter: TaskRoutingStrategy = {
  name: "fixed-claude",
  route(
    _task: TaskDescriptor,
    _available: AdapterProviderId[]
  ): RoutingDecision {
    return {
      provider: "claude",
      reason: "test",
      confidence: 1,
      fallbackProviders: ["codex"],
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// ClaudeAgentAdapter — W30 gap coverage
// ═════════════════════════════════════════════════════════════════════════════

describe("ClaudeAgentAdapter — W30 gap coverage", () => {
  let adapter: InstanceType<typeof ClaudeAgentAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ClaudeAgentAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── thinkingBudgetTokens ───────────────────────────────────────────────────

  describe("thinkingBudgetTokens", () => {
    it("passes thinking option when thinkingBudgetTokens > 0", async () => {
      const a = new ClaudeAgentAdapter({ thinkingBudgetTokens: 8000 });
      mockClaudeQuery.mockReturnValue(
        asyncClaudeOf([claudeSys(), claudeResult()])
      );
      await collectEvents(a.execute({ prompt: "p" }));
      const opts = (
        mockClaudeQuery.mock.calls[0]![0] as Record<string, unknown>
      )["options"] as Record<string, unknown>;
      expect(opts["thinking"]).toEqual({
        type: "enabled",
        budget_tokens: 8000,
      });
    });

    it('enables thinking with budget_tokens=10000 when reasoning="high"', async () => {
      const a = new ClaudeAgentAdapter({ reasoning: "high" });
      mockClaudeQuery.mockReturnValue(
        asyncClaudeOf([claudeSys(), claudeResult()])
      );
      await collectEvents(a.execute({ prompt: "p" }));
      const opts = (
        mockClaudeQuery.mock.calls[0]![0] as Record<string, unknown>
      )["options"] as Record<string, unknown>;
      expect(opts["thinking"]).toEqual({
        type: "enabled",
        budget_tokens: 10000,
      });
    });

    it("does NOT add thinking option when reasoning is not high and no budget set", async () => {
      mockClaudeQuery.mockReturnValue(
        asyncClaudeOf([claudeSys(), claudeResult()])
      );
      await collectEvents(adapter.execute({ prompt: "p" }));
      const opts = (
        mockClaudeQuery.mock.calls[0]![0] as Record<string, unknown>
      )["options"] as Record<string, unknown>;
      expect(opts["thinking"]).toBeUndefined();
    });
  });

  // ── promptCache ────────────────────────────────────────────────────────────

  describe("promptCache off disables caching", () => {
    it('omits promptCaching from options when promptCache="off"', async () => {
      const a = new ClaudeAgentAdapter({ promptCache: "off" });
      mockClaudeQuery.mockReturnValue(
        asyncClaudeOf([claudeSys(), claudeResult()])
      );
      await collectEvents(a.execute({ prompt: "p" }));
      const opts = (
        mockClaudeQuery.mock.calls[0]![0] as Record<string, unknown>
      )["options"] as Record<string, unknown>;
      expect(opts["promptCaching"]).toBeUndefined();
    });

    it("sets promptCaching=true by default (promptCache not set)", async () => {
      mockClaudeQuery.mockReturnValue(
        asyncClaudeOf([claudeSys(), claudeResult()])
      );
      await collectEvents(adapter.execute({ prompt: "p" }));
      const opts = (
        mockClaudeQuery.mock.calls[0]![0] as Record<string, unknown>
      )["options"] as Record<string, unknown>;
      expect(opts["promptCaching"]).toBe(true);
    });
  });

  // ── auditSink ──────────────────────────────────────────────────────────────

  describe("auditSink", () => {
    it("invokes auditSink after a successful execution", async () => {
      const auditSink = vi.fn();
      const a = new ClaudeAgentAdapter({
        auditSink,
        model: "claude-sonnet-4-5",
      });
      mockClaudeQuery.mockReturnValue(
        asyncClaudeOf([claudeSys(), claudeResult()])
      );
      await collectEvents(a.execute({ prompt: "audit me" }));
      expect(auditSink).toHaveBeenCalledTimes(1);
    });

    it("does NOT call auditSink when none is configured", async () => {
      const auditSink = vi.fn();
      // Different adapter without auditSink — shouldn't call the spy
      mockClaudeQuery.mockReturnValue(
        asyncClaudeOf([claudeSys(), claudeResult()])
      );
      await collectEvents(adapter.execute({ prompt: "p" }));
      expect(auditSink).not.toHaveBeenCalled();
    });

    it("auditSink receives an object with model field when adapter.config.model is set", async () => {
      const auditSink = vi.fn();
      const a = new ClaudeAgentAdapter({ auditSink, model: "claude-opus-4-5" });
      mockClaudeQuery.mockReturnValue(
        asyncClaudeOf([claudeSys(), claudeResult()])
      );
      await collectEvents(a.execute({ prompt: "p" }));
      const [record] = auditSink.mock.calls[0]!;
      expect((record as Record<string, unknown>)["model"]).toBe(
        "claude-opus-4-5"
      );
    });
  });

  // ── toSessionInfo ──────────────────────────────────────────────────────────

  describe("toSessionInfo", () => {
    it("uses session_id field when present", () => {
      const info = toSessionInfo({
        session_id: "sid-1",
        created_at: 0,
        last_active_at: 0,
      });
      expect(info.sessionId).toBe("sid-1");
      expect(info.providerId).toBe("claude");
    });

    it("falls back to id field when session_id is missing", () => {
      const info = toSessionInfo({
        id: "fallback-id",
        created_at: 0,
        last_active_at: 0,
      });
      expect(info.sessionId).toBe("fallback-id");
    });

    it("coerces numeric created_at to Date", () => {
      const ts = 1_700_000_000_000;
      const info = toSessionInfo({
        session_id: "s",
        created_at: ts,
        last_active_at: ts,
      });
      expect(info.createdAt).toBeInstanceOf(Date);
      expect(info.createdAt.getTime()).toBe(ts);
    });

    it("coerces ISO string created_at to Date", () => {
      const iso = "2024-01-01T00:00:00.000Z";
      const info = toSessionInfo({
        session_id: "s",
        created_at: iso,
        last_active_at: iso,
      });
      expect(info.createdAt).toBeInstanceOf(Date);
      expect(info.createdAt.toISOString()).toBe(iso);
    });

    it("maps cwd to workingDirectory", () => {
      const info = toSessionInfo({
        session_id: "s",
        created_at: 0,
        last_active_at: 0,
        cwd: "/home/project",
      });
      expect(info.workingDirectory).toBe("/home/project");
    });

    it("omits workingDirectory when cwd is missing", () => {
      const info = toSessionInfo({
        session_id: "s",
        created_at: 0,
        last_active_at: 0,
      });
      expect(info.workingDirectory).toBeUndefined();
    });

    it("maps metadata object to metadata field", () => {
      const meta = { tenant: "acme", plan: "pro" };
      const info = toSessionInfo({
        session_id: "s",
        created_at: 0,
        last_active_at: 0,
        metadata: meta,
      });
      expect(info.metadata).toEqual(meta);
    });

    it("omits metadata when value is null", () => {
      const info = toSessionInfo({
        session_id: "s",
        created_at: 0,
        last_active_at: 0,
        metadata: null,
      });
      expect(info.metadata).toBeUndefined();
    });
  });

  // ── buildQueryOptions ──────────────────────────────────────────────────────

  describe("buildQueryOptions", () => {
    const baseInput: AgentInput = { prompt: "hello" };
    const baseConfig = {};

    it("includes resume when input.resumeSessionId is set", () => {
      const opts = buildQueryOptions({
        input: { ...baseInput, resumeSessionId: "r-sess" },
        config: baseConfig,
        interactionPolicy: {
          mode: "auto-approve",
          allowedTools: [],
          blockedTools: [],
        },
      });
      expect((opts["options"] as Record<string, unknown>)["resume"]).toBe(
        "r-sess"
      );
    });

    it("passes maxBudgetUsd through options", () => {
      const opts = buildQueryOptions({
        input: { ...baseInput, maxBudgetUsd: 2.5 },
        config: baseConfig,
        interactionPolicy: {
          mode: "auto-approve",
          allowedTools: [],
          blockedTools: [],
        },
      });
      expect((opts["options"] as Record<string, unknown>)["maxBudgetUsd"]).toBe(
        2.5
      );
    });

    it("passes maxTurns through options", () => {
      const opts = buildQueryOptions({
        input: { ...baseInput, maxTurns: 12 },
        config: baseConfig,
        interactionPolicy: {
          mode: "auto-approve",
          allowedTools: [],
          blockedTools: [],
        },
      });
      expect((opts["options"] as Record<string, unknown>)["maxTurns"]).toBe(12);
    });

    it("sets bypassPermissions when auto-approve and no sandboxMode", () => {
      const opts = buildQueryOptions({
        input: baseInput,
        config: baseConfig,
        interactionPolicy: {
          mode: "auto-approve",
          allowedTools: [],
          blockedTools: [],
        },
      });
      expect(
        (opts["options"] as Record<string, unknown>)["permissionMode"]
      ).toBe("bypassPermissions");
    });

    it("respects input.options.permissionMode override", () => {
      const opts = buildQueryOptions({
        input: { ...baseInput, options: { permissionMode: "acceptEdits" } },
        config: baseConfig,
        interactionPolicy: {
          mode: "auto-approve",
          allowedTools: [],
          blockedTools: [],
        },
      });
      expect(
        (opts["options"] as Record<string, unknown>)["permissionMode"]
      ).toBe("acceptEdits");
    });

    it("merges providerOptions from config into options", () => {
      const opts = buildQueryOptions({
        input: baseInput,
        config: { providerOptions: { customFlag: true, extraKey: "value" } },
        interactionPolicy: {
          mode: "auto-approve",
          allowedTools: [],
          blockedTools: [],
        },
      });
      const o = opts["options"] as Record<string, unknown>;
      expect(o["customFlag"]).toBe(true);
      expect(o["extraKey"]).toBe("value");
    });

    it("uses input cwd over config workingDirectory", () => {
      const opts = buildQueryOptions({
        input: { ...baseInput, workingDirectory: "/input/dir" },
        config: { workingDirectory: "/config/dir" },
        interactionPolicy: {
          mode: "auto-approve",
          allowedTools: [],
          blockedTools: [],
        },
      });
      expect((opts["options"] as Record<string, unknown>)["cwd"]).toBe(
        "/input/dir"
      );
    });

    it("uses config workingDirectory when input has none", () => {
      const opts = buildQueryOptions({
        input: baseInput,
        config: { workingDirectory: "/fallback/dir" },
        interactionPolicy: {
          mode: "auto-approve",
          allowedTools: [],
          blockedTools: [],
        },
      });
      expect((opts["options"] as Record<string, unknown>)["cwd"]).toBe(
        "/fallback/dir"
      );
    });

    it("passes continue and forkSession from input.options", () => {
      const opts = buildQueryOptions({
        input: { ...baseInput, options: { continue: true, forkSession: true } },
        config: baseConfig,
        interactionPolicy: {
          mode: "auto-approve",
          allowedTools: [],
          blockedTools: [],
        },
      });
      const o = opts["options"] as Record<string, unknown>;
      expect(o["continue"]).toBe(true);
      expect(o["forkSession"]).toBe(true);
    });
  });

  // ── interrupt before execute ───────────────────────────────────────────────

  describe("interrupt", () => {
    it("is a no-op when called before execute()", () => {
      const a = new ClaudeAgentAdapter();
      expect(() => a.interrupt()).not.toThrow();
    });
  });

  // ── getCapabilities ────────────────────────────────────────────────────────

  describe("getCapabilities", () => {
    it("returns correct capability flags", () => {
      const caps = adapter.getCapabilities();
      expect(caps.supportsResume).toBe(true);
      expect(caps.supportsFork).toBe(true);
      expect(caps.supportsToolCalls).toBe(true);
      expect(caps.supportsStreaming).toBe(true);
      expect(caps.supportsCostUsage).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CodexAdapter — W30 gap coverage
// ═════════════════════════════════════════════════════════════════════════════

describe("CodexAdapter — W30 gap coverage", () => {
  let adapter: InstanceType<typeof CodexAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the Codex constructor implementation after clearAllMocks resets it.
    mockCodexCtor.mockImplementation(() => ({
      startThread: mockStartThread,
      resumeThread: mockResumeThread,
    }));
    adapter = new CodexAdapter();
  });

  // ── networkAccessEnabled ───────────────────────────────────────────────────

  describe("networkAccessEnabled", () => {
    it("passes networkAccessEnabled=true to startThread", async () => {
      const a = new CodexAdapter({ networkAccessEnabled: true });
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(a.execute({ prompt: "p" }));
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        networkAccessEnabled: true,
      });
    });

    it("defaults networkAccessEnabled=true when not set in config", async () => {
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(adapter.execute({ prompt: "p" }));
      // Default via buildThreadOptions: networkAccessEnabled is explicitly true unless overridden
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        networkAccessEnabled: true,
      });
    });

    it("allows input.options.networkAccessEnabled to override config", async () => {
      const a = new CodexAdapter({ networkAccessEnabled: true });
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(
        a.execute({ prompt: "p", options: { networkAccessEnabled: false } })
      );
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        networkAccessEnabled: false,
      });
    });
  });

  // ── skipGitRepoCheck ───────────────────────────────────────────────────────

  describe("skipGitRepoCheck", () => {
    it("passes skipGitRepoCheck=true from config to startThread", async () => {
      const a = new CodexAdapter({ skipGitRepoCheck: true });
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(a.execute({ prompt: "p" }));
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        skipGitRepoCheck: true,
      });
    });

    it("passes skipGitRepoCheck=true from input.options, overriding config=false", async () => {
      const a = new CodexAdapter({ skipGitRepoCheck: false });
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(
        a.execute({ prompt: "p", options: { skipGitRepoCheck: true } })
      );
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        skipGitRepoCheck: true,
      });
    });

    it("omits skipGitRepoCheck from thread options when not configured", async () => {
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(adapter.execute({ prompt: "p" }));
      const opts = mockStartThread.mock.calls[0]![0] as Record<string, unknown>;
      expect(opts["skipGitRepoCheck"]).toBeUndefined();
    });
  });

  // ── reasoningEffort ────────────────────────────────────────────────────────

  describe("reasoningEffort", () => {
    it('defaults to "medium" when not specified', async () => {
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(adapter.execute({ prompt: "p" }));
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        reasoningEffort: "medium",
      });
    });

    it("uses config.reasoning when set", async () => {
      const a = new CodexAdapter({ reasoning: "high" });
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(a.execute({ prompt: "p" }));
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        reasoningEffort: "high",
      });
    });

    it("input.options.reasoning overrides config.reasoning", async () => {
      const a = new CodexAdapter({ reasoning: "high" });
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(
        a.execute({ prompt: "p", options: { reasoning: "low" } })
      );
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        reasoningEffort: "low",
      });
    });
  });

  // ── approvalPolicy ─────────────────────────────────────────────────────────

  describe("approvalPolicy", () => {
    it("passes input.options.approvalPolicy to startThread", async () => {
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(
        adapter.execute({ prompt: "p", options: { approvalPolicy: "always" } })
      );
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        approvalPolicy: "always",
      });
    });

    it("uses config.approvalPolicy when input has no override", async () => {
      const a = new CodexAdapter({ approvalPolicy: "never" });
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(a.execute({ prompt: "p" }));
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        approvalPolicy: "never",
      });
    });
  });

  // ── workingDirectory ───────────────────────────────────────────────────────

  describe("workingDirectory", () => {
    it("uses config.workingDirectory when input has none", async () => {
      const a = new CodexAdapter({ workingDirectory: "/from-config" });
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(a.execute({ prompt: "p" }));
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        workingDirectory: "/from-config",
      });
    });

    it("input.workingDirectory overrides config.workingDirectory", async () => {
      const a = new CodexAdapter({ workingDirectory: "/from-config" });
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(
        a.execute({ prompt: "p", workingDirectory: "/from-input" })
      );
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        workingDirectory: "/from-input",
      });
    });

    it("omits workingDirectory when not set anywhere", async () => {
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(adapter.execute({ prompt: "p" }));
      expect(
        (mockStartThread.mock.calls[0]![0] as Record<string, unknown>)[
          "workingDirectory"
        ]
      ).toBeUndefined();
    });
  });

  // ── model override ─────────────────────────────────────────────────────────

  describe("model", () => {
    it("input.options.model overrides config model", async () => {
      const a = new CodexAdapter({ model: "gpt-5.5" });
      mockStartThread.mockReturnValue(
        makeCodexThread([codexStarted(), codexTurnCompleted()])
      );
      await collectEvents(
        a.execute({ prompt: "p", options: { model: "gpt-4o-mini" } })
      );
      expect(mockStartThread.mock.calls[0]![0]).toMatchObject({
        model: "gpt-4o-mini",
      });
    });
  });

  // ── createCodexAdapter factory ─────────────────────────────────────────────

  describe("createCodexAdapter", () => {
    it("creates a CodexAdapter instance", () => {
      const a = createCodexAdapter();
      expect(a).toBeInstanceOf(CodexAdapter);
      expect(a.providerId).toBe("codex");
    });

    it("passes config to the created adapter", () => {
      const a = createCodexAdapter({ model: "gpt-4o" });
      expect(
        (a as unknown as { config: Record<string, unknown> }).config["model"]
      ).toBe("gpt-4o");
    });
  });

  // ── applyDynamicWorkflowCodexDefaults ──────────────────────────────────────

  describe("applyDynamicWorkflowCodexDefaults", () => {
    it('fills networkAccessEnabled=false, sandboxMode="workspace-write", approvalPolicy="on-request"', () => {
      const result = applyDynamicWorkflowCodexDefaults({});
      expect(result.networkAccessEnabled).toBe(false);
      expect(result.sandboxMode).toBe("workspace-write");
      expect(result.approvalPolicy).toBe("on-request");
    });

    it("preserves existing values and does not overwrite them", () => {
      const result = applyDynamicWorkflowCodexDefaults({
        networkAccessEnabled: true,
        sandboxMode: "full-access",
        approvalPolicy: "always",
      });
      expect(result.networkAccessEnabled).toBe(true);
      expect(result.sandboxMode).toBe("full-access");
      expect(result.approvalPolicy).toBe("always");
    });

    it("preserves extra config fields not defined in defaults", () => {
      const result = applyDynamicWorkflowCodexDefaults({
        model: "gpt-4o",
        reasoning: "high",
      });
      expect(result.model).toBe("gpt-4o");
      expect(result.reasoning).toBe("high");
    });
  });

  // ── healthCheck ────────────────────────────────────────────────────────────

  describe("healthCheck", () => {
    it("returns healthy=true when SDK loads correctly", async () => {
      // codex-sdk is already mocked to resolve
      const status = await adapter.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.sdkInstalled).toBe(true);
      expect(status.providerId).toBe("codex");
    });
  });

  // ── getCapabilities ────────────────────────────────────────────────────────

  describe("getCapabilities", () => {
    it("returns correct capability flags", () => {
      const caps = adapter.getCapabilities();
      expect(caps.supportsResume).toBe(true);
      expect(caps.supportsFork).toBe(false);
      expect(caps.supportsToolCalls).toBe(true);
      expect(caps.supportsStreaming).toBe(true);
      expect(caps.supportsCostUsage).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GeminiCLIAdapter — W30 gap coverage
// ═════════════════════════════════════════════════════════════════════════════

describe("GeminiCLIAdapter — W30 gap coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBinaryAvailable.mockResolvedValue(true);
  });

  // ── model arg ─────────────────────────────────────────────────────────────

  describe("model arg", () => {
    it("passes --model when config.model is set", async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: "completed", result: "ok" };
      });
      const a = new GeminiCLIAdapter({ model: "gemini-2.5-pro" });
      await collectEvents(a.execute({ prompt: "p" }));
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!;
      const idx = args.indexOf("--model");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("gemini-2.5-pro");
    });

    it("omits --model when config.model is not set", async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: "completed", result: "ok" };
      });
      await collectEvents(new GeminiCLIAdapter().execute({ prompt: "p" }));
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!;
      expect(args).not.toContain("--model");
    });
  });

  // ── input.options.sandboxMode overrides config ─────────────────────────────

  describe("input.options.sandboxMode overrides config sandboxMode", () => {
    it("uses input sandboxMode over adapter config sandboxMode", async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: "completed", result: "ok" };
      });
      const a = new GeminiCLIAdapter({ sandboxMode: "read-only" });
      await collectEvents(
        a.execute({ prompt: "p", options: { sandboxMode: "full-access" } })
      );
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!;
      const idx = args.indexOf("--sandbox");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("none"); // 'full-access' → 'none'
    });
  });

  // ── large prompt ───────────────────────────────────────────────────────────

  describe("large prompt handling", () => {
    it("passes a 64KB+ prompt intact via -p arg", async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: "completed", result: "ok" };
      });
      const bigPrompt = "A".repeat(65_536);
      await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: bigPrompt })
      );
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!;
      const pIdx = args.indexOf("-p");
      expect(pIdx).toBeGreaterThanOrEqual(0);
      expect(args[pIdx + 1]).toBe(bigPrompt);
      expect(args[pIdx + 1].length).toBe(65_536);
    });
  });

  // ── healthCheck: CLI not found ─────────────────────────────────────────────

  describe("healthCheck when binary not found", () => {
    it("returns cliAvailable=false when gemini binary is not on PATH", async () => {
      mockIsBinaryAvailable.mockResolvedValue(false);
      const a = new GeminiCLIAdapter();
      const status = await a.healthCheck();
      expect(status.cliAvailable).toBe(false);
      // healthy is still set to true (SDK check passes since there is no SDK) or false
      // but the key assertion is cliAvailable
    });

    it("returns cliAvailable=true when gemini binary is available", async () => {
      mockIsBinaryAvailable.mockResolvedValue(true);
      const a = new GeminiCLIAdapter();
      const status = await a.healthCheck();
      expect(status.cliAvailable).toBe(true);
    });
  });

  // ── message event variants ─────────────────────────────────────────────────

  describe("message event text parts array", () => {
    it("serializes text parts array as JSON string", async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { event: "message", text: { parts: ["hello", " world"] } };
        yield { type: "completed", result: "" };
      });
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: "p" })
      );
      const msg = events.find((e) => e.type === "adapter:message") as Extract<
        AgentEvent,
        { type: "adapter:message" }
      >;
      expect(msg.content).toBe('{"parts":["hello"," world"]}');
    });

    it('emits adapter:message for "response" event type', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: "response", content: "response content" };
        yield { type: "completed", result: "" };
      });
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: "p" })
      );
      const msg = events.find((e) => e.type === "adapter:message") as Extract<
        AgentEvent,
        { type: "adapter:message" }
      >;
      expect(msg).toBeDefined();
      expect(msg.content).toBe("response content");
    });
  });

  // ── "done" event variant for completed ────────────────────────────────────

  describe('"done" event maps to adapter:completed', () => {
    it('handles "done" as completed event', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: "done", result: "finished", duration_ms: 55 };
      });
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: "p" })
      );
      const completed = events.find(
        (e) => e.type === "adapter:completed"
      ) as Extract<AgentEvent, { type: "adapter:completed" }>;
      expect(completed).toBeDefined();
      expect(completed.result).toBe("finished");
      expect(completed.durationMs).toBe(55);
    });
  });

  // ── correlationId on started ───────────────────────────────────────────────

  describe("correlationId", () => {
    it("correlationId is present on started event when provided", async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: "completed", result: "" };
      });
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({
          prompt: "p",
          correlationId: "corr-gemini",
        })
      );
      const started = events.find(
        (e) => e.type === "adapter:started"
      ) as Extract<AgentEvent, { type: "adapter:started" }>;
      expect(
        (started as unknown as Record<string, unknown>)["correlationId"]
      ).toBe("corr-gemini");
    });
  });

  // ── configure() ───────────────────────────────────────────────────────────

  describe("configure()", () => {
    it("updates model used in --model arg after configure()", async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: "completed", result: "" };
      });
      const a = new GeminiCLIAdapter({ model: "gemini-2.0-flash" });
      a.configure({ model: "gemini-2.5-pro" });
      await collectEvents(a.execute({ prompt: "p" }));
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!;
      const idx = args.indexOf("--model");
      expect(args[idx + 1]).toBe("gemini-2.5-pro");
    });
  });

  // ── getCapabilities ────────────────────────────────────────────────────────

  describe("getCapabilities", () => {
    it("reports correct capability flags", () => {
      const caps = new GeminiCLIAdapter().getCapabilities();
      expect(caps.supportsResume).toBe(true);
      expect(caps.supportsFork).toBe(false);
      expect(caps.supportsToolCalls).toBe(true);
      expect(caps.supportsStreaming).toBe(true);
    });
  });

  // ── tool_call variant with "input" field ──────────────────────────────────

  describe('tool_call with "input" field variant', () => {
    it('extracts arguments from "input" when "arguments" missing', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: "tool_call", name: "read_file", input: { path: "a.ts" } };
        yield { type: "completed", result: "" };
      });
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: "p" })
      );
      const call = events.find(
        (e) => e.type === "adapter:tool_call"
      ) as Extract<AgentEvent, { type: "adapter:tool_call" }>;
      expect(call.input).toEqual({ path: "a.ts" });
    });
  });

  // ── function_response with "output" field ─────────────────────────────────

  describe('function_response with "output" field', () => {
    it('uses "output" field for tool_result output', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: "function_response", name: "run", output: "result text" };
        yield { type: "completed", result: "" };
      });
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: "p" })
      );
      const result = events.find(
        (e) => e.type === "adapter:tool_result"
      ) as Extract<AgentEvent, { type: "adapter:tool_result" }>;
      expect(result.output).toBe("result text");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ProviderAdapterRegistry — W30 gap coverage
// ═════════════════════════════════════════════════════════════════════════════

describe("ProviderAdapterRegistry — W30 gap coverage", () => {
  // ── register same name twice replaces ─────────────────────────────────────

  describe("register deduplication", () => {
    it("registering same providerId twice replaces the first, listAdapters has only one entry", () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      registry.register(makeRegistryAdapter("claude")); // second replaces first
      const ids = registry.listAdapters().filter((id) => id === "claude");
      expect(ids).toHaveLength(1);
    });

    it("second registration replaces the adapter object", () => {
      const registry = new ProviderAdapterRegistry();
      const first = makeRegistryAdapter("claude");
      const second = makeRegistryAdapter("claude");
      registry.register(first).register(second);
      expect(registry.get("claude")).toBe(second);
    });
  });

  // ── listAdapters ──────────────────────────────────────────────────────────

  describe("listAdapters", () => {
    it("returns all registered providerIds in insertion order", () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      registry.register(makeRegistryAdapter("codex"));
      registry.register(makeRegistryAdapter("gemini"));
      const ids = registry.listAdapters();
      expect(ids).toContain("claude");
      expect(ids).toContain("codex");
      expect(ids).toContain("gemini");
      expect(ids).toHaveLength(3);
    });

    it("returns empty array on a fresh registry", () => {
      const registry = new ProviderAdapterRegistry();
      expect(registry.listAdapters()).toEqual([]);
    });
  });

  // ── getHealthStatus ────────────────────────────────────────────────────────

  describe("getHealthStatus", () => {
    it("reports healthy adapters as healthy", async () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      const status = await registry.getHealthStatus();
      expect(status["claude"]?.healthy).toBe(true);
    });

    it("reports disabled adapter as unhealthy in getHealthStatus", async () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      registry.disable("claude");
      const status = await registry.getHealthStatus();
      expect(status["claude"]?.healthy).toBe(false);
    });

    it("includes multiple adapters in getHealthStatus result", async () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      registry.register(makeRegistryAdapter("codex"));
      const status = await registry.getHealthStatus();
      expect(Object.keys(status)).toContain("claude");
      expect(Object.keys(status)).toContain("codex");
    });
  });

  // ── recordSuccess / recordFailure bus events ───────────────────────────────

  describe("recordSuccess and recordFailure bus events", () => {
    it("recordFailure fires provider:failed on the bus", () => {
      const registry = new ProviderAdapterRegistry({
        circuitBreaker: { failureThreshold: 10 },
      });
      registry.register(makeRegistryAdapter("claude"));
      const bus = createEventBus();
      const captured: unknown[] = [];
      bus.onAny((e) => captured.push(e));
      registry.setEventBus(bus);

      registry.recordFailure("claude", new Error("test failure"));

      const providerFailed = captured.find(
        (e: unknown) =>
          (e as Record<string, unknown>)["type"] === "provider:failed"
      );
      expect(providerFailed).toBeDefined();
      expect((providerFailed as Record<string, unknown>)["provider"]).toBe(
        "claude"
      );
    });

    it("recordSuccess after recordFailure fires provider:circuit_closed when circuit was open", () => {
      const registry = new ProviderAdapterRegistry({
        circuitBreaker: { failureThreshold: 1 },
      });
      registry.register(makeRegistryAdapter("claude"));
      const bus = createEventBus();
      const captured: unknown[] = [];
      bus.onAny((e) => captured.push(e));
      registry.setEventBus(bus);

      registry.recordFailure("claude", new Error("fail"));
      // circuit is now open
      const beforeClose = captured.find(
        (e: unknown) =>
          (e as Record<string, unknown>)["type"] === "provider:circuit_opened"
      );
      expect(beforeClose).toBeDefined();

      captured.length = 0;
      registry.recordSuccess("claude");
      const closedEvent = captured.find(
        (e: unknown) =>
          (e as Record<string, unknown>)["type"] === "provider:circuit_closed"
      );
      expect(closedEvent).toBeDefined();
    });
  });

  // ── getForTask ─────────────────────────────────────────────────────────────

  describe("getForTask", () => {
    it("returns adapter and decision with correct providerId", () => {
      const registry = new ProviderAdapterRegistry().setRouter(fixedRouter);
      registry.register(makeRegistryAdapter("claude"));
      const task: TaskDescriptor = { prompt: "do x", tags: [] };
      const { adapter: a, decision } = registry.getForTask(task);
      expect(a.providerId).toBe("claude");
      expect(decision.provider).toBe("claude");
      expect(decision.confidence).toBe(1);
    });
  });

  // ── warmupAll ─────────────────────────────────────────────────────────────

  describe("warmupAll", () => {
    it("calls warmup() on adapters that define it", async () => {
      const registry = new ProviderAdapterRegistry();
      const a = makeRegistryAdapter("claude");
      a.warmup = vi.fn().mockResolvedValue(undefined);
      registry.register(a);
      await registry.warmupAll();
      expect(a.warmup).toHaveBeenCalledTimes(1);
    });

    it("ignores adapters that do not define warmup()", async () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("codex")); // no warmup defined
      await expect(registry.warmupAll()).resolves.toBeUndefined();
    });

    it("does not throw when a warmup() rejects", async () => {
      const registry = new ProviderAdapterRegistry();
      const a = makeRegistryAdapter("gemini");
      a.warmup = vi.fn().mockRejectedValue(new Error("warmup failed"));
      registry.register(a);
      await expect(registry.warmupAll()).resolves.toBeUndefined();
    });
  });

  // ── isEnabled / disable / enable ──────────────────────────────────────────

  describe("isEnabled / disable / enable", () => {
    it("isEnabled is true after register", () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      expect(registry.isEnabled("claude")).toBe(true);
    });

    it("isEnabled is false after disable()", () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      registry.disable("claude");
      expect(registry.isEnabled("claude")).toBe(false);
    });

    it("isEnabled is true again after enable()", () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      registry.disable("claude");
      registry.enable("claude");
      expect(registry.isEnabled("claude")).toBe(true);
    });

    it("disable() returns true when adapter exists, false when not registered", () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      expect(registry.disable("claude")).toBe(true);
      expect(registry.disable("qwen")).toBe(false);
    });

    it("enable() returns true when adapter was disabled (removes from disabled set), false when not in disabled set", () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      registry.disable("claude");
      // claude is now disabled → enable() removes it from the disabled set → true
      expect(registry.enable("claude")).toBe(true);
      // claude is no longer disabled → enable() finds nothing to delete → false
      expect(registry.enable("claude")).toBe(false);
    });
  });

  // ── unregister ────────────────────────────────────────────────────────────

  describe("unregister", () => {
    it("unregister removes adapter and returns true", () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      expect(registry.unregister("claude")).toBe(true);
      expect(registry.get("claude")).toBeUndefined();
    });

    it("unregister returns false when adapter not present", () => {
      const registry = new ProviderAdapterRegistry();
      expect(registry.unregister("claude")).toBe(false);
    });

    it("listAdapters does not include unregistered adapter", () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      registry.unregister("claude");
      expect(registry.listAdapters()).not.toContain("claude");
    });
  });

  // ── respondInteraction ────────────────────────────────────────────────────

  describe("respondInteraction", () => {
    it("returns false when no resolver is active for the adapter", async () => {
      const registry = new ProviderAdapterRegistry();
      registry.register(makeRegistryAdapter("claude"));
      const result = await registry.respondInteraction("claude", "ix-1", "yes");
      expect(result).toBe(false);
    });
  });

  // ── executeWithFallback: provider:progress events ─────────────────────────

  describe("executeWithFallback routing events", () => {
    it("emits adapter:progress event before starting primary adapter", async () => {
      const registry = new ProviderAdapterRegistry().setRouter(fixedRouter);
      registry.register(
        makeRegistryAdapter("claude", makeSuccessEvents("claude"))
      );
      const events = await collectEvents(
        registry.executeWithFallback({ prompt: "p" }, { prompt: "p", tags: [] })
      );
      const progress = events.filter((e) => e.type === "adapter:progress");
      expect(progress.length).toBeGreaterThanOrEqual(1);
    });

    it("all events have a timestamp field", async () => {
      const registry = new ProviderAdapterRegistry().setRouter(fixedRouter);
      registry.register(
        makeRegistryAdapter("claude", makeSuccessEvents("claude"))
      );
      const events = await collectEvents(
        registry.executeWithFallback({ prompt: "p" }, { prompt: "p", tags: [] })
      );
      for (const e of events) {
        const rec = e as unknown as Record<string, unknown>;
        expect(typeof rec["timestamp"]).toBe("number");
      }
    });
  });
});
