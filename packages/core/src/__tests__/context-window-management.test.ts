/**
 * context-window-management.test.ts
 *
 * Comprehensive tests for context window management across @dzupagent/core:
 *
 *  - Token counting: text, messages, tool calls, system prompts
 *  - Truncation strategies: oldest-first, sliding window, budget-aware
 *  - Overflow detection: isContextLengthError, threshold warnings
 *  - Multi-turn accumulation: messages accumulate correctly
 *  - Edge cases: empty history, single message, exactly-at-limit, over-limit
 *  - Configuration: window sizes, model limits, registry context-window requirements
 *  - Integration: token counting + overflow detection + model registry context-window
 *
 * No live LLM calls. All tests are deterministic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import {
  HeuristicTokenizer,
  AnthropicTokenizer,
  TiktokenTokenizer,
  type Tokenizer,
  type TokenizableMessage,
} from "../llm/tokenizer.js";
import {
  TokenizerRegistry,
  defaultTokenizerRegistry,
} from "../llm/tokenizer-registry.js";
import { estimateTokens, extractTokenUsage } from "../llm/invoke.js";
import { isContextLengthError, isTransientError } from "../llm/retry.js";
import type {
  ModelSpec,
  LLMProviderConfig,
  ModelFactory,
} from "../llm/model-config.js";

// ---------------------------------------------------------------------------
// Mock heavy LLM constructors — we never make real API calls
// ---------------------------------------------------------------------------
vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: vi
    .fn()
    .mockImplementation((opts: Record<string, unknown>) => ({
      _type: "anthropic",
      ...opts,
    })),
}));
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
    _type: "openai",
    ...opts,
  })),
}));
vi.mock("../llm/circuit-breaker.js", () => {
  class MockCircuitBreaker {
    canExecute() {
      return true;
    }
    recordFailure() {
      /* noop */
    }
    recordSuccess() {
      /* noop */
    }
    getState() {
      return "closed";
    }
  }
  return { CircuitBreaker: MockCircuitBreaker };
});
vi.mock("../llm/embedding-registry.js", () => ({
  EmbeddingRegistry: class {},
  createDefaultEmbeddingRegistry: () => ({}),
}));
vi.mock("../llm/retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/retry.js")>();
  return actual;
});

import { ModelRegistry } from "../llm/model-registry.js";
import { ForgeError } from "../errors/forge-error.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stub ModelFactory that returns a plain object (no real API client). */
const stubFactory: ModelFactory = (_provider, spec, overrides) =>
  ({
    _model: overrides?.model ?? spec.name,
    _maxTokens: overrides?.maxTokens ?? spec.maxTokens,
  }) as unknown as ReturnType<ModelFactory>;

function makeProvider(
  overrides?: Partial<LLMProviderConfig>,
): LLMProviderConfig {
  return {
    provider: "anthropic",
    apiKey: "test-key",
    priority: 1,
    models: {
      chat: { name: "claude-haiku", maxTokens: 1024 },
    },
    ...overrides,
  };
}

/** Build a plain-object message compatible with TokenizableMessage */
function makeMsg(content: string, role = "user"): TokenizableMessage {
  return { content, role };
}

/**
 * Minimal in-memory conversation history that accumulates messages and
 * tracks token usage per turn. Represents the core of context-window
 * accumulation without any LLM dependency.
 */
class ConversationHistory {
  private messages: Array<{ role: string; content: string }> = [];
  private tokenizer: Tokenizer;

  constructor(tokenizer: Tokenizer) {
    this.tokenizer = tokenizer;
  }

  addMessage(role: string, content: string): void {
    this.messages.push({ role, content });
  }

  getMessages(): Array<{ role: string; content: string }> {
    return [...this.messages];
  }

  totalTokens(): number {
    return this.tokenizer.countMessages(this.messages);
  }

  clear(): void {
    this.messages = [];
  }

  size(): number {
    return this.messages.length;
  }
}

/**
 * Truncation strategies over a ConversationHistory-like array.
 * These are pure helper functions — they do not modify the history in place.
 */
function truncateOldestFirst(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  tokenizer: Tokenizer,
  preserveSystemPrompt = true,
): Array<{ role: string; content: string }> {
  if (messages.length === 0) return [];

  let working = [...messages];
  const systemMsgs = preserveSystemPrompt
    ? working.filter((m) => m.role === "system")
    : [];
  const nonSystem = preserveSystemPrompt
    ? working.filter((m) => m.role !== "system")
    : working;

  // Drop oldest non-system messages until we fit
  let remaining = [...nonSystem];
  while (
    remaining.length > 0 &&
    tokenizer.countMessages([...systemMsgs, ...remaining]) > maxTokens
  ) {
    remaining = remaining.slice(1);
  }

  return [...systemMsgs, ...remaining];
}

function truncateSlidingWindow(
  messages: Array<{ role: string; content: string }>,
  windowSize: number,
): Array<{ role: string; content: string }> {
  if (messages.length <= windowSize) return [...messages];
  return messages.slice(messages.length - windowSize);
}

