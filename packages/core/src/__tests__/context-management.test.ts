/**
 * context-management.test.ts
 *
 * Comprehensive tests for context management covering:
 *  - Token counting accuracy
 *  - Window overflow detection
 *  - Truncation strategies: oldest-first, summary, priority-based
 *  - Priority assignment: system > user > tool results
 *  - Retention guarantee: system prompt never truncated
 *  - Incremental and batch message addition
 *  - Context snapshot (serialize/deserialize)
 *  - Token budget reserve for response generation
 *  - Configurable window size
 *  - Multi-turn preservation
 *  - Context reset
 *  - Overflow callback
 *
 * All tests are pure / deterministic — no live LLM calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HeuristicTokenizer } from "../llm/tokenizer.js";
import type { Tokenizer } from "../llm/tokenizer.js";

// ---------------------------------------------------------------------------
// Core data types
// ---------------------------------------------------------------------------

type MessageRole = "system" | "user" | "assistant" | "tool";

interface ContextMessage {
  role: MessageRole;
  content: string;
  priority?: number; // higher = more important; computed from role if absent
}

interface ContextSnapshot {
  messages: ContextMessage[];
  totalTokens: number;
  maxTokens: number;
  reserveTokens: number;
  truncationCount: number;
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

/** Default priority by role: system=3, assistant=2, user=1, tool=0 */
function defaultPriority(role: MessageRole): number {
  switch (role) {
    case "system":
      return 3;
    case "assistant":
      return 2;
    case "user":
      return 1;
    case "tool":
      return 0;
    default:
      return 1;
  }
}

function assignPriority(msg: ContextMessage): number {
  return msg.priority ?? defaultPriority(msg.role);
}

// ---------------------------------------------------------------------------
// ContextManager — the class under test (pure / deterministic)
// ---------------------------------------------------------------------------

class ContextManager {
  private messages: ContextMessage[] = [];
  private truncationCount = 0;
  private overflowCallbacks: Array<(truncated: ContextMessage[]) => void> = [];

  constructor(
    private readonly maxTokens: number,
    private readonly tokenizer: Tokenizer,
    private readonly reserveTokens = 0,
  ) {}

  get effectiveLimit(): number {
    return this.maxTokens - this.reserveTokens;
  }

  addMessage(msg: ContextMessage): void {
    this.messages.push(msg);
  }

  addMessages(msgs: ContextMessage[]): void {
    this.messages.push(...msgs);
  }

  getTotalTokens(): number {
    return this.tokenizer.countMessages(this.messages);
  }

  isOverflow(): boolean {
    return this.getTotalTokens() > this.effectiveLimit;
  }

  getMessages(): ContextMessage[] {
    return [...this.messages];
  }

  reset(): void {
    this.messages = [];
    this.truncationCount = 0;
  }

  getTruncationCount(): number {
    return this.truncationCount;
  }

  onOverflow(cb: (truncated: ContextMessage[]) => void): void {
    this.overflowCallbacks.push(cb);
  }

  snapshot(): ContextSnapshot {
    return {
      messages: this.messages.map((m) => ({ ...m })),
      totalTokens: this.getTotalTokens(),
      maxTokens: this.maxTokens,
      reserveTokens: this.reserveTokens,
      truncationCount: this.truncationCount,
    };
  }

  restoreSnapshot(snap: ContextSnapshot): void {
    this.messages = snap.messages.map((m) => ({ ...m }));
    this.truncationCount = snap.truncationCount;
  }

  remainingBudget(): number {
    return Math.max(0, this.effectiveLimit - this.getTotalTokens());
  }

  // --- Truncation strategies ---

  /**
   * Oldest-first: remove oldest non-system messages until within limit.
   * System messages are always preserved.
   */
  truncateOldestFirst(): ContextMessage[] {
    const systemMsgs = this.messages.filter((m) => m.role === "system");
    let rest = this.messages.filter((m) => m.role !== "system");
    const dropped: ContextMessage[] = [];

    while (
      rest.length > 0 &&
      this.tokenizer.countMessages([...systemMsgs, ...rest]) >
        this.effectiveLimit
    ) {
      dropped.push(rest.shift()!);
    }

    if (dropped.length > 0) {
      this.messages = [...systemMsgs, ...rest];
      this.truncationCount += dropped.length;
      this._fireOverflowCallbacks(dropped);
    }
    return dropped;
  }

  /**
   * Summary strategy: replace a group of oldest non-system messages with
   * a synthetic summary message.
   */
  truncateWithSummary(
    summarize: (msgs: ContextMessage[]) => ContextMessage,
    groupSize = 4,
  ): boolean {
    const systemMsgs = this.messages.filter((m) => m.role === "system");
    const rest = this.messages.filter((m) => m.role !== "system");

    if (rest.length < groupSize) return false;

    const toSummarize = rest.slice(0, groupSize);
    const remaining = rest.slice(groupSize);
    const summary = summarize(toSummarize);

    this.messages = [...systemMsgs, summary, ...remaining];
    this.truncationCount += groupSize;
    this._fireOverflowCallbacks(toSummarize);
    return true;
  }

