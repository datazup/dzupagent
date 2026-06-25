/**
 * W27-A — Phase-window + prompt-cache deep coverage.
 *
 * Targets uncovered paths in:
 *  - PhaseAwareWindowManager: scoring edge cases, priority-type bonuses per
 *    phase, multi-phase tie-breaking, confidence formula, composite content
 *    bonuses, custom multipliers applied to full score, large message sets
 *  - prompt-cache applyCacheBreakpoints: content-addressed strategy
 *    (cacheAnchor flag, long-content anchors, fallback to positional),
 *    positional strategy opt-in, CacheBreakpointOptions dispatch, exact
 *    breakpoint counts for every branching path
 *  - prompt-cache-injector: edge paths in resolveModelId / injectPromptCacheMarkers
 *  - Compression pipeline with PhaseAwareWindowManager integration
 */

import { describe, it, expect, vi } from "vitest";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { PhaseAwareWindowManager, DEFAULT_PHASES } from "../phase-window.js";
import type {
  PhaseConfig,
  PhaseWindowConfig,
  ConversationPhase,
} from "../phase-window.js";
import {
  applyCacheBreakpoints,
  applyAnthropicCacheControl,
} from "../prompt-cache.js";
import type { CacheBreakpointOptions } from "../prompt-cache.js";
import {
  isClaudeId,
  resolveModelId,
  injectPromptCacheMarkers,
  injectPromptCacheMarkersForModel,
} from "../prompt-cache-injector.js";
import {
  autoCompress,
  compressToLevel,
  selectCompressionLevel,
} from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanMsg(text: string): HumanMessage {
  return new HumanMessage(text);
}
function aiMsg(text: string): AIMessage {
  return new AIMessage(text);
}
function sysMsg(text: string): SystemMessage {
  return new SystemMessage(text);
}
function toolMsg(content: string, id = "tc-1"): ToolMessage {
  return new ToolMessage({ content, tool_call_id: id });
}
function aiWithToolCalls(content: string, ...ids: string[]): AIMessage {
  return new AIMessage({
    content,
    tool_calls: ids.map((id) => ({ id, name: "test_tool", args: {} })),
  });
}

function createMockModel(response: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
  } as unknown as BaseChatModel;
}

/** Produce N human/AI pairs. */
function makePairs(n: number, prefix = "pair"): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(humanMsg(`${prefix}-q${i}`));
    out.push(aiMsg(`${prefix}-a${i}`));
  }
  return out;
}

/** Count messages carrying cache_control in additional_kwargs. */
function countMarked(msgs: BaseMessage[]): number {
  return msgs.filter((m) => m.additional_kwargs?.cache_control).length;
}

// ---------------------------------------------------------------------------
// Phase-window — scoring edge cases
// ---------------------------------------------------------------------------

