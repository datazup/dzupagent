/**
 * multi-turn-eval.test.ts — 70+ tests for multi-turn conversation evaluation
 *
 * Covers:
 *  A. Context fidelity across turns (does the evaluator detect when context is
 *     lost?)
 *  B. Turn-by-turn scoring (score each assistant turn independently)
 *  C. Conversation-level scoring (aggregate score across all turns)
 *  D. Detecting topic drift between turns
 *  E. Reference-turn comparison (compare turn N to an expected reference)
 *  F. Handling of long conversations (10+ turns)
 *  G. Edge cases: empty turns, repeated user messages, single-turn
 *     conversations
 *
 * No real LLM calls — all judge/scorer invocations use vi.fn() mocks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeterministicScorer } from "../deterministic-scorer.js";
import { LLMJudgeScorer } from "../llm-judge-scorer.js";
import { CompositeScorer } from "../composite-scorer.js";
import { runEvalSuite } from "../eval-runner.js";
import type { EvalScorer, EvalResult, EvalSuite, EvalCase } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal conversation turn. */
interface ConvTurn {
  role: "user" | "assistant";
  content: string;
}

/** Serialise a conversation into the flat "input" string used by scorers. */
function serialiseConv(turns: ConvTurn[]): string {
  return turns.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n");
}

/** Build an EvalCase from a conversation + expected assistant output. */
function convCase(
  id: string,
  turns: ConvTurn[],
  expectedOutput?: string,
): EvalCase {
  return {
    id,
    input: serialiseConv(turns),
    expectedOutput,
  };
}

/** Mock LLM that always returns a passing JSON result. */
function mockPassingLLM(score = 0.9): (prompt: string) => Promise<string> {
  return vi
    .fn()
    .mockResolvedValue(
      JSON.stringify({ score, pass: true, reasoning: "looks good" }),
    );
}

/** Mock LLM that always returns a failing JSON result. */
function mockFailingLLM(score = 0.1): (prompt: string) => Promise<string> {
  return vi
    .fn()
    .mockResolvedValue(
      JSON.stringify({ score, pass: false, reasoning: "context lost" }),
    );
}

/** Mock LLM that throws on the first call, then passes. */
function mockFlakyLLM(): (prompt: string) => Promise<string> {
  let calls = 0;
  return vi.fn().mockImplementation(async () => {
    calls++;
    if (calls === 1) throw new Error("network error");
    return JSON.stringify({ score: 0.8, pass: true, reasoning: "ok" });
  });
}

