/**
 * Comprehensive tests for the code generation pipeline:
 * - Template rendering (test-generator: extractExports, determineTestStrategy, generateTestSpecs, buildTestPath)
 * - Variable substitution / incremental generation (incremental-gen)
 * - Output validation (lint-validator: quickSyntaxCheck)
 * - Pipeline stages (pipeline-executor: PipelineExecutor)
 * - Template registry / phase builder (gen-pipeline-builder: GenPipelineBuilder)
 * - Phase conditions (phase-conditions)
 */

import { describe, it, expect, vi } from "vitest";

// ─── imports ─────────────────────────────────────────────────────────────────
import {
  determineTestStrategy,
  extractExports,
  generateTestSpecs,
  buildTestPath,
} from "../generation/test-generator.js";

import {
  splitIntoSections,
  detectAffectedSections,
  applyIncrementalChanges,
  buildIncrementalPrompt,
} from "../generation/incremental-gen.js";

import { quickSyntaxCheck } from "../tools/lint-validator.js";

import {
  PipelineExecutor,
  type PhaseConfig,
} from "../pipeline/pipeline-executor.js";

import { GenPipelineBuilder } from "../pipeline/gen-pipeline-builder.js";

import {
  hasKey,
  previousSucceeded,
  stateEquals,
  hasFilesMatching,
  allOf,
  anyOf,
} from "../pipeline/phase-conditions.js";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Template rendering (test-generator)
// ─────────────────────────────────────────────────────────────────────────────