  /**
   * Priority-based: remove lowest-priority messages first.
   * System messages (highest priority) are never removed.
   */
  truncateByPriority(): ContextMessage[] {
    const systemMsgs = this.messages.filter((m) => m.role === "system");
    let rest = this.messages.filter((m) => m.role !== "system");
    const dropped: ContextMessage[] = [];

    while (
      rest.length > 0 &&
      this.tokenizer.countMessages([...systemMsgs, ...rest]) >
        this.effectiveLimit
    ) {
      // Find index of lowest-priority message
      let lowestIdx = 0;
      let lowestPriority = assignPriority(rest[0]!);
      for (let i = 1; i < rest.length; i++) {
        const p = assignPriority(rest[i]!);
        if (p < lowestPriority) {
          lowestPriority = p;
          lowestIdx = i;
        }
      }
      dropped.push(...rest.splice(lowestIdx, 1));
    }

    if (dropped.length > 0) {
      this.messages = [...systemMsgs, ...rest];
      this.truncationCount += dropped.length;
      this._fireOverflowCallbacks(dropped);
    }
    return dropped;
  }

  private _fireOverflowCallbacks(truncated: ContextMessage[]): void {
    for (const cb of this.overflowCallbacks) {
      cb(truncated);
    }
  }

  /** Keep only the last N turns (2 msgs per turn). System messages are always kept. */
  keepRecentTurns(turns: number): void {
    const systemMsgs = this.messages.filter((m) => m.role === "system");
    const rest = this.messages.filter((m) => m.role !== "system");
    const keep = turns === 0 ? [] : rest.slice(-turns * 2);
    this.messages = [...systemMsgs, ...keep];
  }
}

// ---------------------------------------------------------------------------
// 1. Token counting accuracy
// ---------------------------------------------------------------------------