/** Build a simple 3-turn conversation: user → assistant → user → assistant. */
function twoRoundConv(topic = "TypeScript"): ConvTurn[] {
  return [
    { role: "user", content: `Tell me about ${topic}` },
    {
      role: "assistant",
      content: `${topic} is a typed superset of JavaScript.`,
    },
    { role: "user", content: `What are its main benefits?` },
    {
      role: "assistant",
      content: `Type safety, better tooling, and refactoring support.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// A. Context fidelity across turns
// ---------------------------------------------------------------------------

describe("Context fidelity across turns", () => {
  it("passes when assistant references user context from a previous turn", async () => {
    const llm = mockPassingLLM(0.95);
    const scorer = new LLMJudgeScorer({ llm, rubric: "Context is preserved" });
    const turns = twoRoundConv();
    const result = await scorer.score(
      serialiseConv(turns),
      turns[3]!.content,
      turns[1]!.content,
    );
    expect(result.score).toBeGreaterThanOrEqual(0.5);
    expect(result.pass).toBe(true);
  });

  it("fails when assistant ignores prior user context", async () => {
    const llm = mockFailingLLM(0.1);
    const scorer = new LLMJudgeScorer({ llm, rubric: "Context is preserved" });
    const turns: ConvTurn[] = [
      { role: "user", content: "My name is Alice." },
      { role: "assistant", content: "Nice to meet you, Bob." },
    ];
    const result = await scorer.score(
      serialiseConv(turns),
      turns[1]!.content,
      "Alice",
    );
    expect(result.pass).toBe(false);
  });

  it("detects context loss via contains-mode scorer", async () => {
    const scorer = new DeterministicScorer({ mode: "contains" });
    // The output must contain the user's name to prove context fidelity
    const result = await scorer.score(
      "USER: My name is Alice.\nASSISTANT: Nice to meet you, Bob.",
      "Nice to meet you, Bob.",
      "Alice",
    );
    expect(result.pass).toBe(false);
  });

  it("detects preserved context via contains-mode scorer", async () => {
    const scorer = new DeterministicScorer({ mode: "contains" });
    const result = await scorer.score(
      "USER: My name is Alice.\nASSISTANT: Nice to meet you, Alice.",
      "Nice to meet you, Alice.",
      "Alice",
    );
    expect(result.pass).toBe(true);
  });

  it("LLM scorer is called with full conversation as input", async () => {
    const llm = mockPassingLLM();
    const scorer = new LLMJudgeScorer({ llm, rubric: "Context check" });
    const conv = serialiseConv(twoRoundConv());
    await scorer.score(
      conv,
      "Type safety, better tooling, and refactoring support.",
    );
    const [firstCall] = (llm as ReturnType<typeof vi.fn>).mock.calls;
    expect(firstCall![0]).toContain(
      "ASSISTANT: TypeScript is a typed superset of JavaScript.",
    );
  });

  it("multiple turns — intermediate context still scored correctly", async () => {
    const scorer = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    const turns: ConvTurn[] = [
      { role: "user", content: "Introduce project Delta." },
      {
        role: "assistant",
        content: "Project Delta is our new analytics platform.",
      },
      { role: "user", content: "What is the deadline?" },
      { role: "assistant", content: "Project Delta ships on March 1st." },
    ];
    const result = await scorer.score(
      serialiseConv(turns),
      turns[3]!.content,
      "project delta",
    );
    expect(result.pass).toBe(true);
  });

  it("context fidelity: suite-level with 3 cases", async () => {
    const scorer = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    const suite: EvalSuite = {
      name: "context-fidelity",
      cases: [
        convCase("c1", twoRoundConv(), "tooling"),
        convCase("c2", twoRoundConv("React"), "tooling"),
        convCase("c3", twoRoundConv("Node.js"), "tooling"),
      ],
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async (input) => {
      // Simply return the last assistant turn's content
      const lines = input.split("\n");
      return lines[lines.length - 1]!.replace("ASSISTANT: ", "");
    });
    expect(result.passRate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B. Turn-by-turn scoring
// ---------------------------------------------------------------------------

describe("Turn-by-turn scoring", () => {
  it("scores each assistant turn independently", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const turns: ConvTurn[] = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: "What is 3+3?" },
      { role: "assistant", content: "6" },
    ];

    const result1 = await scorer.score(
      turns[0]!.content,
      turns[1]!.content,
      "4",
    );
    const result2 = await scorer.score(
      turns[2]!.content,
      turns[3]!.content,
      "6",
    );

    expect(result1.pass).toBe(true);
    expect(result2.pass).toBe(true);
  });

  it("turn 1 fails, turn 2 passes independently", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const result1 = await scorer.score("q1", "wrong answer", "correct answer");
    const result2 = await scorer.score(
      "q2",
      "correct answer",
      "correct answer",
    );

    expect(result1.pass).toBe(false);
    expect(result2.pass).toBe(true);
  });

  it("builds per-turn eval suite from conversation", async () => {
    const conversation: Array<{ q: string; a: string; ref: string }> = [
      {
        q: "What is TypeScript?",
        a: "A typed language",
        ref: "A typed language",
      },
      { q: "Why use it?", a: "Type safety", ref: "Type safety" },
      { q: "What IDE?", a: "VSCode", ref: "VSCode" },
    ];

    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const suite: EvalSuite = {
      name: "per-turn",
      cases: conversation.map((t, i) => ({
        id: `turn-${i}`,
        input: t.q,
        expectedOutput: t.ref,
      })),
      scorers: [scorer],
    };

    const result = await runEvalSuite(suite, async (input) => {
      const match = conversation.find((t) => t.q === input);
      return match?.a ?? "";
    });

    expect(result.results).toHaveLength(3);
    result.results.forEach((r) => expect(r.pass).toBe(true));
  });

  it("per-turn LLM judge is called once per turn", async () => {
    const llm = mockPassingLLM();
    const scorer = new LLMJudgeScorer({
      llm,
      rubric: "Is the answer correct?",
    });
    const turns = ["q1", "q2", "q3"];

    for (const q of turns) {
      await scorer.score(q, "some answer", "expected answer");
    }

    expect((llm as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it("per-turn scores are independent even with same scorer instance", async () => {
    const scorer = new DeterministicScorer({ mode: "contains" });
    const r1 = await scorer.score("i", "hello world", "hello");
    const r2 = await scorer.score("i", "goodbye world", "hello");
    expect(r1.pass).toBe(true);
    expect(r2.pass).toBe(false);
  });

  it("scores last turn only via single-case suite", async () => {
    const turns = twoRoundConv();
    const lastAssistant = turns[turns.length - 1]!.content;
    const scorer = new DeterministicScorer({ mode: "contains" });
    const suite: EvalSuite = {
      name: "last-turn",
      cases: [
        { id: "t1", input: serialiseConv(turns), expectedOutput: "tooling" },
      ],
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async () => lastAssistant);
    expect(result.results[0]!.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. Conversation-level scoring (aggregate across turns)
// ---------------------------------------------------------------------------

describe("Conversation-level scoring", () => {
  it("aggregate score is average of all turn scores", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const suite: EvalSuite = {
      name: "agg",
      cases: [
        { id: "t1", input: "q", expectedOutput: "correct" },
        { id: "t2", input: "q", expectedOutput: "correct" },
        { id: "t3", input: "q", expectedOutput: "wrong" },
      ],
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async () => "correct");
    // t1: 1.0, t2: 1.0, t3: 0.0 → avg 0.667
    expect(result.aggregateScore).toBeCloseTo(2 / 3, 5);
    expect(result.passRate).toBeCloseTo(2 / 3, 5);
  });

  it("conversation passes when all turns exceed threshold", async () => {
    const llm = mockPassingLLM(0.9);
    const scorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
    const suite: EvalSuite = {
      name: "all-pass",
      passThreshold: 0.7,
      cases: [
        { id: "t1", input: "turn1", expectedOutput: "ref1" },
        { id: "t2", input: "turn2", expectedOutput: "ref2" },
      ],
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async () => "great response");
    expect(result.passRate).toBe(1);
    expect(result.aggregateScore).toBeCloseTo(0.9, 5);
  });

  it("conversation fails when most turns are below threshold", async () => {
    const llm = mockFailingLLM(0.2);
    const scorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
    const suite: EvalSuite = {
      name: "most-fail",
      passThreshold: 0.7,
      cases: Array.from({ length: 4 }, (_, i) => ({
        id: `t${i}`,
        input: `q${i}`,
      })),
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async () => "bad response");
    expect(result.passRate).toBe(0);
    expect(result.aggregateScore).toBeCloseTo(0.2, 5);
  });

  it("conversation aggregate with mixed pass/fail turns", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const suite: EvalSuite = {
      name: "mixed",
      passThreshold: 0.5,
      cases: [
        { id: "t1", input: "a", expectedOutput: "a" },
        { id: "t2", input: "b", expectedOutput: "b" },
        { id: "t3", input: "c", expectedOutput: "X" },
        { id: "t4", input: "d", expectedOutput: "X" },
      ],
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async (input) => input);
    // t1, t2 pass; t3, t4 fail → passRate 0.5
    expect(result.passRate).toBe(0.5);
  });

  it("conversation-level scoring uses all scorers weighted equally by default", async () => {
    const scorer1 = new DeterministicScorer({ name: "s1", mode: "exactMatch" });
    const scorer2 = new DeterministicScorer({ name: "s2", mode: "contains" });
    const suite: EvalSuite = {
      name: "multi-scorer-agg",
      passThreshold: 0.5,
      cases: [{ id: "t1", input: "hello world", expectedOutput: "hello" }],
      scorers: [scorer1, scorer2],
    };
    const result = await runEvalSuite(suite, async () => "hello world");
    // exactMatch: 0.0 (not exact), contains: 1.0 → avg 0.5
    expect(result.aggregateScore).toBe(0.5);
  });

  it("composite scorer aggregates sub-scorers into single conversation score", async () => {
    const s1 = new DeterministicScorer({ mode: "contains" });
    const s2 = new DeterministicScorer({ mode: "exactMatch" });
    const composite = new CompositeScorer({
      name: "composite",
      scorers: [
        { scorer: s1, weight: 0.6 },
        { scorer: s2, weight: 0.4 },
      ],
    });
    const result = await composite.score("input", "hello world", "hello");
    // s1 (contains 'hello'): 1.0 * 0.6 + s2 (not exact): 0.0 * 0.4 = 0.6
    expect(result.score).toBeCloseTo(0.6, 5);
  });
});

// ---------------------------------------------------------------------------
// D. Topic drift detection
// ---------------------------------------------------------------------------

describe("Topic drift detection", () => {
  it("detects drift when assistant output lacks expected topic keyword", async () => {
    const scorer = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    // Conversation starts with TypeScript but drifts to cooking
    const turns: ConvTurn[] = [
      { role: "user", content: "Tell me about TypeScript generics." },
      {
        role: "assistant",
        content: "Sure! Here is how to make pasta carbonara...",
      },
    ];
    const result = await scorer.score(
      serialiseConv(turns),
      turns[1]!.content,
      "typescript",
    );
    expect(result.pass).toBe(false);
  });

  it("no drift: assistant stays on topic", async () => {
    const scorer = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    const turns: ConvTurn[] = [
      { role: "user", content: "Explain React hooks." },
      {
        role: "assistant",
        content: "React hooks let you use state in functional components.",
      },
    ];
    const result = await scorer.score(
      serialiseConv(turns),
      turns[1]!.content,
      "react",
    );
    expect(result.pass).toBe(true);
  });

  it("LLM judge called to assess drift across turns", async () => {
    const llm = mockFailingLLM(0.1); // signals drift
    const scorer = new LLMJudgeScorer({
      llm,
      rubric: "Is the assistant staying on the original topic?",
    });
    const driftedConv = serialiseConv([
      { role: "user", content: "Discuss distributed systems." },
      { role: "assistant", content: "I prefer to talk about recipes." },
    ]);
    const result = await scorer.score(
      driftedConv,
      "I prefer to talk about recipes.",
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBeLessThan(0.5);
  });

  it("drift suite: flags all drifted turns", async () => {
    const scorer = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    const suite: EvalSuite = {
      name: "drift-detection",
      passThreshold: 0.5,
      cases: [
        { id: "on-topic", input: "q", expectedOutput: "typescript" },
        { id: "off-topic", input: "q", expectedOutput: "typescript" },
      ],
      scorers: [scorer],
    };
    let callIndex = 0;
    const result = await runEvalSuite(suite, async () => {
      callIndex++;
      return callIndex === 1
        ? "TypeScript generics are useful."
        : "Here is a recipe for pasta.";
    });
    expect(result.results[0]!.pass).toBe(true); // on-topic
    expect(result.results[1]!.pass).toBe(false); // drifted
  });

  it("regex scorer detects topic keyword presence", async () => {
    const scorer = new DeterministicScorer({
      mode: "regex",
      pattern: /typescript|ts\b/i,
    });
    const goodResult = await scorer.score(
      "q",
      "TypeScript generics are powerful.",
      undefined,
    );
    const badResult = await scorer.score(
      "q",
      "Python decorators are interesting.",
      undefined,
    );
    expect(goodResult.pass).toBe(true);
    expect(badResult.pass).toBe(false);
  });

  it("drift across 4 turns — only final turn drifts", async () => {
    const scorer = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    const suite: EvalSuite = {
      name: "multi-turn-drift",
      cases: [
        { id: "t1", input: "q", expectedOutput: "api" },
        { id: "t2", input: "q", expectedOutput: "api" },
        { id: "t3", input: "q", expectedOutput: "api" },
        { id: "t4", input: "q", expectedOutput: "api" }, // this will drift
      ],
      scorers: [scorer],
    };
    let idx = 0;
    const result = await runEvalSuite(suite, async () => {
      idx++;
      return idx < 4 ? "API endpoint is ready." : "The weather is nice today.";
    });
    expect(result.results.filter((r) => r.pass)).toHaveLength(3);
    expect(result.results[3]!.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E. Reference-turn comparison
// ---------------------------------------------------------------------------

describe("Reference-turn comparison", () => {
  it("turn N passes when its output matches reference exactly", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const reference = "The capital of France is Paris.";
    const result = await scorer.score(
      "What is the capital of France?",
      reference,
      reference,
    );
    expect(result.pass).toBe(true);
  });

  it("turn N fails when output deviates from reference", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const reference = "The capital of France is Paris.";
    const actualOutput = "Paris is the capital of France.";
    const result = await scorer.score(
      "What is the capital of France?",
      actualOutput,
      reference,
    );
    expect(result.pass).toBe(false);
  });

  it("contains-mode reference comparison is more lenient", async () => {
    const scorer = new DeterministicScorer({ mode: "contains" });
    const result = await scorer.score(
      "Name a city in France",
      "The city of Lyon is in France, and Paris too.",
      "Paris",
    );
    expect(result.pass).toBe(true);
  });

  it("LLM judge compares turn N to reference turn", async () => {
    const llm = mockPassingLLM(0.85);
    const scorer = new LLMJudgeScorer({
      llm,
      rubric: "Does the output match the reference?",
    });
    const reference = "Use dependency injection to improve testability.";
    const actual =
      "Dependency injection helps with testability and decoupling.";
    const result = await scorer.score(
      "How to improve code quality?",
      actual,
      reference,
    );
    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo(0.85, 2);
  });

  it("reference comparison in suite: 5 turns each compared to ref", async () => {
    const scorer = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    const suite: EvalSuite = {
      name: "ref-compare",
      cases: Array.from({ length: 5 }, (_, i) => ({
        id: `turn-${i}`,
        input: `question ${i}`,
        expectedOutput: `keyword${i}`,
      })),
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async (input) => {
      const idx = parseInt(input.replace("question ", ""), 10);
      return `The answer contains keyword${idx} here.`;
    });
    expect(result.passRate).toBe(1);
  });

  it("turn 0 reference comparison vs turn 2 reference comparison are independent", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const r0 = await scorer.score("q0", "answer-zero", "answer-zero");
    const r2 = await scorer.score("q2", "answer-two-wrong", "answer-two");
    expect(r0.pass).toBe(true);
    expect(r2.pass).toBe(false);
  });

  it("composite scorer reference comparison combines deterministic + LLM", async () => {
    const llm = mockPassingLLM(0.7);
    const det = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    const llmScorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
    const composite = new CompositeScorer({
      scorers: [
        { scorer: det, weight: 0.5 },
        { scorer: llmScorer, weight: 0.5 },
      ],
    });
    // contains 'Paris': score 1.0; LLM: 0.7 → weighted avg 0.85
    const result = await composite.score(
      "Capital of France?",
      "Paris is the capital of France.",
      "Paris",
    );
    expect(result.score).toBeCloseTo(0.85, 5);
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F. Long conversations (10+ turns)
// ---------------------------------------------------------------------------

describe("Long conversations (10+ turns)", () => {
  function buildLongConv(numRounds: number): ConvTurn[] {
    const turns: ConvTurn[] = [];
    for (let i = 0; i < numRounds; i++) {
      turns.push({ role: "user", content: `User message ${i}` });
      turns.push({ role: "assistant", content: `Assistant reply ${i}` });
    }
    return turns;
  }

  it("serialises a 10-round conversation without truncation", () => {
    const turns = buildLongConv(10);
    const serialised = serialiseConv(turns);
    expect(serialised.split("\n")).toHaveLength(20);
  });

  it("contains scorer evaluates last turn of 10-round conversation", async () => {
    const turns = buildLongConv(10);
    const lastAssistant = turns[turns.length - 1]!.content;
    const scorer = new DeterministicScorer({ mode: "contains" });
    const result = await scorer.score(
      serialiseConv(turns),
      lastAssistant,
      "reply 9",
    );
    expect(result.pass).toBe(true);
  });

  it("suite with 10 turn-cases all pass", async () => {
    const scorer = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    const suite: EvalSuite = {
      name: "long-conv-suite",
      cases: Array.from({ length: 10 }, (_, i) => ({
        id: `turn-${i}`,
        input: `User message ${i}`,
        expectedOutput: `reply ${i}`,
      })),
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async (input) => {
      const idx = parseInt(input.replace("User message ", ""), 10);
      return `Assistant reply ${idx}`;
    });
    expect(result.results).toHaveLength(10);
    expect(result.passRate).toBe(1);
  });

  it("suite with 15 turn-cases: last turn drifts", async () => {
    const scorer = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    const suite: EvalSuite = {
      name: "long-drift",
      cases: Array.from({ length: 15 }, (_, i) => ({
        id: `turn-${i}`,
        input: `q${i}`,
        expectedOutput: "topic",
      })),
      scorers: [scorer],
    };
    let idx = 0;
    const result = await runEvalSuite(suite, async () => {
      idx++;
      return idx <= 14 ? "on topic answer" : "completely different subject";
    });
    expect(result.results.filter((r) => r.pass)).toHaveLength(14);
    expect(result.results[14]!.pass).toBe(false);
  });

  it("LLM judge called once per turn in a 12-turn conversation", async () => {
    const llm = mockPassingLLM();
    const scorer = new LLMJudgeScorer({ llm, rubric: "quality" });
    const suite: EvalSuite = {
      name: "12-turn",
      cases: Array.from({ length: 12 }, (_, i) => ({
        id: `t${i}`,
        input: `q${i}`,
      })),
      scorers: [scorer],
    };
    await runEvalSuite(suite, async () => "fine answer");
    expect((llm as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(12);
  });

  it("aggregate score correct for 10-turn conversation with 2 failures", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const suite: EvalSuite = {
      name: "10-turn-two-fail",
      passThreshold: 0.5,
      cases: Array.from({ length: 10 }, (_, i) => ({
        id: `t${i}`,
        input: `q`,
        expectedOutput: i < 8 ? "correct" : "other",
      })),
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async () => "correct");
    expect(result.passRate).toBeCloseTo(0.8, 5);
    expect(result.aggregateScore).toBeCloseTo(0.8, 5);
  });

  it("very long output (5000+ chars) is scored without error", async () => {
    const longOutput = "word ".repeat(1000).trim();
    const scorer = new DeterministicScorer({ mode: "contains" });
    const result = await scorer.score("input", longOutput, "word");
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G. Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  describe("empty turns", () => {
    it("empty assistant output scores 0 with exactMatch", async () => {
      const scorer = new DeterministicScorer({ mode: "exactMatch" });
      const result = await scorer.score("user question", "", "expected answer");
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
    });

    it("empty assistant output with contains scorer fails", async () => {
      const scorer = new DeterministicScorer({ mode: "contains" });
      const result = await scorer.score("input", "", "expected");
      expect(result.pass).toBe(false);
    });

    it("empty reference with contains scorer fails gracefully", async () => {
      const scorer = new DeterministicScorer({ mode: "contains" });
      const result = await scorer.score("input", "some output", undefined);
      expect(result.pass).toBe(false);
    });

    it("empty user input does not crash LLM judge scorer", async () => {
      const llm = mockPassingLLM();
      const scorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
      const result = await scorer.score("", "some response", "reference");
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("pass");
    });

    it("whitespace-only output treated as empty by exactMatch", async () => {
      const scorer = new DeterministicScorer({ mode: "exactMatch" });
      const result = await scorer.score("q", "   ", "answer");
      expect(result.pass).toBe(false);
    });

    it("suite with one empty output case still returns result", async () => {
      const scorer = new DeterministicScorer({ mode: "exactMatch" });
      const suite: EvalSuite = {
        name: "empty-output",
        cases: [{ id: "e1", input: "q", expectedOutput: "answer" }],
        scorers: [scorer],
      };
      const result = await runEvalSuite(suite, async () => "");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.pass).toBe(false);
    });

    it("empty conversation serialises to empty string", () => {
      expect(serialiseConv([])).toBe("");
    });
  });

  describe("repeated user messages", () => {
    it("repeated user messages with distinct assistant replies score independently", async () => {
      const scorer = new DeterministicScorer({ mode: "exactMatch" });
      // Same question asked twice; different expected answers
      const r1 = await scorer.score("What time is it?", "10:00", "10:00");
      const r2 = await scorer.score("What time is it?", "10:05", "10:00"); // stale answer
      expect(r1.pass).toBe(true);
      expect(r2.pass).toBe(false);
    });

    it("suite correctly handles duplicate input strings", async () => {
      const scorer = new DeterministicScorer({ mode: "contains" });
      const suite: EvalSuite = {
        name: "dup-inputs",
        cases: [
          { id: "c1", input: "repeat", expectedOutput: "first" },
          { id: "c2", input: "repeat", expectedOutput: "second" },
        ],
        scorers: [scorer],
      };
      let callCount = 0;
      const result = await runEvalSuite(suite, async () => {
        callCount++;
        return callCount === 1 ? "first response" : "second response";
      });
      expect(result.results[0]!.pass).toBe(true);
      expect(result.results[1]!.pass).toBe(true);
    });

    it("LLM judge is called separately for each repeated user message", async () => {
      const llm = mockPassingLLM();
      const scorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
      await scorer.score("same question", "answer1");
      await scorer.score("same question", "answer2");
      expect((llm as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it("5 repeated questions all pass when answers correct", async () => {
      const scorer = new DeterministicScorer({ mode: "exactMatch" });
      const suite: EvalSuite = {
        name: "repeat5",
        cases: Array.from({ length: 5 }, (_, i) => ({
          id: `r${i}`,
          input: "same input",
          expectedOutput: "same output",
        })),
        scorers: [scorer],
      };
      const result = await runEvalSuite(suite, async () => "same output");
      expect(result.passRate).toBe(1);
    });
  });

  describe("single-turn conversations", () => {
    it("single turn passes with correct output", async () => {
      const scorer = new DeterministicScorer({ mode: "exactMatch" });
      const suite: EvalSuite = {
        name: "single",
        cases: [{ id: "s1", input: "q", expectedOutput: "a" }],
        scorers: [scorer],
      };
      const result = await runEvalSuite(suite, async () => "a");
      expect(result.passRate).toBe(1);
      expect(result.aggregateScore).toBe(1);
    });

    it("single turn fails with wrong output", async () => {
      const scorer = new DeterministicScorer({ mode: "exactMatch" });
      const suite: EvalSuite = {
        name: "single-fail",
        cases: [{ id: "s1", input: "q", expectedOutput: "a" }],
        scorers: [scorer],
      };
      const result = await runEvalSuite(suite, async () => "wrong");
      expect(result.passRate).toBe(0);
    });

    it("single-turn LLM judge: LLM called exactly once", async () => {
      const llm = mockPassingLLM();
      const scorer = new LLMJudgeScorer({ llm, rubric: "Correct?" });
      const suite: EvalSuite = {
        name: "single-llm",
        cases: [{ id: "s1", input: "q", expectedOutput: "a" }],
        scorers: [scorer],
      };
      await runEvalSuite(suite, async () => "great answer");
      expect((llm as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it("single-turn composite scorer combines both scores", async () => {
      const llm = mockPassingLLM(0.8);
      const det = new DeterministicScorer({
        mode: "contains",
        caseInsensitive: true,
      });
      const llmScorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
      const composite = new CompositeScorer({
        scorers: [
          { scorer: det, weight: 1 },
          { scorer: llmScorer, weight: 1 },
        ],
      });
      // det: contains 'Paris' → 1.0; llm: 0.8 → avg 0.9
      const result = await composite.score(
        "Capital?",
        "Paris is the capital.",
        "Paris",
      );
      expect(result.score).toBeCloseTo(0.9, 5);
    });

    it("single-turn result includes correct caseId", async () => {
      const scorer = new DeterministicScorer({ mode: "exactMatch" });
      const suite: EvalSuite = {
        name: "s",
        cases: [{ id: "unique-id-42", input: "q", expectedOutput: "a" }],
        scorers: [scorer],
      };
      const result = await runEvalSuite(suite, async () => "a");
      expect(result.results[0]!.caseId).toBe("unique-id-42");
    });
  });

  describe("LLM failure handling in multi-turn context", () => {
    it("LLM network failure returns score 0 and does not throw", async () => {
      const llm = vi.fn().mockRejectedValue(new Error("network error"));
      const scorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
      const result = await scorer.score("input", "output");
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain("LLM");
    });

    it("LLM non-JSON response returns score 0", async () => {
      const llm = vi.fn().mockResolvedValue("This is not JSON at all");
      const scorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
      const result = await scorer.score("input", "output");
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
    });

    it("remaining turns still evaluated when one LLM call fails", async () => {
      let callCount = 0;
      const llm = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error("fail");
        return JSON.stringify({ score: 0.9, pass: true, reasoning: "ok" });
      });
      const scorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
      const suite: EvalSuite = {
        name: "partial-fail",
        cases: [
          { id: "t1", input: "q1" },
          { id: "t2", input: "q2" },
          { id: "t3", input: "q3" },
        ],
        scorers: [scorer],
      };
      const result = await runEvalSuite(suite, async () => "answer");
      expect(result.results).toHaveLength(3);
      expect(result.results[0]!.scorerResults[0]!.result.pass).toBe(true);
      expect(result.results[1]!.scorerResults[0]!.result.pass).toBe(false); // failed call
      expect(result.results[2]!.scorerResults[0]!.result.pass).toBe(true);
    });

    it("flaky LLM does not propagate error to suite result", async () => {
      const llm = mockFlakyLLM();
      const scorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
      const suite: EvalSuite = {
        name: "flaky",
        cases: [
          { id: "t1", input: "q1" },
          { id: "t2", input: "q2" },
        ],
        scorers: [scorer],
      };
      const result = await runEvalSuite(suite, async () => "answer");
      // t1: flaky (fails) → score 0; t2: passes → score 0.8
      expect(result.results).toHaveLength(2);
      expect(result.results[0]!.pass).toBe(false);
      expect(result.results[1]!.pass).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// H. Multi-turn conversation as EvalSuite — end-to-end scenarios
// ---------------------------------------------------------------------------

describe("Multi-turn conversation end-to-end scenarios", () => {
  it("full Q&A conversation: 6 turns, all pass with contains scorer", async () => {
    const qa = [
      {
        q: "What is REST?",
        a: "REST is an architectural style for APIs.",
        kw: "rest",
      },
      {
        q: "What is HTTP?",
        a: "HTTP is the protocol for web communication.",
        kw: "http",
      },
      {
        q: "What is JSON?",
        a: "JSON is a lightweight data format.",
        kw: "json",
      },
      {
        q: "What is GraphQL?",
        a: "GraphQL is a query language for APIs.",
        kw: "graphql",
      },
      {
        q: "What is WebSocket?",
        a: "WebSocket enables full-duplex communication.",
        kw: "websocket",
      },
      {
        q: "What is gRPC?",
        a: "gRPC is a high-performance RPC framework.",
        kw: "grpc",
      },
    ];
    const scorer = new DeterministicScorer({
      mode: "contains",
      caseInsensitive: true,
    });
    const suite: EvalSuite = {
      name: "api-knowledge",
      cases: qa.map((item, i) => ({
        id: `t${i}`,
        input: item.q,
        expectedOutput: item.kw,
      })),
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async (input) => {
      const match = qa.find((item) => item.q === input);
      return match?.a ?? "";
    });
    expect(result.passRate).toBe(1);
    expect(result.aggregateScore).toBe(1);
  });

  it("conversation history included in judge prompt for context-aware scoring", async () => {
    const llm = mockPassingLLM();
    const scorer = new LLMJudgeScorer({
      llm,
      rubric: "Is the answer consistent with the prior conversation?",
    });

    const history = serialiseConv([
      { role: "user", content: "I work with TypeScript." },
      {
        role: "assistant",
        content: "Great! TypeScript is a wonderful language.",
      },
      { role: "user", content: "What should I learn next?" },
    ]);

    await scorer.score(history, "You might enjoy learning Rust next.");
    const prompt = (llm as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("You might enjoy learning Rust next.");
  });

  it("evaluation suite timestamps are ISO strings", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const suite: EvalSuite = {
      name: "ts-check",
      cases: [{ id: "t1", input: "q", expectedOutput: "a" }],
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async () => "a");
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("suiteId matches suite name", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const suite: EvalSuite = {
      name: "my-special-suite",
      cases: [{ id: "t1", input: "q", expectedOutput: "a" }],
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async () => "a");
    expect(result.suiteId).toBe("my-special-suite");
  });

  it("scorer reasoning is propagated to suite results", async () => {
    const scorer = new DeterministicScorer({ mode: "exactMatch" });
    const suite: EvalSuite = {
      name: "reasoning-check",
      cases: [{ id: "t1", input: "q", expectedOutput: "a" }],
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async () => "a");
    expect(result.results[0]!.scorerResults[0]!.result.reasoning).toBeTruthy();
  });

  it("custom passThreshold 0.9 rejects a 0.8 score", async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ score: 0.8, pass: true, reasoning: "ok" }),
      );
    const scorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
    const suite: EvalSuite = {
      name: "strict-threshold",
      passThreshold: 0.9,
      cases: [{ id: "t1", input: "q" }],
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async () => "answer");
    // LLM returns 0.8 but threshold is 0.9 → case-level pass = false
    expect(result.results[0]!.pass).toBe(false);
  });

  it("passThreshold 0.1 accepts a 0.2 score", async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ score: 0.2, pass: false, reasoning: "ok" }),
      );
    const scorer = new LLMJudgeScorer({ llm, rubric: "Quality" });
    const suite: EvalSuite = {
      name: "lenient-threshold",
      passThreshold: 0.1,
      cases: [{ id: "t1", input: "q" }],
      scorers: [scorer],
    };
    const result = await runEvalSuite(suite, async () => "answer");
    expect(result.results[0]!.pass).toBe(true);
  });

  it("multi-scorer conversation: deterministic + LLM used together", async () => {
    const llm = mockPassingLLM(0.8);
    const det = new DeterministicScorer({
      name: "det",
      mode: "contains",
      caseInsensitive: true,
    });
    const llmScorer = new LLMJudgeScorer({
      name: "llm",
      llm,
      rubric: "Quality",
    });

    const suite: EvalSuite = {
      name: "hybrid",
      cases: [
        {
          id: "t1",
          input: "What is TypeScript?",
          expectedOutput: "typescript",
        },
        { id: "t2", input: "What are generics?", expectedOutput: "generics" },
      ],
      scorers: [det, llmScorer],
    };

    const result = await runEvalSuite(suite, async (input) => {
      if (input.includes("TypeScript"))
        return "TypeScript is a typed language.";
      return "Generics allow reusable type-safe code.";
    });

    expect(result.results).toHaveLength(2);
    result.results.forEach((r) => {
      expect(r.scorerResults).toHaveLength(2);
    });
  });
});