describe("determineTestStrategy — template strategy detection", () => {
  it('returns "unit" for a plain TypeScript service file', () => {
    expect(determineTestStrategy("src/auth/auth-service.ts", "")).toBe("unit");
  });

  it('returns "e2e" for a file with .e2e.ts extension', () => {
    expect(determineTestStrategy("src/auth/login.e2e.ts", "")).toBe("e2e");
  });

  it('returns "e2e" for a file inside an e2e directory', () => {
    expect(determineTestStrategy("src/e2e/full-flow.ts", "")).toBe("e2e");
  });

  it('returns "component" for a .vue file', () => {
    expect(determineTestStrategy("src/components/Button.vue", "")).toBe(
      "component",
    );
  });

  it('returns "component" for a .tsx file', () => {
    expect(determineTestStrategy("src/components/Button.tsx", "")).toBe(
      "component",
    );
  });

  it('returns "integration" for a .controller.ts file', () => {
    expect(determineTestStrategy("src/user/user.controller.ts", "")).toBe(
      "integration",
    );
  });

  it('returns "integration" for a .routes.ts file', () => {
    expect(determineTestStrategy("src/user/user.routes.ts", "")).toBe(
      "integration",
    );
  });

  it('returns "integration" for a file inside a routes directory', () => {
    expect(determineTestStrategy("src/routes/user.ts", "")).toBe("integration");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Variable substitution — extractExports
// ─────────────────────────────────────────────────────────────────────────────

describe("extractExports — variable substitution in template targets", () => {
  it("extracts a named export function", () => {
    const src = "export function greet(name: string): string { return name }";
    const exports = extractExports(src);
    expect(exports).toHaveLength(1);
    expect(exports[0]!.name).toBe("greet");
    expect(exports[0]!.kind).toBe("function");
  });

  it("extracts an exported const", () => {
    const src = 'export const VERSION = "1.0.0"';
    const exports = extractExports(src);
    expect(
      exports.some((e) => e.name === "VERSION" && e.kind === "const"),
    ).toBe(true);
  });

  it("extracts an exported class", () => {
    const src = "export class UserService { }";
    const exports = extractExports(src);
    expect(exports[0]!.name).toBe("UserService");
    expect(exports[0]!.kind).toBe("class");
  });

  it("extracts an exported interface", () => {
    const src = "export interface UserRecord { id: string }";
    const exports = extractExports(src);
    expect(exports[0]!.name).toBe("UserRecord");
    expect(exports[0]!.kind).toBe("interface");
  });

  it("extracts a type alias export", () => {
    const src = "export type UserId = string";
    const exports = extractExports(src);
    expect(exports[0]!.name).toBe("UserId");
    expect(exports[0]!.kind).toBe("type");
  });

  it("extracts multiple exports in a single pass", () => {
    const src = [
      "export function foo() {}",
      "export const BAR = 1",
      "export class Baz {}",
    ].join("\n");
    const exports = extractExports(src);
    const names = exports.map((e) => e.name);
    expect(names).toContain("foo");
    expect(names).toContain("BAR");
    expect(names).toContain("Baz");
  });

  it("includes function signature when parameters present", () => {
    const src =
      "export function add(a: number, b: number): number { return a + b }";
    const exports = extractExports(src);
    const fn = exports.find((e) => e.name === "add");
    expect(fn?.signature).toContain("add");
  });

  it("returns empty array for file with no exports", () => {
    expect(extractExports("const x = 1")).toHaveLength(0);
  });

  it("handles async function export", () => {
    const src = "export async function fetchUser(id: string) { }";
    const exports = extractExports(src);
    expect(exports[0]!.name).toBe("fetchUser");
    expect(exports[0]!.kind).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: buildTestPath — path template rendering
// ─────────────────────────────────────────────────────────────────────────────

describe("buildTestPath — test file path rendering", () => {
  it("converts src/ path to __tests__ path with .test.ts", () => {
    const path = buildTestPath("src/auth/service.ts");
    expect(path).toBe("src/__tests__/auth/service.test.ts");
  });

  it("preserves the base name without extension", () => {
    const path = buildTestPath("src/utils/helper.ts");
    expect(path).toContain("helper.test.ts");
  });

  it("uses custom testDir when provided", () => {
    const path = buildTestPath("src/auth/service.ts", { testDir: "tests" });
    expect(path.startsWith("tests/")).toBe(true);
  });

  it("uses custom testPattern when provided", () => {
    const path = buildTestPath("src/auth/service.ts", {
      testPattern: "*.spec.ts",
    });
    expect(path.endsWith(".spec.ts")).toBe(true);
  });

  it("handles a path without src/ prefix", () => {
    const path = buildTestPath("lib/core.ts");
    // Should still produce a valid test path
    expect(path).toContain("core.test.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: generateTestSpecs — full template rendering pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("generateTestSpecs — full template rendering pipeline", () => {
  const srcContent = [
    "export function add(a: number, b: number): number { return a + b }",
    "export class Calculator { run() {} }",
  ].join("\n");

  const targets = [
    {
      filePath: "src/math/calculator.ts",
      content: srcContent,
      exports: extractExports(srcContent),
    },
  ];

  it("returns one spec per target", () => {
    const specs = generateTestSpecs(targets);
    expect(specs).toHaveLength(1);
  });

  it("includes the source file path in the spec", () => {
    const [spec] = generateTestSpecs(targets);
    expect(spec!.sourceFilePath).toBe("src/math/calculator.ts");
  });

  it("renders a test file path into the spec", () => {
    const [spec] = generateTestSpecs(targets);
    expect(spec!.testFilePath).toContain("calculator.test.ts");
  });

  it("contains the test prompt referencing the source", () => {
    const [spec] = generateTestSpecs(targets);
    expect(spec!.prompt).toContain("calculator.ts");
  });

  it("generates happy-path test cases for exported functions", () => {
    const [spec] = generateTestSpecs(targets);
    const categories = spec!.testCases.map((tc) => tc.category);
    expect(categories).toContain("happy-path");
  });

  it("generates error-handling test cases", () => {
    const [spec] = generateTestSpecs(targets);
    const categories = spec!.testCases.map((tc) => tc.category);
    expect(categories).toContain("error-handling");
  });

  it("uses vitest framework in prompt by default", () => {
    const [spec] = generateTestSpecs(targets);
    expect(spec!.prompt).toContain("vitest");
  });

  it("uses jest framework when specified", () => {
    const [spec] = generateTestSpecs(targets, { framework: "jest" });
    expect(spec!.prompt).toContain("jest");
  });

  it("includes TDD mode note when tddMode is true", () => {
    const [spec] = generateTestSpecs(targets, { tddMode: true });
    expect(spec!.prompt).toContain("TDD");
  });

  it("handles empty targets array", () => {
    expect(generateTestSpecs([])).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: Incremental generation — variable substitution in sections
// ─────────────────────────────────────────────────────────────────────────────

describe("splitIntoSections — template section parsing", () => {
  it("splits import block from function", () => {
    const src = [
      'import { foo } from "./foo.js"',
      "",
      "export function bar() { return 1 }",
    ].join("\n");
    const sections = splitIntoSections(src);
    const types = sections.map((s) => s.type);
    expect(types).toContain("import");
    expect(types).toContain("function");
  });

  it("identifies function section by name", () => {
    const src = "export function calculate(x: number) { return x * 2 }";
    const sections = splitIntoSections(src);
    expect(sections.some((s) => s.name === "calculate")).toBe(true);
  });

  it("identifies class section by name", () => {
    const src = "export class Engine { run() {} }";
    const sections = splitIntoSections(src);
    expect(
      sections.some((s) => s.name === "Engine" && s.type === "class"),
    ).toBe(true);
  });

  it("identifies const section by name", () => {
    const src = "export const CONFIG = { debug: false }";
    const sections = splitIntoSections(src);
    expect(
      sections.some((s) => s.name === "CONFIG" && s.type === "const"),
    ).toBe(true);
  });

  it("returns empty array for comment-only content", () => {
    const src = "// just a comment\n/* block comment */";
    const sections = splitIntoSections(src);
    expect(sections).toHaveLength(0);
  });

  it("merges consecutive imports into one section", () => {
    const src = [
      'import { a } from "./a.js"',
      'import { b } from "./b.js"',
    ].join("\n");
    const sections = splitIntoSections(src);
    const importSections = sections.filter((s) => s.type === "import");
    expect(importSections).toHaveLength(1);
  });
});

describe("detectAffectedSections — variable reference detection", () => {
  const sections = splitIntoSections(
    [
      'import { x } from "./x.js"',
      "export function parseUser(data: unknown) { return data }",
      "export function formatUser(user: object) { return JSON.stringify(user) }",
      "export class UserCache { get() {} }",
    ].join("\n"),
  );

  it("returns sections matching the change description by name token", () => {
    const affected = detectAffectedSections(
      sections,
      "update parseUser to validate email",
    );
    const names = affected.map((s) => s.name);
    expect(names).toContain("parseUser");
  });

  it("prepends import section when non-import sections are affected", () => {
    const affected = detectAffectedSections(
      sections,
      "update formatUser output",
    );
    const types = affected.map((s) => s.type);
    expect(types).toContain("import");
  });

  it("returns empty array when no sections match", () => {
    const affected = detectAffectedSections(sections, "xyznonexistent");
    expect(affected).toHaveLength(0);
  });

  it("matches by partial name token", () => {
    const affected = detectAffectedSections(
      sections,
      "usercache lookup optimization",
    );
    const names = affected.map((s) => s.name);
    expect(
      names.some(
        (n) =>
          n.toLowerCase().includes("cache") || n.toLowerCase() === "usercache",
      ),
    ).toBe(true);
  });
});

describe("applyIncrementalChanges — variable substitution in content", () => {
  const originalContent = [
    'import { foo } from "./foo.js"',
    "",
    "export function greet(name: string) {",
    "  return `Hello, ${name}`",
    "}",
    "",
    'export const VERSION = "1.0.0"',
  ].join("\n");

  it("replaces a function section with new content", () => {
    const sections = splitIntoSections(originalContent);
    const greetSection = sections.find((s) => s.name === "greet");
    if (!greetSection) throw new Error("greet section not found");

    const result = applyIncrementalChanges(originalContent, [
      {
        section: "greet",
        operation: "replace",
        newContent:
          "export function greet(name: string) {\n  return `Hi, ${name}!`\n}",
      },
    ]);
    expect(result.content).toContain("Hi,");
    expect(result.changes).toHaveLength(1);
    expect(result.changedLines).toBeGreaterThan(0);
  });

  it("deletes a section by name", () => {
    const result = applyIncrementalChanges(originalContent, [
      { section: "VERSION", operation: "delete" },
    ]);
    expect(result.content).not.toContain("VERSION");
    expect(result.changes).toHaveLength(1);
  });

  it("adds new content after a given line", () => {
    const result = applyIncrementalChanges(originalContent, [
      {
        section: "greet",
        operation: "add",
        newContent:
          "export function farewell(name: string) { return `Bye, ${name}` }",
        insertAfterLine: 5,
      },
    ]);
    expect(result.content).toContain("farewell");
  });

  it("preserves unchanged lines count in result", () => {
    const result = applyIncrementalChanges(originalContent, []);
    expect(result.preservedLines).toBeGreaterThan(0);
    expect(result.changedLines).toBe(0);
  });

  it("applies multiple changes in a single pass", () => {
    const result = applyIncrementalChanges(originalContent, [
      {
        section: "greet",
        operation: "replace",
        newContent: "export function greet(name: string) { return name }",
      },
      { section: "VERSION", operation: "delete" },
    ]);
    expect(result.changes).toHaveLength(2);
    expect(result.content).not.toContain("VERSION");
    expect(result.content).toContain("greet");
  });
});

describe("buildIncrementalPrompt — incremental template prompt construction", () => {
  const src = [
    'import { x } from "./x.js"',
    "export function compute(n: number) { return n * 2 }",
  ].join("\n");

  it("includes the file path in the prompt", () => {
    const sections = splitIntoSections(src);
    const affected = sections.filter((s) => s.type === "function");
    const prompt = buildIncrementalPrompt(
      "src/compute.ts",
      sections,
      affected,
      "optimize compute",
    );
    expect(prompt).toContain("src/compute.ts");
  });

  it("includes the change description in the prompt", () => {
    const sections = splitIntoSections(src);
    const affected = sections.filter((s) => s.type === "function");
    const prompt = buildIncrementalPrompt(
      "src/compute.ts",
      sections,
      affected,
      "optimize compute",
    );
    expect(prompt).toContain("optimize compute");
  });

  it("includes section content for affected sections", () => {
    const sections = splitIntoSections(src);
    const affected = sections.filter((s) => s.type === "function");
    const prompt = buildIncrementalPrompt(
      "src/compute.ts",
      sections,
      affected,
      "optimize",
    );
    expect(prompt).toContain("compute");
  });

  it("lists unchanged sections separately", () => {
    const sections = splitIntoSections(src);
    const affected = sections.filter((s) => s.type === "function");
    const prompt = buildIncrementalPrompt(
      "src/compute.ts",
      sections,
      affected,
      "optimize",
    );
    expect(prompt).toContain("Unchanged");
  });

  it("handles empty affected sections gracefully", () => {
    const sections = splitIntoSections(src);
    const prompt = buildIncrementalPrompt(
      "src/compute.ts",
      sections,
      [],
      "nothing changes",
    );
    expect(prompt).toContain("nothing changes");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6: Output validation — quickSyntaxCheck
// ─────────────────────────────────────────────────────────────────────────────

describe("quickSyntaxCheck — output validation", () => {
  it("passes valid TypeScript code", () => {
    const result = quickSyntaxCheck("file.ts", "const x: number = 42");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects unclosed brace", () => {
    const result = quickSyntaxCheck("file.ts", "function foo() {");
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("unclosed brace")),
    ).toBe(true);
  });

  it("detects extra closing brace", () => {
    const result = quickSyntaxCheck("file.ts", "const x = 1 }");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('"}"'))).toBe(true);
  });

  it("detects unclosed bracket", () => {
    const result = quickSyntaxCheck("file.ts", "const arr = [1, 2, 3");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("bracket"))).toBe(true);
  });

  it("detects unclosed parenthesis", () => {
    const result = quickSyntaxCheck("file.ts", 'console.log("hello"');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("paren"))).toBe(true);
  });

  it("passes balanced braces, brackets, and parens", () => {
    const code = "const obj = { arr: [1, 2], fn: (x: number) => x }";
    const result = quickSyntaxCheck("file.ts", code);
    expect(result.valid).toBe(true);
  });

  it("skips non-TS/JS files and always returns valid", () => {
    const result = quickSyntaxCheck(
      "README.md",
      "This { has unbalanced braces",
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("passes valid .jsx file", () => {
    const result = quickSyntaxCheck(
      "comp.jsx",
      'const el = <div className="x">{value}</div>',
    );
    expect(result.valid).toBe(true);
  });

  it("detects unterminated block comment", () => {
    const result = quickSyntaxCheck("file.ts", "/* unclosed comment");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("block comment"))).toBe(
      true,
    );
  });

  it("handles strings containing braces without false positives", () => {
    const result = quickSyntaxCheck("file.ts", 'const x = "{ not a brace }"');
    expect(result.valid).toBe(true);
  });

  it("handles template literals containing braces", () => {
    const result = quickSyntaxCheck("file.ts", "const x = `value: ${someVar}`");
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7: Pipeline stages — PipelineExecutor
// ─────────────────────────────────────────────────────────────────────────────

function makePhase(
  id: string,
  execute: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
  overrides?: Partial<PhaseConfig>,
): PhaseConfig {
  return { id, name: id, execute, ...overrides };
}

describe("PipelineExecutor — pipeline stage orchestration", () => {
  it("runs a single phase and returns completed", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute(
      [makePhase("generate", async (s) => ({ ...s, generated: true }))],
      {},
    );
    expect(result.status).toBe("completed");
    expect(result.state["generated"]).toBe(true);
  });

  it("runs generate → validate → format in order", async () => {
    const order: string[] = [];
    const ex = new PipelineExecutor();
    const phases = [
      makePhase("generate", async (s) => {
        order.push("generate");
        return { ...s, generated: true };
      }),
      makePhase(
        "validate",
        async (s) => {
          order.push("validate");
          return { ...s, validated: true };
        },
        { dependsOn: ["generate"] },
      ),
      makePhase(
        "format",
        async (s) => {
          order.push("format");
          return { ...s, formatted: true };
        },
        { dependsOn: ["validate"] },
      ),
    ];
    await ex.execute(phases, {});
    expect(order).toEqual(["generate", "validate", "format"]);
  });

  it("aborts remaining stages when a stage fails", async () => {
    const formatRan = vi.fn();
    const ex = new PipelineExecutor();
    const phases = [
      makePhase("generate", async () => {
        throw new Error("generation failed");
      }),
      makePhase(
        "format",
        async (s) => {
          formatRan();
          return s;
        },
        { dependsOn: ["generate"] },
      ),
    ];
    const result = await ex.execute(phases, {});
    expect(result.status).toBe("failed");
    // format should not have run — executor stops after a failed phase
    expect(formatRan).not.toHaveBeenCalled();
    // generate phase is recorded as failed
    const generateResult = result.phases.find((p) => p.phaseId === "generate");
    expect(generateResult?.status).toBe("failed");
  });

  it("returns phase results for all stages", async () => {
    const ex = new PipelineExecutor();
    const phases = [
      makePhase("a", async (s) => ({ ...s, a: 1 })),
      makePhase("b", async (s) => ({ ...s, b: 2 }), { dependsOn: ["a"] }),
    ];
    const result = await ex.execute(phases, {});
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0]!.phaseId).toBe("a");
    expect(result.phases[1]!.phaseId).toBe("b");
  });

  it("returns total duration in ms", async () => {
    const ex = new PipelineExecutor();
    const result = await ex.execute([makePhase("x", async (s) => s)], {});
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("calls onCheckpoint after each completed phase", async () => {
    const checkpoint = vi.fn();
    const ex = new PipelineExecutor({ onCheckpoint: checkpoint });
    await ex.execute(
      [makePhase("gen", async (s) => ({ ...s, done: true }))],
      {},
    );
    expect(checkpoint).toHaveBeenCalledWith(
      "gen",
      expect.objectContaining({ done: true }),
    );
  });

  it("calls onProgress callback", async () => {
    const progress = vi.fn();
    const ex = new PipelineExecutor({ onProgress: progress });
    await ex.execute([makePhase("x", async (s) => s)], {});
    expect(progress).toHaveBeenCalled();
  });

  it("retries a failing phase up to maxRetries times", async () => {
    let attempts = 0;
    const ex = new PipelineExecutor({ defaultMaxRetries: 2 });
    const phases = [
      makePhase("flaky", async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return { recovered: true };
      }),
    ];
    const result = await ex.execute(phases, {});
    expect(result.status).toBe("completed");
    expect(attempts).toBe(3);
  });

  it("marks phase as failed when all retries exhausted", async () => {
    const ex = new PipelineExecutor({ defaultMaxRetries: 1 });
    const phases = [
      makePhase("broken", async () => {
        throw new Error("always fails");
      }),
    ];
    const result = await ex.execute(phases, {});
    expect(result.status).toBe("failed");
    expect(result.phases[0]!.status).toBe("failed");
  });

  it("skips phase when condition returns false", async () => {
    const ex = new PipelineExecutor();
    const phases = [
      makePhase("conditional", async (s) => ({ ...s, ran: true }), {
        condition: () => false,
      }),
    ];
    const result = await ex.execute(phases, {});
    expect(result.phases[0]!.status).toBe("skipped");
    expect(result.state["ran"]).toBeUndefined();
  });

  it("runs phase when condition returns true", async () => {
    const ex = new PipelineExecutor();
    const phases = [
      makePhase("conditional", async (s) => ({ ...s, ran: true }), {
        condition: () => true,
      }),
    ];
    const result = await ex.execute(phases, {});
    expect(result.phases[0]!.status).toBe("completed");
    expect(result.state["ran"]).toBe(true);
  });

  it("propagates initial state to first phase", async () => {
    const ex = new PipelineExecutor();
    const phases = [
      makePhase("read", async (s) => ({ ...s, seen: s["input"] })),
    ];
    const result = await ex.execute(phases, { input: "hello" });
    expect(result.state["seen"]).toBe("hello");
  });

  it("accumulates state across phases", async () => {
    const ex = new PipelineExecutor();
    const phases = [
      makePhase("a", async (s) => ({ ...s, a: 1 })),
      makePhase("b", async (s) => ({ ...s, b: 2 }), { dependsOn: ["a"] }),
    ];
    const result = await ex.execute(phases, {});
    expect(result.state["a"]).toBe(1);
    expect(result.state["b"]).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8: Template registry — GenPipelineBuilder
// ─────────────────────────────────────────────────────────────────────────────

describe("GenPipelineBuilder — template registry", () => {
  it("starts with no phases", () => {
    const builder = new GenPipelineBuilder();
    expect(builder.getPhases()).toHaveLength(0);
  });

  it("registers a generation phase by name", () => {
    const builder = new GenPipelineBuilder();
    builder.addPhase({ name: "initial-gen", promptType: "full-file" });
    expect(builder.getPhaseNames()).toContain("initial-gen");
  });

  it("retrieves a registered phase by name", () => {
    const builder = new GenPipelineBuilder();
    builder.addPhase({ name: "generate", promptType: "scaffold" });
    const phase = builder.getPhase("generate");
    expect(phase).toBeDefined();
    expect(phase!.type).toBe("generation");
  });

  it("returns undefined for an unknown template/phase name", () => {
    const builder = new GenPipelineBuilder();
    expect(builder.getPhase("nonexistent")).toBeUndefined();
  });

  it("registers a validation phase", () => {
    const builder = new GenPipelineBuilder();
    builder.addValidationPhase({ dimensions: [], threshold: 0.8 });
    const phase = builder.getPhase("validate");
    expect(phase!.type).toBe("validation");
    expect(phase!.threshold).toBe(0.8);
  });

  it("registers a fix phase with default maxAttempts", () => {
    const builder = new GenPipelineBuilder();
    builder.addFixPhase();
    const phase = builder.getPhase("fix");
    expect(phase!.type).toBe("fix");
    expect(phase!.maxAttempts).toBe(3);
  });

  it("registers a fix phase with custom maxAttempts", () => {
    const builder = new GenPipelineBuilder();
    builder.addFixPhase({ maxAttempts: 5 });
    const phase = builder.getPhase("fix");
    expect(phase!.maxAttempts).toBe(5);
  });

  it("registers a review phase", () => {
    const builder = new GenPipelineBuilder();
    builder.addReviewPhase();
    const phase = builder.getPhase("review");
    expect(phase!.type).toBe("review");
    expect(phase!.autoApprove).toBe(false);
  });

  it("registers a review phase with autoApprove", () => {
    const builder = new GenPipelineBuilder();
    builder.addReviewPhase({ autoApprove: true });
    expect(builder.getPhase("review")!.autoApprove).toBe(true);
  });

  it("preserves phase order when multiple phases registered", () => {
    const builder = new GenPipelineBuilder();
    builder.addPhase({ name: "gen", promptType: "scaffold" });
    builder.addValidationPhase({ dimensions: [], threshold: 0.7 });
    builder.addFixPhase();
    builder.addReviewPhase();
    expect(builder.getPhaseNames()).toEqual([
      "gen",
      "validate",
      "fix",
      "review",
    ]);
  });

  it("returns only generation and subagent phases from getGenerationPhases()", () => {
    const builder = new GenPipelineBuilder();
    builder.addPhase({ name: "gen1", promptType: "full" });
    builder.addSubAgentPhase({ name: "subagent1", promptType: "sub" });
    builder.addValidationPhase({ dimensions: [], threshold: 0.8 });
    const genPhases = builder.getGenerationPhases();
    expect(genPhases).toHaveLength(2);
    expect(
      genPhases.every((p) => p.type === "generation" || p.type === "subagent"),
    ).toBe(true);
  });

  it("registers a guardrail phase via withGuardrails", () => {
    const builder = new GenPipelineBuilder();
    builder.withGuardrails({
      rules: [],
      projectStructure: { files: [], packages: [] },
    });
    const phase = builder.getPhase("guardrail-gate");
    expect(phase).toBeDefined();
    expect(phase!.type).toBe("guardrail");
  });

  it("returns guardrail config via getGuardrailConfig", () => {
    const builder = new GenPipelineBuilder();
    const config = { rules: [], projectStructure: { files: [], packages: [] } };
    builder.withGuardrails(config);
    expect(builder.getGuardrailConfig()).toBe(config);
  });

  it("returns undefined from getGuardrailConfig when not configured", () => {
    const builder = new GenPipelineBuilder();
    expect(builder.getGuardrailConfig()).toBeUndefined();
  });

  it("supports fluent chaining", () => {
    const builder = new GenPipelineBuilder();
    const result = builder
      .addPhase({ name: "g", promptType: "full" })
      .addValidationPhase({ dimensions: [], threshold: 0.9 })
      .addFixPhase();
    expect(result).toBe(builder);
    expect(builder.getPhases()).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9: Phase conditions — state predicate functions
// ─────────────────────────────────────────────────────────────────────────────

describe("hasKey — state predicate", () => {
  it("returns true when key is present with truthy value", () => {
    expect(hasKey("x")({ x: "hello" })).toBe(true);
  });

  it("returns false when key is absent", () => {
    expect(hasKey("missing")({})).toBe(false);
  });

  it("returns false when key value is null", () => {
    expect(hasKey("x")({ x: null })).toBe(false);
  });

  it("returns false when key value is undefined", () => {
    expect(hasKey("x")({ x: undefined })).toBe(false);
  });
});

describe("previousSucceeded — phase completion predicate", () => {
  it("returns true when the phase is marked completed in state", () => {
    expect(
      previousSucceeded("generate")({ __phase_generate_completed: true }),
    ).toBe(true);
  });

  it("returns false when the phase completion flag is absent", () => {
    expect(previousSucceeded("generate")({})).toBe(false);
  });

  it("returns false when the phase completion flag is false", () => {
    expect(
      previousSucceeded("generate")({ __phase_generate_completed: false }),
    ).toBe(false);
  });
});

describe("stateEquals — equality predicate", () => {
  it("returns true when state value strictly equals expected", () => {
    expect(stateEquals("status", "ready")({ status: "ready" })).toBe(true);
  });

  it("returns false when state value differs", () => {
    expect(stateEquals("status", "ready")({ status: "pending" })).toBe(false);
  });

  it("uses strict equality (no coercion)", () => {
    expect(stateEquals("count", 0)({ count: "0" })).toBe(false);
  });
});

describe("hasFilesMatching — file pattern predicate", () => {
  it("returns true when files list contains a matching entry", () => {
    expect(
      hasFilesMatching(/\.ts$/)({ files: ["src/foo.ts", "src/bar.js"] }),
    ).toBe(true);
  });

  it("returns false when no file matches the pattern", () => {
    expect(hasFilesMatching(/\.vue$/)({ files: ["src/foo.ts"] })).toBe(false);
  });

  it("returns false when files key is absent", () => {
    expect(hasFilesMatching(/\.ts$/)({})).toBe(false);
  });

  it("returns false when files is not an array", () => {
    expect(hasFilesMatching(/\.ts$/)({ files: "src/foo.ts" })).toBe(false);
  });
});

describe("allOf — conjunction predicate", () => {
  it("returns true when all conditions are satisfied", () => {
    const pred = allOf(hasKey("a"), hasKey("b"));
    expect(pred({ a: 1, b: 2 })).toBe(true);
  });

  it("returns false when at least one condition fails", () => {
    const pred = allOf(hasKey("a"), hasKey("b"));
    expect(pred({ a: 1 })).toBe(false);
  });

  it("returns true for empty conditions list", () => {
    expect(allOf()({ anything: true })).toBe(true);
  });
});

describe("anyOf — disjunction predicate", () => {
  it("returns true when at least one condition is satisfied", () => {
    const pred = anyOf(hasKey("a"), hasKey("b"));
    expect(pred({ b: 2 })).toBe(true);
  });

  it("returns false when no condition is satisfied", () => {
    const pred = anyOf(hasKey("a"), hasKey("b"));
    expect(pred({ c: 3 })).toBe(false);
  });

  it("returns false for empty conditions list", () => {
    expect(anyOf()({ anything: true })).toBe(false);
  });
});