describe("ContextManager — token counting accuracy", () => {
  let tokenizer: HeuristicTokenizer;
  let cm: ContextManager;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
    cm = new ContextManager(10_000, tokenizer);
  });

  it("starts at 0 tokens with no messages", () => {
    expect(cm.getTotalTokens()).toBe(0);
  });

  it("counts tokens correctly for a system message", () => {
    const content = "You are a helpful assistant."; // 28 chars = 7 tokens
    cm.addMessage({ role: "system", content });
    expect(cm.getTotalTokens()).toBe(Math.ceil(content.length / 4));
  });

  it("counts tokens correctly for a user message", () => {
    const content = "What is the capital of France?"; // 30 chars
    cm.addMessage({ role: "user", content });
    expect(cm.getTotalTokens()).toBe(Math.ceil(content.length / 4));
  });

  it("counts tokens correctly for an assistant message", () => {
    const content = "The capital of France is Paris.";
    cm.addMessage({ role: "assistant", content });
    expect(cm.getTotalTokens()).toBe(Math.ceil(content.length / 4));
  });

  it("counts tokens correctly for a tool result message", () => {
    const content = JSON.stringify({ result: "Paris, France" });
    cm.addMessage({ role: "tool", content });
    expect(cm.getTotalTokens()).toBe(Math.ceil(content.length / 4));
  });

  it("accumulates token count across multiple messages", () => {
    const msgs: ContextMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    cm.addMessages(msgs);
    const expected = msgs.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0,
    );
    expect(cm.getTotalTokens()).toBe(expected);
  });

  it("empty content contributes 0 tokens", () => {
    cm.addMessage({ role: "user", content: "" });
    expect(cm.getTotalTokens()).toBe(0);
  });

  it("exactly 4 chars = exactly 1 token", () => {
    cm.addMessage({ role: "user", content: "abcd" });
    expect(cm.getTotalTokens()).toBe(1);
  });

  it("5 chars = 2 tokens (ceil)", () => {
    cm.addMessage({ role: "user", content: "abcde" });
    expect(cm.getTotalTokens()).toBe(2);
  });

  it("1000 chars = 250 tokens", () => {
    cm.addMessage({ role: "user", content: "a".repeat(1000) });
    expect(cm.getTotalTokens()).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// 2. Window overflow detection
// ---------------------------------------------------------------------------

describe("ContextManager — window overflow detection", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("isOverflow() returns false when within limit", () => {
    const cm = new ContextManager(1000, tokenizer);
    cm.addMessage({ role: "user", content: "hello" });
    expect(cm.isOverflow()).toBe(false);
  });

  it("isOverflow() returns true when messages exceed limit", () => {
    const cm = new ContextManager(5, tokenizer);
    // 'a'.repeat(100) = 25 tokens, limit is 5
    cm.addMessage({ role: "user", content: "a".repeat(100) });
    expect(cm.isOverflow()).toBe(true);
  });

  it("isOverflow() returns false at exactly-at-limit", () => {
    // 'abcd' = 1 token, limit = 1
    const cm = new ContextManager(1, tokenizer);
    cm.addMessage({ role: "user", content: "abcd" });
    expect(cm.isOverflow()).toBe(false);
  });

  it("isOverflow() respects reserveTokens in effective limit", () => {
    // limit=10, reserve=5 → effective=5; 8 tokens of content should overflow
    const cm = new ContextManager(10, tokenizer, 5);
    cm.addMessage({ role: "user", content: "a".repeat(32) }); // 8 tokens
    expect(cm.isOverflow()).toBe(true);
  });

  it("isOverflow() false when content fits within (maxTokens - reserveTokens)", () => {
    const cm = new ContextManager(20, tokenizer, 10); // effective=10
    cm.addMessage({ role: "user", content: "a".repeat(16) }); // 4 tokens — fits
    expect(cm.isOverflow()).toBe(false);
  });

  it("overflow is detected after adding messages incrementally", () => {
    const cm = new ContextManager(10, tokenizer);
    expect(cm.isOverflow()).toBe(false);
    cm.addMessage({ role: "user", content: "a".repeat(20) }); // 5 tokens
    expect(cm.isOverflow()).toBe(false);
    cm.addMessage({ role: "assistant", content: "b".repeat(28) }); // 7 tokens → total=12
    expect(cm.isOverflow()).toBe(true);
  });

  it("remainingBudget() returns correct surplus", () => {
    const cm = new ContextManager(100, tokenizer);
    cm.addMessage({ role: "user", content: "abcd" }); // 1 token
    expect(cm.remainingBudget()).toBe(99);
  });

  it("remainingBudget() clamps to 0 when over limit", () => {
    const cm = new ContextManager(5, tokenizer);
    cm.addMessage({ role: "user", content: "a".repeat(100) }); // 25 tokens
    expect(cm.remainingBudget()).toBe(0);
  });

  it("remainingBudget() equals maxTokens - reserveTokens when empty", () => {
    const cm = new ContextManager(100, tokenizer, 20);
    expect(cm.remainingBudget()).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// 3. Truncation strategy — oldest-first
// ---------------------------------------------------------------------------

describe("ContextManager — oldest-first truncation", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("returns empty dropped array when already within limit", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const dropped = cm.truncateOldestFirst();
    expect(dropped).toHaveLength(0);
    expect(cm.getMessages()).toHaveLength(2);
  });

  it("drops oldest non-system message when over limit", () => {
    const cm = new ContextManager(30, tokenizer); // tight
    cm.addMessages([
      { role: "user", content: "a".repeat(60) }, // 15 tokens — oldest
      { role: "assistant", content: "b".repeat(60) }, // 15 tokens
      { role: "user", content: "c".repeat(16) }, // 4 tokens — newest
    ]);
    const dropped = cm.truncateOldestFirst();
    expect(dropped.length).toBeGreaterThan(0);
    // Newest message should still be present
    const remaining = cm.getMessages();
    expect(remaining.some((m) => m.content === "c".repeat(16))).toBe(true);
  });

  it("system message is never dropped (retention guarantee)", () => {
    const cm = new ContextManager(5, tokenizer); // very tight
    cm.addMessages([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "a".repeat(100) },
    ]);
    cm.truncateOldestFirst();
    const remaining = cm.getMessages();
    expect(remaining.some((m) => m.role === "system")).toBe(true);
  });

  it("truncation count increments by number of dropped messages", () => {
    const cm = new ContextManager(20, tokenizer);
    cm.addMessages([
      { role: "user", content: "a".repeat(40) }, // 10 tokens
      { role: "user", content: "b".repeat(40) }, // 10 tokens
      { role: "user", content: "c".repeat(40) }, // 10 tokens
    ]);
    const before = cm.getTruncationCount();
    const dropped = cm.truncateOldestFirst();
    expect(cm.getTruncationCount()).toBe(before + dropped.length);
  });

  it("result is within limit after truncation", () => {
    const limit = 50;
    const cm = new ContextManager(limit, tokenizer);
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: "x".repeat(40) }); // 10 tokens each
    }
    cm.truncateOldestFirst();
    expect(cm.getTotalTokens()).toBeLessThanOrEqual(limit);
  });

  it("multiple system messages are all preserved", () => {
    const cm = new ContextManager(5, tokenizer);
    cm.addMessages([
      { role: "system", content: "System message 1." },
      { role: "system", content: "System message 2." },
      { role: "user", content: "a".repeat(200) },
    ]);
    cm.truncateOldestFirst();
    const remaining = cm.getMessages();
    const sysMsgs = remaining.filter((m) => m.role === "system");
    expect(sysMsgs).toHaveLength(2);
  });

  it("empty context manager truncation is a no-op", () => {
    const cm = new ContextManager(100, tokenizer);
    const dropped = cm.truncateOldestFirst();
    expect(dropped).toHaveLength(0);
    expect(cm.getMessages()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Truncation strategy — summary
// ---------------------------------------------------------------------------

describe("ContextManager — summary truncation", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("replaces a group of oldest messages with a summary", () => {
    const cm = new ContextManager(10_000, tokenizer);
    for (let i = 0; i < 6; i++) {
      cm.addMessage({ role: "user", content: `Message ${i}` });
    }
    const summarize = (msgs: ContextMessage[]): ContextMessage => ({
      role: "assistant",
      content: `[Summary of ${msgs.length} messages]`,
    });
    const applied = cm.truncateWithSummary(summarize, 4);
    expect(applied).toBe(true);
    // The 4 oldest replaced by 1 summary + 2 remaining
    expect(cm.getMessages()).toHaveLength(3);
  });

  it("summary message content is generated by the provided function", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
      { role: "assistant", content: "fourth" },
      { role: "user", content: "fifth" },
    ]);
    const summarize = (msgs: ContextMessage[]): ContextMessage => ({
      role: "assistant",
      content: `Summary of: ${msgs.map((m) => m.content).join(", ")}`,
    });
    cm.truncateWithSummary(summarize, 4);
    const msgs = cm.getMessages();
    expect(msgs[0]!.content).toContain("Summary of:");
    expect(msgs[0]!.content).toContain("first");
  });

  it("returns false when fewer messages than groupSize", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessages([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
    const applied = cm.truncateWithSummary(
      () => ({ role: "assistant", content: "sum" }),
      4,
    );
    expect(applied).toBe(false);
    expect(cm.getMessages()).toHaveLength(2);
  });

  it("system messages are preserved after summary truncation", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessages([
      { role: "system", content: "System context." },
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
      { role: "user", content: "msg5" },
    ]);
    const summarize = (): ContextMessage => ({
      role: "assistant",
      content: "[Summary]",
    });
    cm.truncateWithSummary(summarize, 4);
    const msgs = cm.getMessages();
    expect(msgs[0]!.role).toBe("system");
  });

  it("truncation count increases after summary", () => {
    const cm = new ContextManager(10_000, tokenizer);
    for (let i = 0; i < 6; i++) {
      cm.addMessage({ role: "user", content: `msg${i}` });
    }
    cm.truncateWithSummary(
      (): ContextMessage => ({ role: "assistant", content: "summary" }),
      4,
    );
    // 4 messages replaced → truncationCount = 4
    expect(cm.getTruncationCount()).toBe(4);
  });

  it("default groupSize is 4", () => {
    const cm = new ContextManager(10_000, tokenizer);
    for (let i = 0; i < 8; i++) {
      cm.addMessage({ role: "user", content: `msg${i}` });
    }
    cm.truncateWithSummary(
      (msgs): ContextMessage => ({
        role: "assistant",
        content: `summarized-${msgs.length}`,
      }),
    );
    // 8 messages - 4 replaced by 1 summary + 4 remaining = 5
    expect(cm.getMessages()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 5. Truncation strategy — priority-based
// ---------------------------------------------------------------------------

describe("ContextManager — priority-based truncation", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("removes tool results (priority 0) before user messages (priority 1)", () => {
    const limit = 30;
    const cm = new ContextManager(limit, tokenizer);
    cm.addMessages([
      { role: "tool", content: "a".repeat(40) }, // 10 tokens, priority 0
      { role: "user", content: "b".repeat(40) }, // 10 tokens, priority 1
      { role: "assistant", content: "c".repeat(40) }, // 10 tokens, priority 2
      { role: "user", content: "d".repeat(40) }, // 10 tokens — over limit
    ]);
    const dropped = cm.truncateByPriority();
    // Tool result should be dropped first
    expect(dropped.some((m) => m.role === "tool")).toBe(true);
  });

  it("system message is never dropped by priority truncation", () => {
    const cm = new ContextManager(5, tokenizer);
    cm.addMessages([
      { role: "system", content: "Important system instruction." },
      { role: "tool", content: "a".repeat(200) }, // large tool result
    ]);
    cm.truncateByPriority();
    const remaining = cm.getMessages();
    expect(remaining.some((m) => m.role === "system")).toBe(true);
  });

  it("user messages removed before assistant messages", () => {
    const limit = 25;
    const cm = new ContextManager(limit, tokenizer);
    cm.addMessages([
      { role: "user", content: "a".repeat(40) }, // 10 tokens, priority 1
      { role: "assistant", content: "b".repeat(40) }, // 10 tokens, priority 2
      { role: "user", content: "c".repeat(40) }, // 10 tokens — over limit
    ]);
    const dropped = cm.truncateByPriority();
    expect(dropped.some((m) => m.role === "user")).toBe(true);
  });

  it("custom priority overrides role-based default", () => {
    const limit = 20;
    const cm = new ContextManager(limit, tokenizer);
    cm.addMessages([
      { role: "user", content: "a".repeat(40), priority: 10 }, // forced high priority
      { role: "assistant", content: "b".repeat(40), priority: 0 }, // forced low priority
      { role: "user", content: "c".repeat(20) }, // causes overflow
    ]);
    const dropped = cm.truncateByPriority();
    // assistant (priority 0) should be dropped, not user (priority 10)
    expect(dropped.some((m) => m.role === "assistant")).toBe(true);
    expect(dropped.some((m) => m.content === "a".repeat(40))).toBe(false);
  });

  it("drops nothing when already within limit", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
    const dropped = cm.truncateByPriority();
    expect(dropped).toHaveLength(0);
  });

  it("result is within limit after priority truncation", () => {
    const limit = 40;
    const cm = new ContextManager(limit, tokenizer);
    for (let i = 0; i < 6; i++) {
      cm.addMessage({ role: "tool", content: "t".repeat(40) }); // 10 tokens each
    }
    cm.truncateByPriority();
    expect(cm.getTotalTokens()).toBeLessThanOrEqual(limit);
  });

  it("truncation count is updated after priority drops", () => {
    const limit = 10;
    const cm = new ContextManager(limit, tokenizer);
    cm.addMessages([
      { role: "tool", content: "a".repeat(40) }, // 10 tokens
      { role: "tool", content: "b".repeat(40) }, // 10 tokens — over
    ]);
    cm.truncateByPriority();
    expect(cm.getTruncationCount()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Priority assignment
// ---------------------------------------------------------------------------

describe("Priority assignment", () => {
  it("system messages have highest priority (3)", () => {
    const msg: ContextMessage = { role: "system", content: "sys" };
    expect(assignPriority(msg)).toBe(3);
  });

  it("assistant messages have priority 2", () => {
    const msg: ContextMessage = { role: "assistant", content: "hi" };
    expect(assignPriority(msg)).toBe(2);
  });

  it("user messages have priority 1", () => {
    const msg: ContextMessage = { role: "user", content: "hello" };
    expect(assignPriority(msg)).toBe(1);
  });

  it("tool result messages have lowest priority (0)", () => {
    const msg: ContextMessage = { role: "tool", content: "{}" };
    expect(assignPriority(msg)).toBe(0);
  });

  it("explicit priority overrides role default", () => {
    const msg: ContextMessage = { role: "tool", content: "{}", priority: 5 };
    expect(assignPriority(msg)).toBe(5);
  });

  it("explicit priority 0 on system message overrides to 0", () => {
    const msg: ContextMessage = {
      role: "system",
      content: "low-prio-sys",
      priority: 0,
    };
    expect(assignPriority(msg)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Retention guarantee — system prompt never truncated
// ---------------------------------------------------------------------------

describe("Retention guarantee — system prompt", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("system prompt survives oldest-first truncation regardless of window size", () => {
    // Tiny limit — even system alone doesn't fit, but it must survive
    const cm = new ContextManager(1, tokenizer);
    cm.addMessages([
      {
        role: "system",
        content: "You are a helpful assistant with many instructions.",
      },
      { role: "user", content: "a".repeat(500) },
    ]);
    cm.truncateOldestFirst();
    expect(cm.getMessages().some((m) => m.role === "system")).toBe(true);
  });

  it("system prompt survives priority-based truncation", () => {
    const cm = new ContextManager(1, tokenizer);
    cm.addMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "a".repeat(500) },
    ]);
    cm.truncateByPriority();
    expect(cm.getMessages().some((m) => m.role === "system")).toBe(true);
  });

  it("system prompt survives summary truncation", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessages([
      { role: "system", content: "System instructions." },
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
    ]);
    cm.truncateWithSummary(
      (): ContextMessage => ({ role: "assistant", content: "[summary]" }),
      4,
    );
    expect(cm.getMessages().some((m) => m.role === "system")).toBe(true);
  });

  it("system prompt token count is stable across truncation cycles", () => {
    const tokenizer2 = new HeuristicTokenizer();
    const sysContent = "You are a coding assistant.";
    const sysTokens = Math.ceil(sysContent.length / 4);
    const cm = new ContextManager(50, tokenizer2);
    cm.addMessage({ role: "system", content: sysContent });
    for (let i = 0; i < 5; i++) {
      cm.addMessage({ role: "user", content: "a".repeat(100) });
      cm.truncateOldestFirst();
    }
    const remaining = cm.getMessages();
    const sys = remaining.find((m) => m.role === "system");
    expect(sys).toBeDefined();
    expect(Math.ceil(sys!.content.length / 4)).toBe(sysTokens);
  });
});

// ---------------------------------------------------------------------------
// 8. Incremental addition — one-by-one token tracking
// ---------------------------------------------------------------------------

describe("ContextManager — incremental message addition", () => {
  let tokenizer: HeuristicTokenizer;
  let cm: ContextManager;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
    cm = new ContextManager(10_000, tokenizer);
  });

  it("token count increases with each added message", () => {
    let prev = 0;
    for (let i = 0; i < 5; i++) {
      cm.addMessage({ role: "user", content: `message ${i}` });
      const current = cm.getTotalTokens();
      expect(current).toBeGreaterThan(prev);
      prev = current;
    }
  });

  it("remainingBudget decreases with each added message", () => {
    let prev = cm.remainingBudget();
    for (let i = 0; i < 5; i++) {
      cm.addMessage({ role: "user", content: `message content ${i}` });
      const current = cm.remainingBudget();
      expect(current).toBeLessThan(prev);
      prev = current;
    }
  });

  it("message count matches number of addMessage calls", () => {
    for (let i = 0; i < 7; i++) {
      cm.addMessage({ role: "user", content: `msg ${i}` });
    }
    expect(cm.getMessages()).toHaveLength(7);
  });

  it("getMessages returns immutable copy — external mutation doesn't affect internal state", () => {
    cm.addMessage({ role: "user", content: "original" });
    const msgs = cm.getMessages();
    msgs.push({ role: "user", content: "injected" });
    expect(cm.getMessages()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Batch addition
// ---------------------------------------------------------------------------

describe("ContextManager — batch message addition", () => {
  let tokenizer: HeuristicTokenizer;
  let cm: ContextManager;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
    cm = new ContextManager(10_000, tokenizer);
  });

  it("addMessages adds all provided messages", () => {
    const batch: ContextMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    cm.addMessages(batch);
    expect(cm.getMessages()).toHaveLength(3);
  });

  it("token count after batch equals sum of individual tokens", () => {
    const msgs: ContextMessage[] = [
      { role: "user", content: "abcd" }, // 1 token
      { role: "assistant", content: "efgh" }, // 1 token
      { role: "user", content: "ijkl" }, // 1 token
    ];
    cm.addMessages(msgs);
    expect(cm.getTotalTokens()).toBe(3);
  });

  it("empty batch is a no-op", () => {
    cm.addMessage({ role: "user", content: "existing" });
    cm.addMessages([]);
    expect(cm.getMessages()).toHaveLength(1);
  });

  it("batch and incremental produce identical state", () => {
    const msgs: ContextMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const cmBatch = new ContextManager(10_000, tokenizer);
    cmBatch.addMessages(msgs);

    const cmIncremental = new ContextManager(10_000, tokenizer);
    for (const m of msgs) cmIncremental.addMessage(m);

    expect(cmBatch.getTotalTokens()).toBe(cmIncremental.getTotalTokens());
    expect(cmBatch.getMessages()).toEqual(cmIncremental.getMessages());
  });
});

// ---------------------------------------------------------------------------
// 10. Context snapshot — serialize/deserialize
// ---------------------------------------------------------------------------

describe("ContextManager — context snapshot", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("snapshot captures current messages", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
    const snap = cm.snapshot();
    expect(snap.messages).toHaveLength(2);
  });

  it("snapshot captures totalTokens", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessage({ role: "user", content: "abcd" }); // 1 token
    const snap = cm.snapshot();
    expect(snap.totalTokens).toBe(1);
  });

  it("snapshot captures maxTokens", () => {
    const cm = new ContextManager(5000, tokenizer);
    const snap = cm.snapshot();
    expect(snap.maxTokens).toBe(5000);
  });

  it("snapshot captures reserveTokens", () => {
    const cm = new ContextManager(1000, tokenizer, 200);
    const snap = cm.snapshot();
    expect(snap.reserveTokens).toBe(200);
  });

  it("snapshot captures truncationCount", () => {
    const cm = new ContextManager(10, tokenizer);
    cm.addMessages([
      { role: "user", content: "a".repeat(40) },
      { role: "user", content: "b".repeat(40) },
    ]);
    cm.truncateOldestFirst();
    const snap = cm.snapshot();
    expect(snap.truncationCount).toBeGreaterThan(0);
  });

  it("restoring snapshot restores messages", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessages([
      { role: "user", content: "original1" },
      { role: "assistant", content: "original2" },
    ]);
    const snap = cm.snapshot();
    cm.reset();
    cm.addMessage({ role: "user", content: "after reset" });
    cm.restoreSnapshot(snap);
    expect(cm.getMessages()).toHaveLength(2);
    expect(cm.getMessages()[0]!.content).toBe("original1");
  });

  it("snapshot is a deep copy — modifying it doesn't affect manager", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessage({ role: "user", content: "original" });
    const snap = cm.snapshot();
    snap.messages[0]!.content = "mutated";
    expect(cm.getMessages()[0]!.content).toBe("original");
  });

  it("snapshot roundtrip preserves all fields", () => {
    const cm = new ContextManager(2000, tokenizer, 100);
    cm.addMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hello", priority: 5 },
    ]);
    const snap = cm.snapshot();
    const cm2 = new ContextManager(2000, tokenizer, 100);
    cm2.restoreSnapshot(snap);
    expect(cm2.getTotalTokens()).toBe(cm.getTotalTokens());
    expect(cm2.getMessages()).toHaveLength(cm.getMessages().length);
  });
});

// ---------------------------------------------------------------------------
// 11. Token budget reserve
// ---------------------------------------------------------------------------

describe("ContextManager — token budget reserve", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("effectiveLimit = maxTokens - reserveTokens", () => {
    const cm = new ContextManager(1000, tokenizer, 256);
    expect(cm.effectiveLimit).toBe(744);
  });

  it("isOverflow uses effectiveLimit not maxTokens", () => {
    // max=100, reserve=80 → effective=20; 25 tokens → overflow
    const cm = new ContextManager(100, tokenizer, 80);
    cm.addMessage({ role: "user", content: "a".repeat(100) }); // 25 tokens
    expect(cm.isOverflow()).toBe(true);
  });

  it("remainingBudget reflects the reserve correctly", () => {
    const cm = new ContextManager(200, tokenizer, 50); // effective=150
    cm.addMessage({ role: "user", content: "a".repeat(40) }); // 10 tokens
    expect(cm.remainingBudget()).toBe(140);
  });

  it("zero reserve: effectiveLimit equals maxTokens", () => {
    const cm = new ContextManager(500, tokenizer, 0);
    expect(cm.effectiveLimit).toBe(500);
  });

  it("reserve of entire window: effective limit is 0", () => {
    const cm = new ContextManager(500, tokenizer, 500);
    expect(cm.effectiveLimit).toBe(0);
    cm.addMessage({ role: "user", content: "a" });
    expect(cm.isOverflow()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Configurable window size
// ---------------------------------------------------------------------------

describe("ContextManager — configurable window size", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("small window (64 tokens) correctly limits context", () => {
    const cm = new ContextManager(64, tokenizer);
    cm.addMessage({ role: "user", content: "a".repeat(300) }); // 75 tokens
    expect(cm.isOverflow()).toBe(true);
  });

  it("large window (200k tokens) accommodates a long conversation", () => {
    const cm = new ContextManager(200_000, tokenizer);
    for (let i = 0; i < 100; i++) {
      cm.addMessage({
        role: "user",
        content: `Question ${i}: ${"x".repeat(50)}`,
      });
      cm.addMessage({
        role: "assistant",
        content: `Answer ${i}: ${"y".repeat(50)}`,
      });
    }
    expect(cm.isOverflow()).toBe(false);
  });

  it("window of 1 token overflows immediately on any content", () => {
    const cm = new ContextManager(1, tokenizer);
    cm.addMessage({ role: "user", content: "hello" }); // 2 tokens
    expect(cm.isOverflow()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. Multi-turn preservation
// ---------------------------------------------------------------------------

describe("ContextManager — multi-turn preservation", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("keepRecentTurns preserves the last N turns", () => {
    const cm = new ContextManager(10_000, tokenizer);
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `User turn ${i}` });
      cm.addMessage({ role: "assistant", content: `Assistant turn ${i}` });
    }
    cm.keepRecentTurns(3);
    // 3 turns = 6 messages (non-system)
    const msgs = cm.getMessages().filter((m) => m.role !== "system");
    expect(msgs).toHaveLength(6);
  });

  it("keepRecentTurns preserves system messages", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessage({ role: "system", content: "System context." });
    for (let i = 0; i < 5; i++) {
      cm.addMessage({ role: "user", content: `User ${i}` });
      cm.addMessage({ role: "assistant", content: `Asst ${i}` });
    }
    cm.keepRecentTurns(2);
    expect(cm.getMessages().some((m) => m.role === "system")).toBe(true);
  });

  it("keepRecentTurns preserves the most recent content", () => {
    const cm = new ContextManager(10_000, tokenizer);
    for (let i = 0; i < 5; i++) {
      cm.addMessage({ role: "user", content: `turn-${i}` });
      cm.addMessage({ role: "assistant", content: `reply-${i}` });
    }
    cm.keepRecentTurns(2);
    const msgs = cm.getMessages().filter((m) => m.role !== "system");
    // Should contain turns 3 and 4 (last 2 turns)
    expect(msgs.some((m) => m.content === "turn-4")).toBe(true);
    expect(msgs.some((m) => m.content === "turn-3")).toBe(true);
    expect(msgs.some((m) => m.content === "turn-0")).toBe(false);
  });

  it("keepRecentTurns(0) keeps only system messages", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessage({ role: "system", content: "sys" });
    cm.addMessages([
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
    ]);
    cm.keepRecentTurns(0);
    const msgs = cm.getMessages();
    expect(msgs.every((m) => m.role === "system")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14. Context reset
// ---------------------------------------------------------------------------

describe("ContextManager — context reset", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("reset clears all messages", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
    cm.reset();
    expect(cm.getMessages()).toHaveLength(0);
  });

  it("reset brings totalTokens to 0", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessage({ role: "user", content: "a".repeat(100) });
    cm.reset();
    expect(cm.getTotalTokens()).toBe(0);
  });

  it("reset restores remainingBudget to effectiveLimit", () => {
    const cm = new ContextManager(500, tokenizer, 50); // effective=450
    cm.addMessage({ role: "user", content: "a".repeat(100) });
    cm.reset();
    expect(cm.remainingBudget()).toBe(450);
  });

  it("reset resets truncationCount to 0", () => {
    const cm = new ContextManager(10, tokenizer);
    cm.addMessages([
      { role: "user", content: "a".repeat(40) },
      { role: "user", content: "b".repeat(40) },
    ]);
    cm.truncateOldestFirst();
    expect(cm.getTruncationCount()).toBeGreaterThan(0);
    cm.reset();
    expect(cm.getTruncationCount()).toBe(0);
  });

  it("after reset manager accepts new messages normally", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessage({ role: "user", content: "before" });
    cm.reset();
    cm.addMessage({ role: "user", content: "after" });
    expect(cm.getMessages()).toHaveLength(1);
    expect(cm.getMessages()[0]!.content).toBe("after");
  });

  it("reset is idempotent — double reset is safe", () => {
    const cm = new ContextManager(10_000, tokenizer);
    cm.addMessage({ role: "user", content: "hello" });
    cm.reset();
    cm.reset();
    expect(cm.getMessages()).toHaveLength(0);
    expect(cm.getTotalTokens()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 15. Overflow callback
// ---------------------------------------------------------------------------

describe("ContextManager — overflow callback", () => {
  let tokenizer: HeuristicTokenizer;

  beforeEach(() => {
    tokenizer = new HeuristicTokenizer();
  });

  it("overflow callback is fired when truncation occurs (oldest-first)", () => {
    const cm = new ContextManager(10, tokenizer);
    const cb = vi.fn();
    cm.onOverflow(cb);
    cm.addMessages([
      { role: "user", content: "a".repeat(40) }, // 10 tokens
      { role: "user", content: "b".repeat(40) }, // 10 tokens — over
    ]);
    cm.truncateOldestFirst();
    expect(cb).toHaveBeenCalledOnce();
  });

  it("overflow callback receives the dropped messages", () => {
    const cm = new ContextManager(10, tokenizer);
    let droppedMsgs: ContextMessage[] = [];
    cm.onOverflow((msgs) => {
      droppedMsgs = msgs;
    });
    cm.addMessages([
      { role: "user", content: "a".repeat(40) }, // 10 tokens — dropped
      { role: "user", content: "b".repeat(40) }, // 10 tokens
    ]);
    cm.truncateOldestFirst();
    expect(droppedMsgs.length).toBeGreaterThan(0);
    expect(droppedMsgs[0]!.content).toBe("a".repeat(40));
  });

  it("overflow callback is not fired when no truncation needed", () => {
    const cm = new ContextManager(10_000, tokenizer);
    const cb = vi.fn();
    cm.onOverflow(cb);
    cm.addMessage({ role: "user", content: "hello" });
    cm.truncateOldestFirst();
    expect(cb).not.toHaveBeenCalled();
  });

  it("overflow callback is fired when priority truncation occurs", () => {
    const cm = new ContextManager(10, tokenizer);
    const cb = vi.fn();
    cm.onOverflow(cb);
    cm.addMessages([
      { role: "tool", content: "a".repeat(40) },
      { role: "user", content: "b".repeat(40) },
    ]);
    cm.truncateByPriority();
    expect(cb).toHaveBeenCalled();
  });

  it("overflow callback is fired during summary truncation", () => {
    const cm = new ContextManager(10_000, tokenizer);
    const cb = vi.fn();
    cm.onOverflow(cb);
    for (let i = 0; i < 6; i++) {
      cm.addMessage({ role: "user", content: `msg${i}` });
    }
    cm.truncateWithSummary(
      (): ContextMessage => ({ role: "assistant", content: "sum" }),
    );
    expect(cb).toHaveBeenCalledOnce();
  });

  it("multiple callbacks all receive the notification", () => {
    const cm = new ContextManager(10, tokenizer);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    cm.onOverflow(cb1);
    cm.onOverflow(cb2);
    cm.addMessages([
      { role: "user", content: "a".repeat(40) },
      { role: "user", content: "b".repeat(40) },
    ]);
    cm.truncateOldestFirst();
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("callback not fired on reset (reset is not a truncation event)", () => {
    const cm = new ContextManager(10_000, tokenizer);
    const cb = vi.fn();
    cm.onOverflow(cb);
    cm.addMessage({ role: "user", content: "hello" });
    cm.reset();
    expect(cb).not.toHaveBeenCalled();
  });
});