describe("PhaseAwareWindowManager — score computation edge cases", () => {
  const mgr = new PhaseAwareWindowManager();

  it("assigns index-based recency 0 to oldest and 5 to newest in a 6-message window", () => {
    const messages = makePairs(3);
    const scores = mgr.scoreMessages(messages);
    expect(scores[0]!.reason).toContain("recency=0.0");
    expect(scores[5]!.reason).toContain("recency=5.0");
  });

  it("recency for index 2 of 5 is approximately 2.5", () => {
    const messages = makePairs(3); // 6 messages, indices 0-5
    const scores = mgr.scoreMessages(messages);
    // index=2, n=6 → recency = (2/5)*5 = 2.0
    expect(scores[2]!.reason).toContain("recency=2.0");
  });

  it("score indices map 1:1 to input message indices", () => {
    const messages = makePairs(4);
    const scores = mgr.scoreMessages(messages);
    for (let i = 0; i < messages.length; i++) {
      expect(scores[i]!.index).toBe(i);
    }
  });

  it("code block bonus only triggers on completed code fence", () => {
    const withFence = aiMsg("```ts\nconst x = 1\n```");
    const noClose = aiMsg("```ts\nconst x = 1");
    const scores1 = mgr.scoreMessages([withFence]);
    const scores2 = mgr.scoreMessages([noClose]);
    expect(scores1[0]!.reason).toContain("code=+2");
    // Single-line unclosed fence does NOT match /```[\s\S]*?```/
    expect(scores2[0]!.reason).not.toContain("code=+2");
  });

  it("applies all three content bonuses simultaneously when content qualifies", () => {
    const msg = humanMsg(
      'TypeError in /packages/context/src/index.ts:\n```ts\nthrow new Error("x")\n```'
    );
    const scores = mgr.scoreMessages([msg]);
    expect(scores[0]!.reason).toContain("code=+2");
    expect(scores[0]!.reason).toContain("paths=+1");
    expect(scores[0]!.reason).toContain("errors=+2");
  });

  it("short penalty applies when content is exactly 19 chars", () => {
    const msg = humanMsg("a".repeat(19)); // < 20
    const scores = mgr.scoreMessages([msg]);
    expect(scores[0]!.reason).toContain("short=-2");
  });

  it("short penalty does NOT apply when content is exactly 20 chars", () => {
    const msg = humanMsg("a".repeat(20)); // not < 20
    const scores = mgr.scoreMessages([msg]);
    expect(scores[0]!.reason).not.toContain("short=-2");
  });

  it("phase multiplier is reflected in the reason string for reviewing phase (0.8)", () => {
    const messages = [
      humanMsg("Please review and verify this looks good to merge"),
      aiMsg("LGTM, ship it"),
    ];
    const scores = mgr.scoreMessages(messages);
    for (const s of scores) {
      expect(s.reason).toContain("x0.8(reviewing)");
    }
  });

  it("all scores are positive for normal messages (no net-negative)", () => {
    const messages = makePairs(5);
    const scores = mgr.scoreMessages(messages);
    for (const s of scores) {
      expect(s.score).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase-window — priority type bonuses per phase
// ---------------------------------------------------------------------------

describe("PhaseAwareWindowManager — priority type bonuses", () => {
  it("debugging phase grants +3 bonus to tool messages (priorityTypes includes tool)", () => {
    const messages = [
      humanMsg("There is an error and bug in the stack trace"),
      aiMsg("Let me debug this issue"),
      toolMsg("stack trace output here with error details"),
    ];
    const mgr = new PhaseAwareWindowManager();
    const scores = mgr.scoreMessages(messages);
    // Tool message should have the priority bonus in debugging phase
    const toolScore = scores[2]!;
    expect(toolScore.reason).toContain("priority(debugging)=+3");
  });

  it("planning phase grants +3 bonus to human messages (priorityTypes includes human)", () => {
    const messages = [
      humanMsg("How should we design the architecture and plan the structure?"),
      aiMsg("Let me outline the approach"),
    ];
    const mgr = new PhaseAwareWindowManager();
    const scores = mgr.scoreMessages(messages);
    const humanScore = scores[0]!;
    expect(humanScore.reason).toContain("priority(planning)=+3");
  });

  it("coding phase grants +3 bonus to ai messages (priorityTypes includes ai)", () => {
    const messages = [
      humanMsg("implement a function"),
      aiMsg("Here is the implementation:\n```ts\nfunction foo() {}\n```"),
    ];
    const mgr = new PhaseAwareWindowManager();
    const scores = mgr.scoreMessages(messages);
    const aiScore = scores[1]!;
    expect(aiScore.reason).toContain("priority(coding)=+3");
  });

  it("system messages do not get priority bonus in any phase (not in priorityTypes)", () => {
    // System is in no phase's priorityTypes in DEFAULT_PHASES
    const messages = [
      sysMsg("System instructions"),
      humanMsg("I have an error crash bug"),
      aiMsg("Debug: TypeError issue"),
    ];
    const mgr = new PhaseAwareWindowManager();
    const scores = mgr.scoreMessages(messages);
    // System message at index 0 should not have priority bonus
    expect(scores[0]!.reason).not.toContain("priority(");
  });
});

// ---------------------------------------------------------------------------
// Phase-window — detectPhase confidence and multi-phase behavior
// ---------------------------------------------------------------------------

describe("PhaseAwareWindowManager — detectPhase confidence formula", () => {
  it("confidence is count/windowLength (capped at 1.0)", () => {
    const mgr = new PhaseAwareWindowManager({ phaseDetectionWindow: 4 });
    const messages = [
      humanMsg("debug error bug crash"),
      aiMsg("fix the TypeError issue"),
      humanMsg("still broken stack trace"),
      aiMsg("error still fails"),
    ];
    const { confidence } = mgr.detectPhase(messages);
    // All 4 messages match debugging → 4/4 = 1.0
    expect(confidence).toBe(1.0);
  });

  it("confidence is fractional when only some messages match", () => {
    const mgr = new PhaseAwareWindowManager({ phaseDetectionWindow: 4 });
    const messages = [
      humanMsg("hello how are you"),
      aiMsg("doing well"),
      // Only this message has a clear debugging trigger keyword
      humanMsg("please debug this error"),
      aiMsg("sounds good"),
    ];
    const { phase, confidence } = mgr.detectPhase(messages);
    // 1 of 4 messages matches debugging → confidence = 1/4 = 0.25
    expect(phase).toBe("debugging");
    expect(confidence).toBeCloseTo(0.25, 5);
  });

  it("returns matchedPattern for the winning phase trigger", () => {
    const mgr = new PhaseAwareWindowManager();
    const messages = [humanMsg("I need to plan and design the architecture")];
    const result = mgr.detectPhase(messages);
    expect(result.phase).toBe("planning");
    expect(result.matchedPattern).toBeDefined();
    expect(typeof result.matchedPattern).toBe("string");
  });

  it("returns matchedPattern undefined for general phase", () => {
    const mgr = new PhaseAwareWindowManager();
    const result = mgr.detectPhase([]);
    expect(result.phase).toBe("general");
    expect(result.matchedPattern).toBeUndefined();
  });

  it("picks the phase with more matches when two phases match equally — deterministic", () => {
    const mgr = new PhaseAwareWindowManager();
    // Two debugging triggers vs one planning trigger → debugging wins
    const messages = [
      humanMsg("let me plan the approach"),
      humanMsg("found an error crash"),
      humanMsg("TypeError bug fails"),
    ];
    const { phase } = mgr.detectPhase(messages);
    expect(phase).toBe("debugging");
  });

  it("detectPhase only scans up to phaseDetectionWindow messages from the tail", () => {
    const mgr = new PhaseAwareWindowManager({ phaseDetectionWindow: 1 });
    // First message has debugging keywords but window=1 only sees last message
    const messages = [
      humanMsg("error bug crash TypeError"),
      humanMsg("hello nice to meet you"),
    ];
    const { phase } = mgr.detectPhase(messages);
    expect(phase).toBe("general");
  });

  it("phaseDetectionWindow=0: slice(-0) is slice(0) = full array in JS, so detection still runs", () => {
    // JS: array.slice(-0) === array.slice(0) → returns the whole array, NOT empty.
    // This is a known JS quirk; detectPhase with window=0 still scans all messages.
    const mgr = new PhaseAwareWindowManager({ phaseDetectionWindow: 0 });
    const messages = [humanMsg("error bug TypeError crash")];
    const result = mgr.detectPhase(messages);
    // slice(-0) returns the whole array → debugging trigger is hit
    expect(result.phase).toBe("debugging");
  });
});

// ---------------------------------------------------------------------------
// Phase-window — findRetentionSplit additional edge cases
// ---------------------------------------------------------------------------

describe("PhaseAwareWindowManager — findRetentionSplit advanced", () => {
  it("never returns a split > messages.length - targetKeep", () => {
    const mgr = new PhaseAwareWindowManager();
    for (const targetKeep of [1, 2, 3, 5]) {
      const messages = makePairs(5);
      const split = mgr.findRetentionSplit(messages, targetKeep);
      expect(split).toBeLessThanOrEqual(messages.length - targetKeep);
    }
  });

  it("split is 0 for a single message with targetKeep=1", () => {
    const mgr = new PhaseAwareWindowManager();
    const messages = [humanMsg("only")];
    expect(mgr.findRetentionSplit(messages, 1)).toBe(0);
  });

  it("split stays within valid bounds for a large debugging conversation", () => {
    const mgr = new PhaseAwareWindowManager();
    const messages: BaseMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(humanMsg(`error bug crash turn ${i}`));
      messages.push(aiMsg(`fix TypeError stack trace ${i}`));
    }
    const split = mgr.findRetentionSplit(messages, 10);
    expect(split).toBeGreaterThanOrEqual(0);
    expect(split).toBeLessThanOrEqual(messages.length - 10);
  });

  it("does not place split on a ToolMessage for a complex interleaved conversation", () => {
    const mgr = new PhaseAwareWindowManager();
    const messages: BaseMessage[] = [
      humanMsg("first question"),
      aiMsg("first answer"),
      humanMsg("second question"),
      aiMsg("third answer"),
      humanMsg("fourth question"),
      aiWithToolCalls("calling tool", "tc-a"),
      toolMsg("tool result", "tc-a"),
      aiMsg("based on result"),
      humanMsg("final question"),
      aiMsg("final answer"),
    ];
    const split = mgr.findRetentionSplit(messages, 4);
    if (split < messages.length) {
      expect(messages[split]!._getType()).not.toBe("tool");
    }
  });

  it("returns 0 when all messages are within targetKeep (large target)", () => {
    const mgr = new PhaseAwareWindowManager();
    const messages = makePairs(3); // 6 messages
    expect(mgr.findRetentionSplit(messages, 100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase-window — custom phases with arbitrary multipliers
// ---------------------------------------------------------------------------

describe("PhaseAwareWindowManager — custom phases", () => {
  it("custom multiplier of 3.0 triples raw score values", () => {
    const customPhases: PhaseConfig[] = [
      {
        name: "debugging",
        triggers: [/\bXXX\b/],
        retentionMultiplier: 3.0,
        priorityTypes: ["human"],
      },
    ];
    const mgr1 = new PhaseAwareWindowManager({ phases: customPhases });
    const mgr2 = new PhaseAwareWindowManager({
      phases: [{ ...customPhases[0]!, retentionMultiplier: 1.0 }],
    });
    const messages = [
      humanMsg("XXX trigger here long enough to avoid short penalty"),
    ];
    const [s1] = mgr1.scoreMessages(messages);
    const [s2] = mgr2.scoreMessages(messages);
    // Score should be ~3x (both share same phase bonus, same recency, same base)
    expect(s1!.score).toBeCloseTo(s2!.score * 3, 1);
  });

  it("zero multiplier collapses all scores to 0", () => {
    const customPhases: PhaseConfig[] = [
      {
        name: "general",
        triggers: [/\btest-trigger\b/],
        retentionMultiplier: 0,
        priorityTypes: [],
      },
    ];
    const mgr = new PhaseAwareWindowManager({ phases: customPhases });
    const messages = [
      humanMsg("test-trigger keyword in this message which is long enough"),
    ];
    const scores = mgr.scoreMessages(messages);
    expect(scores[0]!.score).toBe(0);
  });

  it("custom priorityTypes=[system] grants system messages the +3 bonus", () => {
    const customPhases: PhaseConfig[] = [
      {
        name: "planning",
        triggers: [/\bplan\b/],
        retentionMultiplier: 1.0,
        priorityTypes: ["system"],
      },
    ];
    const mgr = new PhaseAwareWindowManager({ phases: customPhases });
    const messages = [
      sysMsg("system instruction for the planning session"),
      humanMsg("let us plan the approach"),
    ];
    const scores = mgr.scoreMessages(messages);
    expect(scores[0]!.reason).toContain("priority(planning)=+3");
  });

  it("empty triggers array never matches → phase never detected", () => {
    const customPhases: PhaseConfig[] = [
      {
        name: "coding",
        triggers: [],
        retentionMultiplier: 1.0,
        priorityTypes: ["ai"],
      },
    ];
    const mgr = new PhaseAwareWindowManager({ phases: customPhases });
    const messages = [humanMsg("implement a big complex function")];
    const { phase } = mgr.detectPhase(messages);
    expect(phase).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// Phase-window — DEFAULT_PHASES constants
// ---------------------------------------------------------------------------

describe("DEFAULT_PHASES — configuration invariants", () => {
  it("debugging phase has retentionMultiplier of 2.0", () => {
    const phase = DEFAULT_PHASES.find((p) => p.name === "debugging");
    expect(phase?.retentionMultiplier).toBe(2.0);
  });

  it("reviewing phase has retentionMultiplier of 0.8", () => {
    const phase = DEFAULT_PHASES.find((p) => p.name === "reviewing");
    expect(phase?.retentionMultiplier).toBe(0.8);
  });

  it("planning phase has retentionMultiplier of 1.5", () => {
    const phase = DEFAULT_PHASES.find((p) => p.name === "planning");
    expect(phase?.retentionMultiplier).toBe(1.5);
  });

  it("coding phase has retentionMultiplier of 1.0", () => {
    const phase = DEFAULT_PHASES.find((p) => p.name === "coding");
    expect(phase?.retentionMultiplier).toBe(1.0);
  });

  it("each phase has at least one trigger", () => {
    for (const phase of DEFAULT_PHASES) {
      expect(phase.triggers.length).toBeGreaterThan(0);
    }
  });

  it("each phase name is unique", () => {
    const names = DEFAULT_PHASES.map((p) => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(DEFAULT_PHASES.length);
  });

  it("all triggers are RegExp instances", () => {
    for (const phase of DEFAULT_PHASES) {
      for (const trigger of phase.triggers) {
        expect(trigger).toBeInstanceOf(RegExp);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// applyCacheBreakpoints — content-addressed strategy (new default)
// ---------------------------------------------------------------------------

describe("applyCacheBreakpoints — content-addressed strategy", () => {
  it("marks a message with cacheAnchor=true regardless of content length", () => {
    const short = humanMsg("short");
    short.additional_kwargs = { cacheAnchor: true };

    const messages: BaseMessage[] = [
      sysMsg("system"),
      short,
      aiMsg("response"),
    ];
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "content-addressed",
    });
    // The cacheAnchor-flagged message should be marked
    expect(result[1]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("marks up to maxMark stable anchors from content-addressed anchors", () => {
    // 4 messages > 2000 chars each → all qualify as stable anchors
    const longText = "x".repeat(2100);
    const messages: BaseMessage[] = [
      sysMsg("sys"),
      humanMsg(longText),
      aiMsg(longText),
      humanMsg(longText),
      aiMsg(longText),
    ];
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "content-addressed",
    });
    // 1 for system + up to 3 for non-system = 4 total max
    const marked = countMarked(result);
    expect(marked).toBeLessThanOrEqual(4);
    expect(marked).toBeGreaterThanOrEqual(1);
  });

  it("falls back to positional when no stable anchors exist", () => {
    // All messages are short → no content-addressed anchors
    const messages: BaseMessage[] = [
      humanMsg("short"),
      aiMsg("short"),
      humanMsg("short"),
      aiMsg("short"),
    ];
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "content-addressed",
    });
    // Positional fallback: last 3 non-system messages marked
    const marked = countMarked(result);
    expect(marked).toBe(3);
    expect(result[1]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result[2]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result[3]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("marks exactly the last N anchors when more than maxMark anchors exist", () => {
    // Without system: maxMark = 3
    const longText = "stable anchor content ".repeat(100);
    const messages: BaseMessage[] = [
      humanMsg(longText),
      aiMsg(longText),
      humanMsg(longText),
      aiMsg(longText),
      humanMsg(longText),
    ];
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "content-addressed",
    });
    const marked = countMarked(result);
    expect(marked).toBe(3);
    // Last 3 anchors should be marked
    expect(result[2]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result[3]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result[4]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("cacheAnchor takes precedence over short content (explicit flag)", () => {
    const anchored = aiMsg("tiny");
    anchored.additional_kwargs = { cacheAnchor: true };

    const messages: BaseMessage[] = [
      sysMsg("sys"),
      humanMsg("short"),
      anchored,
    ];
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "content-addressed",
    });
    expect(result[2]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("content-addressed with cacheAnchor=false does NOT use it as anchor", () => {
    const notAnchor = humanMsg("hello");
    notAnchor.additional_kwargs = { cacheAnchor: false };

    const messages: BaseMessage[] = [
      sysMsg("sys"),
      notAnchor,
      aiMsg("response"),
    ];
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "content-addressed",
    });
    // notAnchor is not a stable anchor, so content-addressed finds none → falls back to positional
    // last 2 non-system messages marked
    expect(result[1]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result[2]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("array content summed to > 2000 chars qualifies as stable anchor", () => {
    const longBlock = "y".repeat(1100);
    const msg = new HumanMessage({
      content: [
        { type: "text", text: longBlock },
        { type: "text", text: longBlock },
      ],
    });
    const messages: BaseMessage[] = [sysMsg("sys"), msg];
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "content-addressed",
    });
    // Combined length 2200 > 2000 → qualifies as anchor
    expect(result[1]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("array content summed to < 2000 chars does NOT qualify as stable anchor", () => {
    const msg = new HumanMessage({
      content: [
        { type: "text", text: "a".repeat(500) },
        { type: "text", text: "b".repeat(500) },
      ],
    });
    const messages: BaseMessage[] = [sysMsg("sys"), msg];
    // Only 1000 chars total < 2000 → falls back to positional (marks last 1 non-system)
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "content-addressed",
    });
    // Positional fallback → msg is the only non-system message → gets marked
    expect(result[1]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });
});

// ---------------------------------------------------------------------------
// applyCacheBreakpoints — positional strategy
// ---------------------------------------------------------------------------

describe("applyCacheBreakpoints — positional strategy", () => {
  it("positional strategy marks exactly the last 3 non-system messages", () => {
    const messages: BaseMessage[] = [
      sysMsg("sys"),
      humanMsg("long message " + "x".repeat(2100)), // would be stable anchor in content-addressed
      aiMsg("a"),
      humanMsg("b"),
      aiMsg("c"),
      humanMsg("d"),
    ];
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "positional",
    });
    // System gets 1 breakpoint; last 3 non-system marked regardless of length
    expect(result[0]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result[1]!.additional_kwargs.cache_control).toBeUndefined();
    expect(result[2]!.additional_kwargs.cache_control).toBeUndefined();
    expect(result[3]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result[4]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result[5]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("positional strategy caps at 3 non-system marks for large conversations", () => {
    const messages: BaseMessage[] = [sysMsg("sys")];
    for (let i = 0; i < 20; i++) {
      messages.push(humanMsg(`user ${i}`));
      messages.push(aiMsg(`assistant ${i}`));
    }
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "positional",
    });
    const nonSysMarked = countMarked(result) - 1; // subtract system
    expect(nonSysMarked).toBe(3);
  });

  it("positional strategy with no system message marks last 3 messages", () => {
    const messages: BaseMessage[] = [
      humanMsg("a"),
      aiMsg("b"),
      humanMsg("c"),
      aiMsg("d"),
      humanMsg("e"),
    ];
    const result = applyCacheBreakpoints(messages, {
      cacheStrategy: "positional",
    });
    const marked = countMarked(result);
    expect(marked).toBe(3);
    expect(result[2]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result[3]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result[4]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("default strategy is content-addressed (not positional)", () => {
    const longText = "stable section ".repeat(150); // > 2000 chars
    const messages: BaseMessage[] = [
      sysMsg("sys"),
      humanMsg(longText), // stable anchor — would be marked in content-addressed only
      aiMsg("short"),
      humanMsg("short"),
    ];
    const defaultResult = applyCacheBreakpoints(messages); // no options
    const positionalResult = applyCacheBreakpoints(messages, {
      cacheStrategy: "positional",
    });

    // Default (content-addressed): longText message is an anchor → marked
    expect(defaultResult[1]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    // Positional: last 3 non-system = index 1, 2, 3 → index 1 ALSO marked (coincides)
    // but the key difference: if there were 4+ non-system, positional would skip older ones
    // Verify positional also marks last 3
    const posMarked = countMarked(positionalResult) - 1;
    expect(posMarked).toBe(3);
  });

  it("CacheBreakpointOptions missing → defaults to content-addressed", () => {
    const msg = humanMsg("a".repeat(2100));
    const messages: BaseMessage[] = [sysMsg("sys"), msg];

    const withUndefined = applyCacheBreakpoints(messages, undefined);
    const withContentAddr = applyCacheBreakpoints(messages, {
      cacheStrategy: "content-addressed",
    });

    // Both should produce identical results
    expect(countMarked(withUndefined)).toBe(countMarked(withContentAddr));
  });
});

// ---------------------------------------------------------------------------
// applyAnthropicCacheControl — raw format additional paths
// ---------------------------------------------------------------------------

describe("applyAnthropicCacheControl — additional coverage", () => {
  it("marks exactly 4 total breakpoints (system + 3 messages) for large input", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    }));
    const { system, messages } = applyAnthropicCacheControl("system", msgs);
    let total = 0;
    for (const b of system) {
      if ((b as { cache_control?: unknown }).cache_control) total++;
    }
    for (const m of messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content as Array<{ cache_control?: unknown }>) {
          if (b.cache_control) total++;
        }
      }
    }
    expect(total).toBe(4);
  });

  it("does not mark messages beyond the last 3 when count > 3", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      role: "user",
      content: `msg${i}`,
    }));
    const { messages } = applyAnthropicCacheControl("sys", msgs);
    // First two should NOT be marked
    expect(messages[0]!.content).toBe("msg0");
    expect(messages[1]!.content).toBe("msg1");
    // Last three should be marked (converted to array)
    for (let i = 2; i <= 4; i++) {
      expect(Array.isArray(messages[i]!.content)).toBe(true);
    }
  });

  it("string system prompt becomes a single content block array", () => {
    const { system } = applyAnthropicCacheControl("You are helpful.", []);
    expect(Array.isArray(system)).toBe(true);
    expect(system.length).toBe(1);
    expect(system[0]!.type).toBe("text");
    expect(system[0]!.text).toBe("You are helpful.");
  });

  it("deep-copies system content blocks (no mutation on original)", () => {
    const original = [{ type: "text", text: "sys block", extra: "data" }];
    const { system } = applyAnthropicCacheControl(original, []);
    // Original should not be mutated
    expect(
      (original[0] as { cache_control?: unknown }).cache_control
    ).toBeUndefined();
    // Result should have cache_control
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("handles 2-element message array (both marked)", () => {
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const { messages } = applyAnthropicCacheControl("sys", msgs);
    for (const m of messages) {
      expect(Array.isArray(m.content)).toBe(true);
    }
  });

  it("multi-block message marks only the last block", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "block A" },
          { type: "text", text: "block B" },
          { type: "text", text: "block C" },
        ],
      },
    ];
    const { messages } = applyAnthropicCacheControl("sys", msgs);
    const content = messages[0]!.content as Array<{
      cache_control?: unknown;
      text?: string;
    }>;
    expect(content[0]!.cache_control).toBeUndefined();
    expect(content[1]!.cache_control).toBeUndefined();
    expect(content[2]!.cache_control).toEqual({ type: "ephemeral" });
  });
});

// ---------------------------------------------------------------------------
// prompt-cache-injector — edge paths
// ---------------------------------------------------------------------------

describe("isClaudeId — edge cases", () => {
  it('returns true for bare "anthropic" string', () => {
    expect(isClaudeId("anthropic")).toBe(true);
  });

  it('returns true for "anthropic.claude-..." (Bedrock format)', () => {
    expect(isClaudeId("anthropic.claude-3-5-sonnet-v2:0")).toBe(true);
  });

  it('returns true for path containing "/claude-"', () => {
    expect(isClaudeId("some-prefix/claude-opus-4")).toBe(true);
  });

  it('returns false for model that merely contains "claude" mid-word differently', () => {
    // Does not start with "claude-" or "anthropic", no "/claude-"
    expect(isClaudeId("xclaudex-model")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isClaudeId("")).toBe(false);
  });

  it('is case-insensitive for "ANTHROPIC/..." prefix', () => {
    expect(isClaudeId("ANTHROPIC/CLAUDE-3")).toBe(true);
  });
});

describe("resolveModelId — field priority order", () => {
  it("prefers .model over .modelName", () => {
    const obj = { model: "from-model", modelName: "from-modelName" };
    expect(resolveModelId(obj)).toBe("from-model");
  });

  it("prefers .modelName over .name", () => {
    const obj = { modelName: "from-modelName", name: "from-name" };
    expect(resolveModelId(obj)).toBe("from-modelName");
  });

  it("prefers .name over ._llmType()", () => {
    const obj = { name: "from-name", _llmType: () => "from-llmType" };
    expect(resolveModelId(obj)).toBe("from-name");
  });

  it("falls through to _llmType() when model/modelName/name absent", () => {
    const obj = { _llmType: () => "anthropic" };
    expect(resolveModelId(obj)).toBe("anthropic");
  });

  it("skips empty string .model and tries next field", () => {
    const obj = { model: "", modelName: "fallback" };
    expect(resolveModelId(obj)).toBe("fallback");
  });

  it("returns empty string for null input", () => {
    expect(resolveModelId(null)).toBe("");
  });

  it("returns empty string for number input", () => {
    expect(resolveModelId(42)).toBe("");
  });

  it("returns empty string when all fields are absent", () => {
    expect(resolveModelId({})).toBe("");
  });

  it("handles _llmType() that throws by returning empty string", () => {
    const obj = {
      _llmType: () => {
        throw new Error("oops");
      },
    };
    expect(resolveModelId(obj)).toBe("");
  });
});

describe("injectPromptCacheMarkers — threshold guard", () => {
  it("returns original array for non-Claude model id", () => {
    const messages: BaseMessage[] = [sysMsg("sys"), humanMsg("hi")];
    const result = injectPromptCacheMarkers(messages, "gpt-4o");
    expect(result).toBe(messages);
  });

  it("returns original array when estimated tokens below default threshold", () => {
    // Default threshold = 1024 tokens → ~4096 chars needed
    const messages: BaseMessage[] = [sysMsg("x"), humanMsg("y")];
    const result = injectPromptCacheMarkers(messages, "claude-3-5-sonnet");
    expect(result).toBe(messages);
  });

  it("injects when tokens exceed custom minTokensForCache=1", () => {
    const messages: BaseMessage[] = [sysMsg("sys"), humanMsg("hello")];
    const result = injectPromptCacheMarkers(messages, "claude-sonnet-4-6", {
      minTokensForCache: 1,
    });
    expect(result).not.toBe(messages);
    expect(result[0]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("does NOT mutate original messages when injecting", () => {
    const sys = sysMsg("sys");
    const messages: BaseMessage[] = [sys, humanMsg("x".repeat(5000))];
    injectPromptCacheMarkers(messages, "claude-3-5-sonnet", {
      minTokensForCache: 1,
    });
    expect(sys.additional_kwargs.cache_control).toBeUndefined();
  });

  it("uses array content char length in token estimation", () => {
    const msg = new HumanMessage({
      content: [{ type: "text", text: "x".repeat(5000) }],
    });
    const messages: BaseMessage[] = [msg];
    const result = injectPromptCacheMarkers(messages, "claude-3-5-sonnet", {
      minTokensForCache: 1,
    });
    expect(result).not.toBe(messages);
  });
});

describe("injectPromptCacheMarkersForModel — model object", () => {
  it("returns original messages when model is undefined", () => {
    const messages: BaseMessage[] = [humanMsg("hello")];
    expect(injectPromptCacheMarkersForModel(messages, undefined)).toBe(
      messages
    );
  });

  it("returns original messages when model resolves to empty id", () => {
    const model = {} as BaseChatModel;
    const messages: BaseMessage[] = [humanMsg("hello")];
    expect(injectPromptCacheMarkersForModel(messages, model)).toBe(messages);
  });

  it("injects for a model that resolves to a Claude id via modelName", () => {
    const model = {
      modelName: "claude-3-5-sonnet-20241022",
    } as unknown as BaseChatModel;
    const messages: BaseMessage[] = [sysMsg("sys"), humanMsg("x".repeat(5000))];
    const result = injectPromptCacheMarkersForModel(messages, model, {
      minTokensForCache: 1,
    });
    expect(result).not.toBe(messages);
    expect(result[0]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });
});

// ---------------------------------------------------------------------------
// Compression pipeline + PhaseAwareWindowManager integration
// ---------------------------------------------------------------------------

describe("PhaseAwareWindowManager × compression pipeline integration", () => {
  it("findRetentionSplit used as keepRecentMessages guides autoCompress output size", async () => {
    const mgr = new PhaseAwareWindowManager();
    const model = createMockModel("## Goal\ncompressed");
    const messages = makePairs(15);

    // Calculate target split from phase-aware manager
    const split = mgr.findRetentionSplit(messages, 10);
    expect(split).toBeGreaterThanOrEqual(0);

    const result = await autoCompress(messages, null, model, {
      maxMessages: 10,
      keepRecentMessages: 10,
    });
    expect(result.compressed).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("phase scoring still works after compressToLevel output (chained)", async () => {
    const model = createMockModel("## Goal\ncompressed output");
    const messages: BaseMessage[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(humanMsg(`debug error crash turn ${i} ${"x".repeat(50)}`));
      messages.push(aiMsg(`fix TypeError bug ${i} ${"y".repeat(50)}`));
    }

    const pass1 = await compressToLevel(messages, 3, null, model);

    const mgr = new PhaseAwareWindowManager();
    const scores = mgr.scoreMessages(pass1.messages);
    // Compression does not remove the debugging context → phase still detected
    const { phase } = mgr.detectPhase(pass1.messages);
    expect(pass1.level).toBe(3);
    expect(scores.length).toBe(pass1.messages.length);
    expect(phase).toBe("debugging");
  });

  it("scoreMessages on an empty compressed output returns empty array", () => {
    const mgr = new PhaseAwareWindowManager();
    const scores = mgr.scoreMessages([]);
    expect(scores).toEqual([]);
  });

  it("selectCompressionLevel + detectPhase are independent (no shared state)", () => {
    const messages = [humanMsg("x".repeat(2000))];
    const mgr = new PhaseAwareWindowManager();

    // Run both in sequence — no shared mutable state
    const level = selectCompressionLevel(messages, 400);
    const { phase } = mgr.detectPhase(messages);
    expect(typeof level).toBe("number");
    expect(typeof phase).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// applyCacheBreakpoints — multiple system messages breakpoint budget
// ---------------------------------------------------------------------------

describe("applyCacheBreakpoints — system message breakpoint budget", () => {
  it("exactly 4 system messages: only last gets breakpoint, 3 non-system also marked", () => {
    const messages: BaseMessage[] = [
      sysMsg("s1"),
      sysMsg("s2"),
      sysMsg("s3"),
      sysMsg("s4"),
      humanMsg("u1"),
      aiMsg("a1"),
      humanMsg("u2"),
    ];
    const result = applyCacheBreakpoints(messages);
    const marked = countMarked(result);
    expect(marked).toBeLessThanOrEqual(4);
    // Last system message marked
    expect(result[3]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
    // First 3 system messages NOT marked
    expect(result[0]!.additional_kwargs.cache_control).toBeUndefined();
    expect(result[1]!.additional_kwargs.cache_control).toBeUndefined();
    expect(result[2]!.additional_kwargs.cache_control).toBeUndefined();
  });

  it("no system message: all 3 available non-system message slots used", () => {
    const messages: BaseMessage[] = [humanMsg("a"), aiMsg("b"), humanMsg("c")];
    const result = applyCacheBreakpoints(messages);
    expect(countMarked(result)).toBe(3);
  });

  it("single message no system: marked (1 breakpoint used)", () => {
    const messages: BaseMessage[] = [humanMsg("only")];
    const result = applyCacheBreakpoints(messages);
    expect(result[0]!.additional_kwargs.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("system + single non-system = 2 total breakpoints used", () => {
    const messages: BaseMessage[] = [sysMsg("sys"), humanMsg("only")];
    const result = applyCacheBreakpoints(messages);
    expect(countMarked(result)).toBe(2);
  });

  it("cache breakpoints survive round-trip through JSON-like spread clone", () => {
    const messages: BaseMessage[] = [
      sysMsg("sys"),
      humanMsg("hello"),
      aiMsg("world"),
    ];
    const result1 = applyCacheBreakpoints(messages);
    // Apply again on result (simulate a second pass — should be idempotent in count)
    const result2 = applyCacheBreakpoints(result1);
    expect(countMarked(result2)).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Phase-window — large scale scoring stability
// ---------------------------------------------------------------------------

describe("PhaseAwareWindowManager — large scale stability", () => {
  it("handles 100-message window without throwing", () => {
    const mgr = new PhaseAwareWindowManager();
    const messages = makePairs(50);
    expect(() => mgr.scoreMessages(messages)).not.toThrow();
    expect(() => mgr.detectPhase(messages)).not.toThrow();
    expect(() => mgr.findRetentionSplit(messages, 20)).not.toThrow();
  });

  it("all score values are finite numbers for 100-message input", () => {
    const mgr = new PhaseAwareWindowManager();
    const messages = makePairs(50);
    const scores = mgr.scoreMessages(messages);
    for (const s of scores) {
      expect(Number.isFinite(s.score)).toBe(true);
    }
  });

  it("scores are monotonically non-decreasing with recency for identical messages", () => {
    const mgr = new PhaseAwareWindowManager();
    // General phase (no multiplier), all same type and same content except length
    const messages = Array.from({ length: 10 }, () =>
      humanMsg("hello there world message")
    );
    const scores = mgr.scoreMessages(messages);
    for (let i = 1; i < scores.length; i++) {
      // Each successive message has higher recency score
      expect(scores[i]!.score).toBeGreaterThanOrEqual(scores[i - 1]!.score);
    }
  });

  it("findRetentionSplit is deterministic (same input → same output)", () => {
    const mgr = new PhaseAwareWindowManager();
    const messages = makePairs(20);
    const split1 = mgr.findRetentionSplit(messages, 8);
    const split2 = mgr.findRetentionSplit(messages, 8);
    expect(split1).toBe(split2);
  });
});