function isOverLimit(
  messages: Array<{ role: string; content: string }>,
  limitTokens: number,
  tokenizer: Tokenizer,
): boolean {
  return tokenizer.countMessages(messages) > limitTokens;
}

function remainingBudget(
  messages: Array<{ role: string; content: string }>,
  limitTokens: number,
  tokenizer: Tokenizer,
): number {
  const used = tokenizer.countMessages(messages);
  return Math.max(0, limitTokens - used);
}

// ---------------------------------------------------------------------------
// 1. Token counting — HeuristicTokenizer
// ---------------------------------------------------------------------------

describe("Token counting — HeuristicTokenizer", () => {
  let t: HeuristicTokenizer;

  beforeEach(() => {
    t = new HeuristicTokenizer();
  });

  it("counts tokens for a short system prompt", () => {
    const sys = "You are a helpful assistant.";
    expect(t.countTokens(sys)).toBeGreaterThan(0);
    expect(t.countTokens(sys)).toBe(Math.ceil(sys.length / 4));
  });

  it("counts tokens for a multi-word user message", () => {
    const msg = "What is the capital of France?";
    expect(t.countTokens(msg)).toBe(Math.ceil(msg.length / 4));
  });

  it("returns 0 for empty content", () => {
    expect(t.countTokens("")).toBe(0);
  });

  it("counts tokens for a tool call represented as JSON string", () => {
    const toolCall = JSON.stringify({
      name: "search",
      args: { query: "Paris" },
    });
    expect(t.countTokens(toolCall)).toBe(Math.ceil(toolCall.length / 4));
  });

  it("counts messages across a 3-turn conversation", () => {
    const messages = [
      makeMsg("You are a helpful assistant.", "system"),
      makeMsg("What is 2 + 2?", "user"),
      makeMsg("The answer is 4.", "assistant"),
    ];
    const total = t.countMessages(messages);
    const expected = messages.reduce(
      (sum, m) => sum + t.countTokens(m.content as string),
      0,
    );
    expect(total).toBe(expected);
  });

  it("countMessages handles null/undefined content gracefully", () => {
    const msgs = [{ content: null }, { content: undefined }, { content: "" }];
    expect(t.countMessages(msgs)).toBe(0);
  });

  it("countMessages handles numeric JSON content by stringifying", () => {
    const msg = [{ content: { answer: 42 } }];
    const expected = t.countTokens(JSON.stringify({ answer: 42 }));
    expect(t.countMessages(msg)).toBe(expected);
  });

  it("longer text produces proportionally more tokens", () => {
    const short = "Hello";
    const long = "Hello ".repeat(100);
    expect(t.countTokens(long)).toBeGreaterThan(t.countTokens(short));
  });

  it("unicode text is counted by character length / 4", () => {
    const emoji = "🚀🔥💡";
    // Each emoji is 2 chars in JS (surrogate pairs) — length-based heuristic
    const count = t.countTokens(emoji);
    expect(count).toBe(Math.ceil(emoji.length / 4));
  });

  it("exactly-4-chars produces exactly 1 token", () => {
    expect(t.countTokens("abcd")).toBe(1);
  });

  it("5 chars produces 2 tokens (ceil)", () => {
    expect(t.countTokens("abcde")).toBe(2);
  });

  it("countMessages with LangChain-style BaseMessage objects", () => {
    const msgs: BaseMessage[] = [
      new SystemMessage("Be helpful"),
      new HumanMessage("Tell me about Paris"),
      new AIMessage("Paris is the capital of France."),
    ];
    const total = t.countMessages(msgs);
    expect(total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Token counting — AnthropicTokenizer (heuristic fallback path)
// ---------------------------------------------------------------------------

describe("Token counting — AnthropicTokenizer (heuristic fallback)", () => {
  let t: AnthropicTokenizer;

  beforeEach(() => {
    t = new AnthropicTokenizer("claude-haiku-4-5");
  });

  it("returns 0 for empty string", () => {
    expect(t.countTokens("")).toBe(0);
  });

  it("returns a positive count for non-empty system prompt", () => {
    const sys = "You are a code generation assistant.";
    expect(t.countTokens(sys)).toBeGreaterThan(0);
  });

  it("returns a count <= character length for ASCII text", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    expect(t.countTokens(text)).toBeLessThanOrEqual(text.length);
  });

  it("encode returns array whose length matches countTokens", () => {
    const text = "hello context window";
    expect(t.encode(text)).toHaveLength(t.countTokens(text));
  });

  it("countMessages sums across messages", () => {
    const msgs = [
      { content: "System: be helpful." },
      { content: "User: what is 2+2?" },
      { content: "Assistant: 4." },
    ];
    const total = t.countMessages(msgs);
    const sum = msgs.reduce((s, m) => s + t.countTokens(m.content), 0);
    expect(total).toBe(sum);
  });

  it("model property is preserved", () => {
    expect(t.model).toBe("claude-haiku-4-5");
  });
});

// ---------------------------------------------------------------------------
// 3. Token counting — TiktokenTokenizer
// ---------------------------------------------------------------------------

describe("Token counting — TiktokenTokenizer", () => {
  let t: TiktokenTokenizer;

  beforeEach(() => {
    t = new TiktokenTokenizer("gpt-4o");
  });

  it("returns 0 for empty string", () => {
    expect(t.countTokens("")).toBe(0);
  });

  it("returns a positive count for user message", () => {
    expect(t.countTokens("Hello, how are you?")).toBeGreaterThan(0);
  });

  it("countMessages adds per-message overhead (> raw content count)", () => {
    const single = t.countTokens("hello world");
    const withMsg = t.countMessages([{ content: "hello world" }]);
    expect(withMsg).toBeGreaterThan(single);
  });

  it("countMessages with 2 messages returns sum + per-message overhead + reply priming", () => {
    const a = t.countTokens("aaaa");
    const b = t.countTokens("bbbb");
    const total = t.countMessages([{ content: "aaaa" }, { content: "bbbb" }]);
    // each message gets +4 overhead, plus +2 for reply priming
    expect(total).toBe(a + 4 + b + 4 + 2);
  });

  it("countMessages returns 0 for empty array", () => {
    expect(t.countMessages([])).toBe(0);
  });

  it("model property is preserved", () => {
    expect(t.model).toBe("gpt-4o");
  });
});

// ---------------------------------------------------------------------------
// 4. TokenizerRegistry — model routing for context window management
// ---------------------------------------------------------------------------

describe("TokenizerRegistry — context window routing", () => {
  it("resolves claude models to AnthropicTokenizer", () => {
    const reg = new TokenizerRegistry();
    reg.register(/claude/i, (id) => new AnthropicTokenizer(id));
    expect(reg.resolve("claude-3-5-sonnet-20241022")).toBeInstanceOf(
      AnthropicTokenizer,
    );
  });

  it("resolves gpt models to TiktokenTokenizer", () => {
    const reg = new TokenizerRegistry();
    reg.register(/gpt-/i, (id) => new TiktokenTokenizer(id));
    expect(reg.resolve("gpt-4o")).toBeInstanceOf(TiktokenTokenizer);
  });

  it("falls back to HeuristicTokenizer for unknown models", () => {
    const reg = new TokenizerRegistry();
    expect(reg.resolve("unknown-model-xyz")).toBeInstanceOf(HeuristicTokenizer);
  });

  it("later registration wins over earlier for same pattern", () => {
    const reg = new TokenizerRegistry();
    const custom: Tokenizer = {
      model: "custom",
      encode: () => [],
      countTokens: () => 999,
      countMessages: () => 999,
    };
    reg.register(/claude/i, (id) => new AnthropicTokenizer(id));
    reg.register(/claude-custom/i, custom);
    expect(reg.resolve("claude-custom").countTokens("hello")).toBe(999);
  });

  it("clear removes all registrations, falling back to heuristic", () => {
    const reg = new TokenizerRegistry();
    reg.register(/claude/i, (id) => new AnthropicTokenizer(id));
    reg.clear();
    expect(reg.resolve("claude-3-5-sonnet")).toBeInstanceOf(HeuristicTokenizer);
  });

  it("defaultTokenizerRegistry routes claude to AnthropicTokenizer", () => {
    expect(
      defaultTokenizerRegistry.resolve("claude-3-5-sonnet-20241022"),
    ).toBeInstanceOf(AnthropicTokenizer);
  });

  it("defaultTokenizerRegistry routes gpt-4 to TiktokenTokenizer", () => {
    expect(defaultTokenizerRegistry.resolve("gpt-4o")).toBeInstanceOf(
      TiktokenTokenizer,
    );
  });

  it("defaultTokenizerRegistry routes unknown model to HeuristicTokenizer", () => {
    expect(defaultTokenizerRegistry.resolve("mistral-7b")).toBeInstanceOf(
      HeuristicTokenizer,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. estimateTokens utility
// ---------------------------------------------------------------------------

describe("estimateTokens — context window budget calculation", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns a positive number for non-empty text", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
  });

  it("uses ceil(length/4) heuristic by default", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("handles a system prompt-length string", () => {
    const prompt =
      "You are a helpful assistant. Answer questions accurately.".repeat(3);
    const count = estimateTokens(prompt);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(prompt.length);
  });

  it("handles a 1000-char string (250 tokens via heuristic)", () => {
    const text = "a".repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });

  it("scales linearly: double text = double tokens (heuristic path)", () => {
    const text = "x".repeat(100);
    expect(estimateTokens(text.repeat(2))).toBe(estimateTokens(text) * 2);
  });

  it("accepts a model override without throwing", () => {
    expect(() => estimateTokens("hello", "claude-3-5-sonnet")).not.toThrow();
    expect(estimateTokens("hello", "claude-3-5-sonnet")).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Overflow detection — isContextLengthError
// ---------------------------------------------------------------------------

describe("isContextLengthError — overflow detection", () => {
  it("detects context_length_exceeded (OpenAI error code)", () => {
    expect(
      isContextLengthError(
        new Error("context_length_exceeded: too many tokens"),
      ),
    ).toBe(true);
  });

  it('detects "maximum context" phrase', () => {
    expect(
      isContextLengthError(
        new Error("This model has a maximum context of 128k tokens"),
      ),
    ).toBe(true);
  });

  it('detects "prompt is too long"', () => {
    expect(
      isContextLengthError(new Error("prompt is too long for this model")),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isContextLengthError(new Error("CONTEXT_LENGTH_EXCEEDED"))).toBe(
      true,
    );
    expect(isContextLengthError(new Error("Maximum Context of 200k"))).toBe(
      true,
    );
    expect(isContextLengthError(new Error("Prompt Is Too Long"))).toBe(true);
  });

  it("returns false for transient errors", () => {
    expect(isContextLengthError(new Error("429 too many requests"))).toBe(
      false,
    );
    expect(isContextLengthError(new Error("503 service unavailable"))).toBe(
      false,
    );
  });

  it("returns false for auth errors", () => {
    expect(
      isContextLengthError(new Error("401 unauthorized: invalid api key")),
    ).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(isContextLengthError(new Error("something went wrong"))).toBe(false);
  });

  it("handles non-Error thrown values", () => {
    expect(isContextLengthError("context_length_exceeded")).toBe(true);
    expect(isContextLengthError({ message: "other" })).toBe(false);
    expect(isContextLengthError(null)).toBe(false);
    expect(isContextLengthError(undefined)).toBe(false);
  });

  it("context length errors are NOT transient", () => {
    const ctxError = new Error("context_length_exceeded: too many tokens");
    expect(isContextLengthError(ctxError)).toBe(true);
    expect(isTransientError(ctxError)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Multi-turn accumulation — ConversationHistory helper
// ---------------------------------------------------------------------------

describe("Multi-turn accumulation — ConversationHistory", () => {
  let history: ConversationHistory;
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
    history = new ConversationHistory(tokenizer);
  });

  it("starts empty", () => {
    expect(history.size()).toBe(0);
    expect(history.totalTokens()).toBe(0);
    expect(history.getMessages()).toEqual([]);
  });

  it("accumulates messages across turns", () => {
    history.addMessage("user", "Turn 1 user message");
    history.addMessage("assistant", "Turn 1 assistant response");
    history.addMessage("user", "Turn 2 user message");
    history.addMessage("assistant", "Turn 2 assistant response");
    expect(history.size()).toBe(4);
  });

  it("total tokens increase monotonically as messages are added", () => {
    let prevTokens = 0;
    const messages = [
      "Hello",
      "How are you?",
      "I am doing well, thank you!",
      "Great!",
    ];
    for (const msg of messages) {
      history.addMessage("user", msg);
      const current = history.totalTokens();
      expect(current).toBeGreaterThan(prevTokens);
      prevTokens = current;
    }
  });

  it("clear resets to empty state", () => {
    history.addMessage("user", "hello");
    history.addMessage("assistant", "hi there");
    history.clear();
    expect(history.size()).toBe(0);
    expect(history.totalTokens()).toBe(0);
  });

  it("system prompt counts toward total tokens", () => {
    const systemOnly = new ConversationHistory(tokenizer);
    systemOnly.addMessage("system", "You are a helpful assistant.");

    const withUser = new ConversationHistory(tokenizer);
    withUser.addMessage("system", "You are a helpful assistant.");
    withUser.addMessage("user", "Hello!");

    expect(withUser.totalTokens()).toBeGreaterThan(systemOnly.totalTokens());
  });

  it("tool call results accumulate correctly", () => {
    history.addMessage("user", "Search for Paris");
    history.addMessage(
      "tool",
      JSON.stringify({ result: "Paris is in France" }),
    );
    history.addMessage("assistant", "Paris is the capital of France.");
    expect(history.size()).toBe(3);
    expect(history.totalTokens()).toBeGreaterThan(0);
  });

  it("getMessages returns a copy not the internal array", () => {
    history.addMessage("user", "test");
    const msgs = history.getMessages();
    msgs.push({ role: "extra", content: "injected" });
    expect(history.size()).toBe(1); // original unchanged
  });

  it("single message history", () => {
    history.addMessage("user", "Only message");
    expect(history.size()).toBe(1);
    expect(history.totalTokens()).toBe(
      tokenizer.countMessages(history.getMessages()),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Truncation strategies
// ---------------------------------------------------------------------------

describe("Truncation strategies — oldest-first", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("returns empty array for empty input", () => {
    expect(truncateOldestFirst([], 1000, tokenizer)).toEqual([]);
  });

  it("returns all messages when already within limit", () => {
    const messages = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ];
    const limit = 10_000;
    const result = truncateOldestFirst(messages, limit, tokenizer);
    expect(result).toHaveLength(messages.length);
  });

  it("drops oldest messages to fit within token limit", () => {
    const messages = [
      { role: "user", content: "a".repeat(100) }, // ~25 tokens
      { role: "assistant", content: "b".repeat(100) }, // ~25 tokens
      { role: "user", content: "c".repeat(100) }, // ~25 tokens
      { role: "assistant", content: "d".repeat(100) }, // ~25 tokens
    ];
    // Limit to ~30 tokens — should keep only the newest message(s)
    const result = truncateOldestFirst(messages, 30, tokenizer);
    expect(result.length).toBeLessThan(messages.length);
    // The newest message should be preserved
    expect(result[result.length - 1]!.content).toBe("d".repeat(100));
  });

  it("preserves system prompt by default", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "x".repeat(200) }, // ~50 tokens
      { role: "assistant", content: "y".repeat(200) }, // ~50 tokens
    ];
    // Very tight limit — should drop user/assistant but keep system
    const result = truncateOldestFirst(messages, 10, tokenizer);
    expect(result.some((m) => m.role === "system")).toBe(true);
  });

  it("does not drop system prompt when preserveSystemPrompt=true", () => {
    const messages = [
      { role: "system", content: "sys prompt here" },
      { role: "user", content: "a".repeat(400) },
    ];
    const result = truncateOldestFirst(messages, 5, tokenizer, true);
    // System prompt kept regardless
    expect(result.find((m) => m.role === "system")).toBeDefined();
  });

  it("result is always within the token limit (or as close as possible)", () => {
    const messages = [
      { role: "user", content: "msg1: " + "x".repeat(100) },
      { role: "assistant", content: "res1: " + "y".repeat(100) },
      { role: "user", content: "msg2: " + "x".repeat(100) },
      { role: "assistant", content: "res2: " + "y".repeat(100) },
      { role: "user", content: "msg3: " + "x".repeat(100) },
    ];
    const limit = 60;
    const result = truncateOldestFirst(messages, limit, tokenizer);
    const resultTokens = tokenizer.countMessages(result);
    expect(resultTokens).toBeLessThanOrEqual(limit);
  });

  it("handles single-message input", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = truncateOldestFirst(messages, 10_000, tokenizer);
    expect(result).toHaveLength(1);
  });
});

describe("Truncation strategies — sliding window", () => {
  it("returns all messages when count <= window size", () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    expect(truncateSlidingWindow(messages, 10)).toHaveLength(2);
  });

  it("returns the last N messages when count > window size", () => {
    const messages = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
      { role: "user", content: "5" },
    ];
    const result = truncateSlidingWindow(messages, 3);
    expect(result).toHaveLength(3);
    expect(result[0]!.content).toBe("3");
    expect(result[2]!.content).toBe("5");
  });

  it("returns empty array for empty input", () => {
    expect(truncateSlidingWindow([], 5)).toEqual([]);
  });

  it("returns single message when window=1", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "user", content: "last" },
    ];
    const result = truncateSlidingWindow(messages, 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("last");
  });

  it("exactly-at-window-size returns all messages unchanged", () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
    ];
    const result = truncateSlidingWindow(messages, 3);
    expect(result).toHaveLength(3);
    expect(result).toEqual(messages);
  });

  it("over-limit window size clips to message count", () => {
    const messages = [{ role: "user", content: "only" }];
    const result = truncateSlidingWindow(messages, 100);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Overflow detection helpers
// ---------------------------------------------------------------------------

describe("Overflow detection — isOverLimit / remainingBudget", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("isOverLimit returns false when messages fit within limit", () => {
    const messages = [{ role: "user", content: "hello" }];
    expect(isOverLimit(messages, 10_000, tokenizer)).toBe(false);
  });

  it("isOverLimit returns true when messages exceed limit", () => {
    const messages = [{ role: "user", content: "x".repeat(1000) }]; // 250 tokens
    expect(isOverLimit(messages, 100, tokenizer)).toBe(true);
  });

  it("isOverLimit returns false for exactly-at-limit", () => {
    // 'abcd' = 1 token with HeuristicTokenizer
    const messages = [{ role: "user", content: "abcd" }];
    expect(isOverLimit(messages, 1, tokenizer)).toBe(false);
  });

  it("isOverLimit returns false for empty messages", () => {
    expect(isOverLimit([], 100, tokenizer)).toBe(false);
  });

  it("remainingBudget returns the correct surplus tokens", () => {
    const messages = [{ role: "user", content: "abcd" }]; // 1 token
    expect(remainingBudget(messages, 100, tokenizer)).toBe(99);
  });

  it("remainingBudget returns 0 when at or over limit (clamps to 0)", () => {
    const messages = [{ role: "user", content: "x".repeat(1000) }]; // 250 tokens
    expect(remainingBudget(messages, 100, tokenizer)).toBe(0);
  });

  it("remainingBudget equals limit for empty messages", () => {
    expect(remainingBudget([], 500, tokenizer)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 10. Multi-turn accumulation — token budget tracking across turns
// ---------------------------------------------------------------------------

describe("Multi-turn accumulation — budget tracking", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("budget shrinks as messages are added", () => {
    const messages: Array<{ role: string; content: string }> = [];
    const limit = 10_000;

    const budgetsBefore: number[] = [];
    const budgetsAfter: number[] = [];

    for (let i = 0; i < 5; i++) {
      budgetsBefore.push(remainingBudget(messages, limit, tokenizer));
      messages.push({ role: "user", content: `Turn ${i + 1}: hello` });
      messages.push({ role: "assistant", content: `Turn ${i + 1}: hi` });
      budgetsAfter.push(remainingBudget(messages, limit, tokenizer));
    }

    for (let i = 0; i < 5; i++) {
      expect(budgetsAfter[i]).toBeLessThan(budgetsBefore[i]);
    }
  });

  it("does not exceed limit when sliding window is applied each turn", () => {
    const messages: Array<{ role: string; content: string }> = [];
    const windowSize = 4;
    const limit = 1_000;

    for (let i = 0; i < 20; i++) {
      messages.push({
        role: "user",
        content: `Message ${i}: ${"x".repeat(50)}`,
      });
      messages.push({
        role: "assistant",
        content: `Response ${i}: ${"y".repeat(50)}`,
      });
    }

    const windowed = truncateSlidingWindow(messages, windowSize);
    expect(isOverLimit(windowed, limit, tokenizer)).toBe(false);
  });

  it("conversation that fits in 200k context window (Claude claude-sonnet-4-6)", () => {
    const claudeLimit = 200_000;
    const messages: Array<{ role: string; content: string }> = [];

    // Simulate 100 turns with modest messages (~50 chars each)
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: "user",
        content: `Question ${i}: What is ${i}+${i}?`,
      });
      messages.push({ role: "assistant", content: `Answer: ${i * 2}` });
    }

    expect(isOverLimit(messages, claudeLimit, tokenizer)).toBe(false);
    expect(remainingBudget(messages, claudeLimit, tokenizer)).toBeGreaterThan(
      0,
    );
  });

  it("tool result messages count toward the window", () => {
    const messages: Array<{ role: string; content: string }> = [
      { role: "user", content: "Search for typescript tutorials" },
      {
        role: "tool",
        content: JSON.stringify({
          results: ["Result 1", "Result 2", "Result 3"],
        }),
      },
      {
        role: "assistant",
        content: "Here are the TypeScript tutorials I found.",
      },
    ];
    const tokensBefore = tokenizer.countMessages(messages.slice(0, 1));
    const tokensAfter = tokenizer.countMessages(messages);
    expect(tokensAfter).toBeGreaterThan(tokensBefore);
  });

  it("system prompt token overhead is stable across turns", () => {
    const systemMsg = {
      role: "system",
      content: "You are a helpful coding assistant.",
    };
    const sysTokens = tokenizer.countMessages([systemMsg]);

    const messages: Array<{ role: string; content: string }> = [systemMsg];

    // Add multiple turns
    messages.push({ role: "user", content: "Write a hello world" });
    messages.push({ role: "assistant", content: 'console.log("hello world")' });

    const allTokens = tokenizer.countMessages(messages);
    // System tokens should be a stable portion of total
    expect(sysTokens).toBeGreaterThan(0);
    expect(allTokens).toBeGreaterThan(sysTokens);
  });
});

// ---------------------------------------------------------------------------
// 11. Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases — context window boundaries", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("empty history: total tokens is 0", () => {
    expect(tokenizer.countMessages([])).toBe(0);
  });

  it("single user message: tokens counted correctly", () => {
    const msg = { role: "user", content: "abcd" };
    expect(tokenizer.countMessages([msg])).toBe(1);
  });

  it("exactly-at-limit: isOverLimit returns false", () => {
    // 'aaaa' is exactly 1 token
    const messages = [{ role: "user", content: "aaaa" }];
    expect(isOverLimit(messages, 1, tokenizer)).toBe(false);
  });

  it("one-over-limit: isOverLimit returns true", () => {
    // 'aaaaa' is 2 tokens (ceil(5/4))
    const messages = [{ role: "user", content: "aaaaa" }];
    expect(isOverLimit(messages, 1, tokenizer)).toBe(true);
  });

  it("truncation produces empty result when every message is too large", () => {
    // Even a single char is 1 token, but let's be safe
    const messages = [{ role: "user", content: "hello world" }];
    const result = truncateOldestFirst(messages, 0, tokenizer, false);
    expect(result).toHaveLength(0);
  });

  it("sliding window of 0 returns empty", () => {
    const messages = [{ role: "user", content: "hello" }];
    expect(truncateSlidingWindow(messages, 0)).toEqual([]);
  });

  it("handles very large content (10k chars) without throwing", () => {
    const bigMsg = { role: "user", content: "a".repeat(10_000) };
    expect(() => tokenizer.countMessages([bigMsg])).not.toThrow();
    expect(tokenizer.countMessages([bigMsg])).toBe(2500);
  });

  it("handles message with newlines and special characters", () => {
    const msg = { role: "user", content: "Line1\nLine2\tTabbed\r\nWindows" };
    expect(tokenizer.countTokens(msg.content)).toBe(
      Math.ceil(msg.content.length / 4),
    );
  });

  it("handles message content that is an empty JSON object", () => {
    const msg = { content: {} };
    expect(tokenizer.countMessages([msg])).toBe(
      tokenizer.countTokens(JSON.stringify({})),
    );
  });

  it("truncateOldestFirst with exactly 1 message that fits returns it unchanged", () => {
    const messages = [{ role: "user", content: "x" }];
    const result = truncateOldestFirst(messages, 10_000, tokenizer);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// 12. Configuration — model context windows in ModelRegistry
// ---------------------------------------------------------------------------

describe("ModelRegistry — context window configuration", () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registry = new ModelRegistry().setFactory(stubFactory);
  });

  it("getSpec returns contextWindow when set on ModelSpec", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        models: {
          chat: {
            name: "claude-sonnet",
            maxTokens: 8192,
            contextWindow: 200_000,
          },
        },
      }),
    );
    const spec = registry.getSpec("chat");
    expect(spec?.contextWindow).toBe(200_000);
  });

  it("getModelWithFallback skips provider when contextWindow < minContextWindow", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: {
          chat: { name: "claude-haiku", maxTokens: 1024, contextWindow: 8_000 },
        },
      }),
    );

    expect(() =>
      registry.getModelWithFallback("chat", undefined, {
        minContextWindow: 100_000,
      }),
    ).toThrow(ForgeError);
  });

  it("getModelWithFallback selects provider when contextWindow >= minContextWindow", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        models: {
          chat: {
            name: "claude-sonnet",
            maxTokens: 8192,
            contextWindow: 200_000,
          },
        },
      }),
    );
    const { model } = registry.getModelWithFallback("chat", undefined, {
      minContextWindow: 100_000,
    });
    expect(model).toBeDefined();
  });

  it("getModelWithFallback does not skip provider with unknown contextWindow", () => {
    // No contextWindow set → treated as "unknown" (not insufficient)
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        models: {
          chat: { name: "claude-haiku", maxTokens: 1024 },
        },
      }),
    );
    const { model } = registry.getModelWithFallback("chat", undefined, {
      minContextWindow: 100_000,
    });
    expect(model).toBeDefined();
  });

  it("getModelWithFallback throws NO_CAPABLE_FALLBACK when all providers miss context requirement", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        models: {
          chat: { name: "claude-haiku", maxTokens: 1024, contextWindow: 4_096 },
        },
      }),
    );
    registry.addProvider(
      makeProvider({
        provider: "openai",
        priority: 2,
        models: {
          chat: { name: "gpt-4o-mini", maxTokens: 4096, contextWindow: 8_192 },
        },
      }),
    );

    let caught: ForgeError | undefined;
    try {
      registry.getModelWithFallback("chat", undefined, {
        minContextWindow: 200_000,
      });
    } catch (e) {
      caught = e as ForgeError;
    }
    expect(caught).toBeInstanceOf(ForgeError);
    expect((caught as ForgeError).code).toBe("NO_CAPABLE_FALLBACK");
  });

  it("fallback chain skips low-context provider and uses high-context one", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: {
          chat: { name: "claude-haiku", maxTokens: 1024, contextWindow: 4_096 },
        },
      }),
    );
    registry.addProvider(
      makeProvider({
        provider: "openai",
        priority: 2,
        models: {
          chat: { name: "gpt-4o", maxTokens: 8192, contextWindow: 128_000 },
        },
      }),
    );

    const { provider } = registry.getModelWithFallback("chat", undefined, {
      minContextWindow: 100_000,
    });
    expect(provider).toBe("openai");
  });

  it("getSpec returns null when no provider has the tier", () => {
    expect(registry.getSpec("chat")).toBeNull();
  });

  it("different tiers can have different context windows", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        models: {
          chat: {
            name: "claude-haiku",
            maxTokens: 1024,
            contextWindow: 48_000,
          },
          codegen: {
            name: "claude-sonnet",
            maxTokens: 8192,
            contextWindow: 200_000,
          },
        },
      }),
    );
    expect(registry.getSpec("chat")?.contextWindow).toBe(48_000);
    expect(registry.getSpec("codegen")?.contextWindow).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// 13. Integration: tokenizer + overflow + truncation + model spec
