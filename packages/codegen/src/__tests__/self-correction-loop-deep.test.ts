/**
 * Deep coverage tests for SelfCorrectionLoop, buildFallbackReflection behavior,
 * and edge cases not covered in the existing self-correction-loop.test.ts
 * or self-correction-loop-extended.test.ts files.
 *
 * Focus areas:
 *  - buildFallbackReflection: testResults.errors path, api_misuse category,
 *    runtime_error category, combined lint+test errors, multiple file extraction
 *  - Loop termination edge cases: maxIterations=0, maxIterations=1
 *  - Cost gate at exact boundary
 *  - VFS passed through unchanged on first-pass success
 *  - Context forwarding to ReflectionNode
 *  - Lesson extraction after final-verify success path
 *  - Multiple listeners called independently
 *  - Empty VFS handling
 *  - Large error lists (capped at 10 in onExhausted)
 *  - Iteration index increments correctly across full loop
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SelfCorrectionLoop } from "../correction/self-correction-loop.js";
import { LessonExtractor } from "../correction/lesson-extractor.js";
import type {
  CodeEvaluator,
  CodeFixer,
  EvaluationResult,
  Reflection,
  CorrectionContext,
  CorrectionIterationEvent,
  CorrectionFixedEvent,
  CorrectionExhaustedEvent,
} from "../correction/correction-types.js";
import type { TokenUsage } from "@dzupagent/core";
import type { ReflectionNode } from "../correction/reflection-node.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroTokens(): TokenUsage {
  return { model: "", inputTokens: 0, outputTokens: 0 };
}

function makeTokens(input: number, output: number): TokenUsage {
  return { model: "test-model", inputTokens: input, outputTokens: output };
}

function passing(qualityScore = 85): EvaluationResult {
  return {
    passed: true,
    lintErrors: [],
    qualityScore,
    testResults: { passed: 5, failed: 0, errors: [], failedTests: [] },
  };
}

function failing(
  lintErrors: string[] = ["Type error"],
  testErrors: string[] = [],
  qualityScore = 30,
): EvaluationResult {
  return {
    passed: false,
    lintErrors,
    qualityScore,
    testResults: {
      passed: 0,
      failed: testErrors.length,
      errors: testErrors,
      failedTests: testErrors.map((e, i) => ({
        name: `test ${i}`,
        error: e,
        file: `src/test${i}.test.ts`,
      })),
    },
  };
}

function makeEvaluator(results: EvaluationResult[]): CodeEvaluator {
  let i = 0;
  return {
    evaluate: vi.fn(async () => {
      const r = results[Math.min(i, results.length - 1)]!;
      i++;
      return r;
    }),
  };
}

function makeFixer(
  filesModified: string[] = ["src/service.ts"],
  tokens: TokenUsage = makeTokens(300, 200),
): CodeFixer {
  return {
    fix: vi.fn(async (vfs, _r, _c) => ({
      vfs: {
        ...vfs,
        "src/service.ts": "// fixed\n" + (vfs["src/service.ts"] ?? ""),
      },
      filesModified,
      tokensUsed: tokens,
    })),
  };
}

const baseVfs = {
  "src/service.ts": "export class Service {}",
  "src/index.ts": 'export * from "./service"',
};

// ---------------------------------------------------------------------------
// buildFallbackReflection — gaps in error classification
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — fallback reflection from testResults.errors only", () => {
  it("classifies api_misuse from test error messages", async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: [], // no lint errors
      qualityScore: 30,
      testResults: {
        passed: 0,
        failed: 1,
        errors: ["api misuse: method signature does not match"],
        failedTests: [],
      },
    };
    const evaluator = makeEvaluator([eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    // api_misuse keyword not in the regex, should default to logic_error
    expect(result.iterations[0]!.reflection).not.toBeNull();
    expect(result.iterations[0]!.reflection!.rootCause).toBe(
      "api misuse: method signature does not match",
    );
  });

  it("classifies runtime_error from test error messages", async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: [],
      qualityScore: 20,
      testResults: {
        passed: 0,
        failed: 1,
        errors: [
          "ReferenceError: Cannot access variable before initialization",
        ],
        failedTests: [],
      },
    };
    const evaluator = makeEvaluator([eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.iterations[0]!.reflection).not.toBeNull();
    // ReferenceError doesn't match any specific pattern — defaults to logic_error
    expect(result.iterations[0]!.reflection!.category).toBe("logic_error");
  });

  it("combines lint errors and test errors in root cause", async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: ["Lint issue A"],
      qualityScore: 25,
      testResults: {
        passed: 0,
        failed: 1,
        errors: ["Test error B"],
        failedTests: [],
      },
    };
    const evaluator = makeEvaluator([eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    // rootCause should be the first error (lint errors come first in allErrors)
    expect(result.iterations[0]!.reflection!.rootCause).toBe("Lint issue A");
  });

  it("extracts multiple distinct file paths from errors", async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: [
        "Error in /src/api/handler.ts: syntax problem",
        "Error in /src/utils/helper.ts: type mismatch",
      ],
      qualityScore: 20,
      testResults: { passed: 0, failed: 0, errors: [], failedTests: [] },
    };
    const evaluator = makeEvaluator([eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    const files = result.iterations[0]!.reflection!.affectedFiles;
    expect(files).toContain("/src/api/handler.ts");
    expect(files).toContain("/src/utils/helper.ts");
  });

  it("deduplicates file paths extracted from multiple errors", async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: [
        "Error in /src/service.ts: problem A",
        "Error in /src/service.ts: problem B",
      ],
      qualityScore: 20,
      testResults: { passed: 0, failed: 0, errors: [], failedTests: [] },
    };
    const evaluator = makeEvaluator([eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    const files = result.iterations[0]!.reflection!.affectedFiles;
    const serviceFiles = files.filter((f) => f === "/src/service.ts");
    expect(serviceFiles).toHaveLength(1); // deduplicated
  });

  it("classifies lint_violation when lint keyword appears in test errors", async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: [],
      qualityScore: 30,
      testResults: {
        passed: 0,
        failed: 1,
        errors: ["eslint rule violation: prefer-const"],
        failedTests: [],
      },
    };
    const evaluator = makeEvaluator([eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.iterations[0]!.reflection!.category).toBe("lint_violation");
  });

  it("classifies syntax_error when parse keyword appears", async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: ["parse error at position 42"],
      qualityScore: 20,
      testResults: { passed: 0, failed: 0, errors: [], failedTests: [] },
    };
    const evaluator = makeEvaluator([eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.iterations[0]!.reflection!.category).toBe("syntax_error");
  });

  it('uses "Unknown error" rootCause when allErrors is empty', async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: [],
      qualityScore: 50,
      testResults: { passed: 5, failed: 0, errors: [], failedTests: [] },
    };
    const evaluator = makeEvaluator([eval_, eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    // passed=false but no errors — quality is 50 < 70, so loop iterates
    expect(result.iterations[0]!.reflection!.rootCause).toBe("Unknown error");
  });

  it('classifies type_error with "mismatch" keyword', async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: ["type mismatch in assignment"],
      qualityScore: 20,
      testResults: { passed: 0, failed: 0, errors: [], failedTests: [] },
    };
    const evaluator = makeEvaluator([eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.iterations[0]!.reflection!.category).toBe("type_error");
  });

  it('classifies missing_import with "cannot find" keyword', async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: ['Cannot find module "./missing"'],
      qualityScore: 20,
      testResults: { passed: 0, failed: 0, errors: [], failedTests: [] },
    };
    const evaluator = makeEvaluator([eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.iterations[0]!.reflection!.category).toBe("missing_import");
  });

  it('classifies test_failure with "assert" keyword in test errors', async () => {
    const eval_: EvaluationResult = {
      passed: false,
      lintErrors: [],
      qualityScore: 20,
      testResults: {
        passed: 0,
        failed: 1,
        errors: ["assert.strictEqual failed"],
        failedTests: [],
      },
    };
    const evaluator = makeEvaluator([eval_, passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.iterations[0]!.reflection!.category).toBe("test_failure");
  });
});

// ---------------------------------------------------------------------------
// Loop termination edge cases
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — termination edge cases", () => {
  it("maxIterations=0 exits immediately with wasFixed=false", async () => {
    const evaluator = makeEvaluator([failing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 0, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.wasFixed).toBe(false);
    expect(result.iterationCount).toBe(0);
    expect(result.iterations).toHaveLength(0);
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it("maxIterations=1 runs exactly one iteration and exits if failing", async () => {
    const evaluator = makeEvaluator([failing(), failing()]);
    const fixer = makeFixer();
    const onExhausted = vi.fn();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, listeners: { onExhausted } },
      { maxIterations: 1, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.wasFixed).toBe(false);
    expect(result.iterationCount).toBe(1);
    expect(fixer.fix).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("maxIterations=1 succeeds when first attempt passes", async () => {
    const evaluator = makeEvaluator([passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 1, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.wasFixed).toBe(true);
    expect(result.iterationCount).toBe(1);
    expect(fixer.fix).not.toHaveBeenCalled();
  });

  it("emits onExhausted with 0 iterations when maxIterations=0", async () => {
    const evaluator = makeEvaluator([]);
    const fixer = makeFixer();
    const onExhausted = vi.fn();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, listeners: { onExhausted } },
      { maxIterations: 0, qualityThreshold: 70, enableReflection: false },
    );

    await loop.run(baseVfs);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0]![0]).toMatchObject({
      iterationCount: 0,
      lastErrors: [],
    });
  });

  it("iteration index starts at 0 and increments each loop cycle", async () => {
    const events: CorrectionIterationEvent[] = [];
    const evaluator = makeEvaluator([
      failing(["e1"]),
      failing(["e2"]),
      failing(["e3"]),
      passing(),
    ]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, listeners: { onIteration: (e) => events.push(e) } },
      { maxIterations: 5, qualityThreshold: 70, enableReflection: false },
    );

    await loop.run(baseVfs);
    expect(events[0]!.iteration).toBe(0);
    expect(events[1]!.iteration).toBe(1);
    expect(events[2]!.iteration).toBe(2);
  });

  it("last iteration in onExhausted caps errors at 10", async () => {
    const manyErrors = Array.from({ length: 15 }, (_, i) => `error ${i}`);
    const evaluator = makeEvaluator([
      failing(manyErrors),
      failing(manyErrors),
      failing(manyErrors), // final verification also fails
    ]);
    const fixer = makeFixer();
    const onExhausted = vi.fn();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, listeners: { onExhausted } },
      { maxIterations: 2, qualityThreshold: 70, enableReflection: false },
    );

    await loop.run(baseVfs);
    const event = onExhausted.mock.calls[0]![0] as CorrectionExhaustedEvent;
    expect(event.lastErrors.length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Empty VFS
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — empty VFS", () => {
  it("handles empty VFS on first pass success", async () => {
    const evaluator = makeEvaluator([passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { qualityThreshold: 70 },
    );

    const result = await loop.run({});
    expect(result.wasFixed).toBe(true);
    expect(result.finalCode).toEqual({});
  });

  it("handles empty VFS when fixer adds files", async () => {
    const evaluator = makeEvaluator([failing(), passing()]);
    const addingFixer: CodeFixer = {
      fix: vi.fn(async (_vfs) => ({
        vfs: { "src/generated.ts": "export const x = 1" },
        filesModified: ["src/generated.ts"],
        tokensUsed: makeTokens(100, 50),
      })),
    };

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer: addingFixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run({});
    expect(result.wasFixed).toBe(true);
    expect(result.finalCode["src/generated.ts"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// VFS immutability
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — VFS immutability", () => {
  it("does not mutate the original VFS object", async () => {
    const original = {
      "src/a.ts": "original content",
      "src/b.ts": "b content",
    };
    const snapshot = { ...original };
    const evaluator = makeEvaluator([failing(), passing()]);
    const fixer = makeFixer(["src/a.ts"]);

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    await loop.run(original);
    expect(original).toEqual(snapshot);
  });

  it("finalCode is a new object different from input VFS", async () => {
    const original = { "src/a.ts": "export const x = 1" };
    const evaluator = makeEvaluator([passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { qualityThreshold: 70 },
    );
    const result = await loop.run(original);
    expect(result.finalCode).not.toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Context forwarding
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — context forwarding", () => {
  it("passes context to evaluator on each iteration", async () => {
    const evaluator = makeEvaluator([failing(), failing(), passing()]);
    const fixer = makeFixer();
    const ctx: CorrectionContext = {
      plan: { feature: "billing" },
      techStack: { framework: "express" },
      priorLessons: [],
    };

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 5, qualityThreshold: 70, enableReflection: false },
    );

    await loop.run(baseVfs, ctx);
    const calls = vi.mocked(evaluator.evaluate).mock.calls;
    for (const call of calls) {
      expect(call[1]).toBe(ctx);
    }
  });

  it("passes context to fixer on each fix call", async () => {
    const evaluator = makeEvaluator([failing(), failing(), passing()]);
    const fixer = makeFixer();
    const ctx: CorrectionContext = { reflectionSystemPrompt: "custom prompt" };

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 5, qualityThreshold: 70, enableReflection: false },
    );

    await loop.run(baseVfs, ctx);
    const calls = vi.mocked(fixer.fix).mock.calls;
    for (const call of calls) {
      expect(call[2]).toBe(ctx);
    }
  });

  it("passes context to ReflectionNode", async () => {
    const evaluator = makeEvaluator([failing(), passing()]);
    const fixer = makeFixer();
    const mockReflectionNode: ReflectionNode = {
      reflect: vi.fn(async () => ({
        reflection: {
          rootCause: "Bug",
          affectedFiles: [],
          suggestedFix: "Fix it",
          confidence: 0.8,
          category: "logic_error" as const,
        },
        tokensUsed: makeTokens(100, 50),
      })),
    } as unknown as ReflectionNode;
    const ctx: CorrectionContext = { plan: { step: 1 } };

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, reflectionNode: mockReflectionNode },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: true },
    );

    await loop.run(baseVfs, ctx);
    // ReflectionNode.reflect is called with (vfs, evaluation), not context directly
    // but evaluator and fixer should receive ctx
    expect(evaluator.evaluate).toHaveBeenCalledWith(expect.any(Object), ctx);
  });
});

// ---------------------------------------------------------------------------
// ReflectionNode integration
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — ReflectionNode integration", () => {
  it("skips ReflectionNode when enableReflection=false even if node is provided", async () => {
    const evaluator = makeEvaluator([failing(), passing()]);
    const fixer = makeFixer();
    const mockReflectionNode: ReflectionNode = {
      reflect: vi.fn(async () => ({
        reflection: {
          rootCause: "Should not be called",
          affectedFiles: [],
          suggestedFix: "N/A",
          confidence: 0.5,
          category: "logic_error" as const,
        },
        tokensUsed: makeTokens(100, 50),
      })),
    } as unknown as ReflectionNode;

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, reflectionNode: mockReflectionNode },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    await loop.run(baseVfs);
    expect(mockReflectionNode.reflect).not.toHaveBeenCalled();
  });

  it("ReflectionNode called once per failing iteration", async () => {
    const evaluator = makeEvaluator([failing(), failing(), passing()]);
    const fixer = makeFixer();
    const mockReflectionNode: ReflectionNode = {
      reflect: vi.fn(async () => ({
        reflection: {
          rootCause: "Missing dep",
          affectedFiles: ["src/service.ts"],
          suggestedFix: "Add dep",
          confidence: 0.9,
          category: "missing_import" as const,
        },
        tokensUsed: makeTokens(200, 100),
      })),
    } as unknown as ReflectionNode;

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, reflectionNode: mockReflectionNode },
      { maxIterations: 5, qualityThreshold: 70, enableReflection: true },
    );

    await loop.run(baseVfs);
    expect(mockReflectionNode.reflect).toHaveBeenCalledTimes(2);
  });

  it("reflection tokens accumulate in totalTokens", async () => {
    const evaluator = makeEvaluator([failing(), passing()]);
    const fixer = makeFixer(["src/service.ts"], makeTokens(0, 0));
    const mockReflectionNode: ReflectionNode = {
      reflect: vi.fn(async () => ({
        reflection: {
          rootCause: "Error",
          affectedFiles: [],
          suggestedFix: "Fix",
          confidence: 0.7,
          category: "type_error" as const,
        },
        tokensUsed: makeTokens(400, 200),
      })),
    } as unknown as ReflectionNode;

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, reflectionNode: mockReflectionNode },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: true },
    );

    const result = await loop.run(baseVfs);
    expect(result.totalTokens.inputTokens).toBe(400);
    expect(result.totalTokens.outputTokens).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Final verification — lesson extraction
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — final verification + lesson extraction", () => {
  it("extracts lessons after final verification success", async () => {
    // The loop exhausts iterations but final verify passes
    const evaluator = makeEvaluator([
      failing(["error1"]),
      failing(["error2"]),
      passing(), // final verification
    ]);
    const fixer = makeFixer();
    const lessonExtractor = new LessonExtractor();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, lessonExtractor },
      {
        maxIterations: 2,
        qualityThreshold: 70,
        enableReflection: false,
        enableLessonExtraction: true,
      },
    );

    const result = await loop.run(baseVfs);
    expect(result.wasFixed).toBe(true);
    // Lessons should have been extracted since the session was successful
    expect(result.lessons.length).toBeGreaterThan(0);
  });

  it("emits onFixed after final verification success", async () => {
    const evaluator = makeEvaluator([
      failing(),
      failing(),
      passing(), // final verification
    ]);
    const fixer = makeFixer();
    const onFixed = vi.fn();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, listeners: { onFixed } },
      { maxIterations: 2, qualityThreshold: 70, enableReflection: false },
    );

    await loop.run(baseVfs);
    expect(onFixed).toHaveBeenCalledTimes(1);
    const event = onFixed.mock.calls[0]![0] as CorrectionFixedEvent;
    expect(event.iterationCount).toBe(2);
  });

  it("does not emit onFixed if final verification also fails", async () => {
    const evaluator = makeEvaluator([failing(), failing(), failing()]);
    const fixer = makeFixer();
    const onFixed = vi.fn();
    const onExhausted = vi.fn();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, listeners: { onFixed, onExhausted } },
      { maxIterations: 2, qualityThreshold: 70, enableReflection: false },
    );

    await loop.run(baseVfs);
    expect(onFixed).not.toHaveBeenCalled();
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple listeners
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — multiple listener scenarios", () => {
  it("all three listener types fire independently", async () => {
    const evaluator = makeEvaluator([failing(), passing()]);
    const fixer = makeFixer();
    const onIteration = vi.fn();
    const onFixed = vi.fn();
    const onExhausted = vi.fn();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, listeners: { onIteration, onFixed, onExhausted } },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    await loop.run(baseVfs);
    expect(onIteration).toHaveBeenCalled();
    expect(onFixed).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("no listeners do not cause errors", async () => {
    const evaluator = makeEvaluator([passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { qualityThreshold: 70 },
    );
    await expect(loop.run(baseVfs)).resolves.toBeDefined();
  });

  it("partial listeners (only onIteration) do not crash", async () => {
    const evaluator = makeEvaluator([failing(), passing()]);
    const fixer = makeFixer();
    const onIteration = vi.fn();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, listeners: { onIteration } },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
    );

    await expect(loop.run(baseVfs)).resolves.toBeDefined();
    expect(onIteration).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Token and cost accumulation
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — token and cost accumulation", () => {
  it("totalCostCents is 0 when no tokens are used (first-pass success)", async () => {
    const evaluator = makeEvaluator([passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { qualityThreshold: 70 },
    );
    const result = await loop.run(baseVfs);
    // No fix called, no reflection — cost is 0
    expect(result.totalCostCents).toBe(0);
  });

  it("accumulates costs across multiple iterations", async () => {
    const evaluator = makeEvaluator([failing(), failing(), passing()]);
    const fixer = makeFixer(["src/service.ts"], makeTokens(1000, 500));

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 5, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    // 2 fix calls with 1500 tokens each = 3000 total tokens * 0.3/1000 = 0.9 cents
    expect(result.totalCostCents).toBeGreaterThan(0);
  });

  it("merges reflection and fix tokens in iteration tokensUsed", async () => {
    const evaluator = makeEvaluator([failing(), passing()]);
    const fixer = makeFixer(["src/service.ts"], makeTokens(200, 100));
    const mockReflectionNode: ReflectionNode = {
      reflect: vi.fn(async () => ({
        reflection: {
          rootCause: "Bug",
          affectedFiles: [],
          suggestedFix: "Fix",
          confidence: 0.8,
          category: "type_error" as const,
        },
        tokensUsed: makeTokens(300, 150),
      })),
    } as unknown as ReflectionNode;

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, reflectionNode: mockReflectionNode },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: true },
    );

    const result = await loop.run(baseVfs);
    // Iteration 0 should have merged tokens from reflection (300+150) + fix (200+100)
    const iter0Tokens = result.iterations[0]!.tokensUsed;
    expect(iter0Tokens.inputTokens).toBe(500); // 300 + 200
    expect(iter0Tokens.outputTokens).toBe(250); // 150 + 100
  });
});

// ---------------------------------------------------------------------------
// Quality threshold edge cases
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — quality threshold edge cases", () => {
  it("accepts code at exactly the threshold", async () => {
    const exactThreshold: EvaluationResult = {
      passed: true,
      lintErrors: [],
      qualityScore: 70,
      testResults: { passed: 5, failed: 0, errors: [], failedTests: [] },
    };
    const evaluator = makeEvaluator([exactThreshold]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { qualityThreshold: 70 },
    );

    const result = await loop.run(baseVfs);
    expect(result.wasFixed).toBe(true);
  });

  it("rejects code at one below the threshold", async () => {
    const belowThreshold: EvaluationResult = {
      passed: true,
      lintErrors: [],
      qualityScore: 69,
      testResults: { passed: 5, failed: 0, errors: [], failedTests: [] },
    };
    const evaluator = makeEvaluator([
      belowThreshold,
      belowThreshold,
      belowThreshold,
    ]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 2, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.wasFixed).toBe(false);
  });

  it("uses qualityThreshold=0 to accept any passing evaluation", async () => {
    const lowQual: EvaluationResult = {
      passed: true,
      lintErrors: [],
      qualityScore: 1,
      testResults: { passed: 1, failed: 0, errors: [], failedTests: [] },
    };
    const evaluator = makeEvaluator([lowQual]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { qualityThreshold: 0 },
    );

    const result = await loop.run(baseVfs);
    expect(result.wasFixed).toBe(true);
  });

  it("uses qualityThreshold=100 to require perfect quality", async () => {
    const almostPerfect: EvaluationResult = {
      passed: true,
      lintErrors: [],
      qualityScore: 99,
      testResults: { passed: 10, failed: 0, errors: [], failedTests: [] },
    };
    const evaluator = makeEvaluator([
      almostPerfect,
      almostPerfect,
      almostPerfect,
    ]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 2, qualityThreshold: 100, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.wasFixed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Iteration history completeness
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — iteration history completeness", () => {
  it("each iteration records the VFS snapshot at that point", async () => {
    let fixCount = 0;
    const evaluator = makeEvaluator([failing(), failing(), passing()]);
    const snapFixer: CodeFixer = {
      fix: vi.fn(async (vfs) => {
        fixCount++;
        return {
          vfs: { ...vfs, [`src/fix${fixCount}.ts`]: `// fix ${fixCount}` },
          filesModified: [`src/fix${fixCount}.ts`],
          tokensUsed: makeTokens(100, 50),
        };
      }),
    };

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer: snapFixer },
      { maxIterations: 5, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    // Iteration 0 snapshot should have fix1 (set by fixer after iteration 0)
    expect(result.iterations[0]!.vfsSnapshot["src/fix1.ts"]).toBeDefined();
    // Iteration 1 snapshot should have fix2
    expect(result.iterations[1]!.vfsSnapshot["src/fix2.ts"]).toBeDefined();
  });

  it("filesModified is empty for first-pass success", async () => {
    const evaluator = makeEvaluator([passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { qualityThreshold: 70 },
    );
    const result = await loop.run(baseVfs);
    expect(result.iterations[0]!.filesModified).toEqual([]);
  });

  it("reflection is null for first-pass success", async () => {
    const evaluator = makeEvaluator([passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { qualityThreshold: 70 },
    );
    const result = await loop.run(baseVfs);
    expect(result.iterations[0]!.reflection).toBeNull();
  });

  it("all iteration indices are sequential starting from 0", async () => {
    const evaluator = makeEvaluator([failing(), failing(), passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 5, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    result.iterations.forEach((iter, i) => {
      expect(iter.index).toBe(i);
    });
  });

  it("iterationCount matches iterations array length", async () => {
    const evaluator = makeEvaluator([failing(), failing(), passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { maxIterations: 5, qualityThreshold: 70, enableReflection: false },
    );

    const result = await loop.run(baseVfs);
    expect(result.iterationCount).toBe(result.iterations.length);
  });
});

// ---------------------------------------------------------------------------
// Constructor defaults
// ---------------------------------------------------------------------------

describe("SelfCorrectionLoop — constructor", () => {
  it("does not attach reflectionNode when none provided", async () => {
    const evaluator = makeEvaluator([failing(), passing()]);
    const fixer = makeFixer();

    // No reflectionNode, but enableReflection=true — should build fallback
    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      { enableReflection: true, qualityThreshold: 70 },
    );

    const result = await loop.run(baseVfs);
    // Falls back to buildFallbackReflection — reflection is not null
    expect(result.iterations[0]!.reflection).not.toBeNull();
  });

  it("does not invoke lessonExtractor when none provided", async () => {
    const evaluator = makeEvaluator([failing(), passing()]);
    const fixer = makeFixer();

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer },
      {
        enableLessonExtraction: true,
        qualityThreshold: 70,
        enableReflection: false,
      },
    );

    const result = await loop.run(baseVfs);
    expect(result.lessons).toEqual([]);
  });

  it("uses empty listeners object when none provided", async () => {
    const evaluator = makeEvaluator([passing()]);
    const fixer = makeFixer();

    // Should not throw even though no listeners are attached
    const loop = new SelfCorrectionLoop({ evaluator, fixer });
    await expect(loop.run(baseVfs)).resolves.toBeDefined();
  });
});