// ---------------------------------------------------------------------------

describe("Integration — context window pipeline", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("full pipeline: accumulate → detect overflow → truncate → verify fit", () => {
    const MODEL_CONTEXT_LIMIT = 200; // tokens (tiny limit for test speed)

    // Accumulate a long conversation
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "You are a helpful assistant." },
    ];
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: "user",
        content: `Question ${i}: ${"a".repeat(40)}`,
      });
      messages.push({
        role: "assistant",
        content: `Answer ${i}: ${"b".repeat(40)}`,
      });
    }

    // Detect overflow
    expect(isOverLimit(messages, MODEL_CONTEXT_LIMIT, tokenizer)).toBe(true);

    // Apply oldest-first truncation
    const truncated = truncateOldestFirst(
      messages,
      MODEL_CONTEXT_LIMIT,
      tokenizer,
    );

    // Should now fit
    expect(isOverLimit(truncated, MODEL_CONTEXT_LIMIT, tokenizer)).toBe(false);

    // System prompt should be preserved
    expect(truncated[0]!.role).toBe("system");
  });

  it("token budget shrinks after each round of messages are added to context", () => {
    const LIMIT = 10_000;
    const messages: Array<{ role: string; content: string }> = [];
    let prevBudget = LIMIT;

    for (let turn = 0; turn < 10; turn++) {
      messages.push({ role: "user", content: `Turn ${turn}: Hello assistant` });
      messages.push({ role: "assistant", content: `Turn ${turn}: Hello user` });
      const currentBudget = remainingBudget(messages, LIMIT, tokenizer);
      expect(currentBudget).toBeLessThan(prevBudget);
      prevBudget = currentBudget;
    }
  });

  it("sliding window keeps conversation within a fixed token budget", () => {
    const WINDOW = 6;
    const LIMIT = 10_000;
    const allMessages: Array<{ role: string; content: string }> = [];

    for (let i = 0; i < 50; i++) {
      allMessages.push({ role: "user", content: `msg ${i}` });
      allMessages.push({ role: "assistant", content: `reply ${i}` });
    }

    // Apply sliding window
    const windowed = truncateSlidingWindow(allMessages, WINDOW);
    expect(windowed.length).toBe(WINDOW);
    expect(isOverLimit(windowed, LIMIT, tokenizer)).toBe(false);
  });

  it("estimateTokens is consistent with countMessages for single-message arrays", () => {
    const text = "This is a test message for the context window";
    const direct = estimateTokens(text);
    const viaMsgs = tokenizer.countMessages([{ content: text }]);
    // Both use HeuristicTokenizer (char/4) — should be equal
    expect(direct).toBe(viaMsgs);
  });

  it("ForgeError CONTEXT_LENGTH_EXCEEDED is correctly identified as non-transient", () => {
    const error = new Error("CONTEXT_LENGTH_EXCEEDED: prompt is too long");
    expect(isContextLengthError(error)).toBe(true);
    expect(isTransientError(error)).toBe(false);
  });

  it("context length error detection works with multi-line error messages", () => {
    const error = new Error(
      [
        "Request failed",
        "Error code: context_length_exceeded",
        "Max context: 128000 tokens",
      ].join("\n"),
    );
    expect(isContextLengthError(error)).toBe(true);
  });

  it("model spec context window is used to guard getModelWithFallback requests", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = new ModelRegistry().setFactory(stubFactory);
    registry.addProvider({
      provider: "anthropic",
      apiKey: "test",
      priority: 1,
      models: {
        chat: {
          name: "claude-3-5-haiku",
          maxTokens: 1024,
          contextWindow: 200_000,
        },
      },
    });

    // A request requiring 100k context should succeed
    const { model } = registry.getModelWithFallback("chat", undefined, {
      minContextWindow: 100_000,
    });
    expect(model).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 14. extractTokenUsage — token tracking for context budget accounting
// ---------------------------------------------------------------------------

describe("extractTokenUsage — post-invocation context budget updates", () => {
  function makeAIMessage(overrides: {
    response_metadata?: Record<string, unknown>;
    usage_metadata?: Record<string, unknown>;
  }): AIMessage {
    const msg = new AIMessage("test");
    if (overrides.response_metadata) {
      (
        msg as AIMessage & { response_metadata: Record<string, unknown> }
      ).response_metadata = overrides.response_metadata;
    }
    if (overrides.usage_metadata) {
      (
        msg as AIMessage & { usage_metadata: Record<string, unknown> }
      ).usage_metadata = overrides.usage_metadata;
    }
    return msg;
  }

  it("returns inputTokens (prompt size = context consumed)", () => {
    const msg = makeAIMessage({
      usage_metadata: {
        input_tokens: 5000,
        output_tokens: 200,
        total_tokens: 5200,
      },
    });
    const usage = extractTokenUsage(msg);
    expect(usage.inputTokens).toBe(5000);
  });

  it("returns outputTokens (response size)", () => {
    const msg = makeAIMessage({
      usage_metadata: {
        input_tokens: 5000,
        output_tokens: 200,
        total_tokens: 5200,
      },
    });
    expect(extractTokenUsage(msg).outputTokens).toBe(200);
  });

  it("returns 0 tokens when no usage metadata present", () => {
    const msg = makeAIMessage({});
    const usage = extractTokenUsage(msg);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });

  it("large context usage (near model limit) is preserved correctly", () => {
    const msg = makeAIMessage({
      usage_metadata: { input_tokens: 199_500, output_tokens: 4096 },
    });
    const usage = extractTokenUsage(msg);
    expect(usage.inputTokens).toBe(199_500);
    expect(usage.outputTokens).toBe(4096);
  });
});
