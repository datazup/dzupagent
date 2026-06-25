/**
 * Comprehensive lint validation pipeline tests.
 *
 * Covers multi-rule linting, violation structure, severity levels, auto-fix
 * suggestions, file filtering, violation count limits, and edge cases not
 * covered by the existing lint-validator.test.ts,
 * branch-coverage-sandbox-lint.test.ts, and lint-sandbox-permissions-deep.test.ts.
 *
 * The in-process "LintPipeline" harness built below is a pure test helper that
 * models the same rule-based abstraction that sandboxLintCheck implements for
 * external tools — letting us test the conceptual pipeline semantics without
 * touching production sources.
 */

import { describe, it, expect, vi } from "vitest";
import { quickSyntaxCheck, sandboxLintCheck } from "../tools/lint-validator.js";
import type { LintResult, LintError } from "../tools/lint-validator.js";
import type {
  SandboxProtocol,
  ExecResult,
} from "../sandbox/sandbox-protocol.js";

// ---------------------------------------------------------------------------
// Minimal in-process lint pipeline harness (test-only, no production changes)
// ---------------------------------------------------------------------------

type RuleSeverity = "error" | "warning" | "info";

interface LintViolation {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: RuleSeverity;
  ruleId: string;
  fixable: boolean;
  fix?: { replacement: string };
}

interface LintRule {
  id: string;
  severity: RuleSeverity;
  enabled: boolean;
  filePattern?: RegExp;
  config?: Record<string, unknown>;
  check: (
    file: string,
    content: string,
    config?: Record<string, unknown>,
  ) => LintViolation[];
  fix?: (content: string, violation: LintViolation) => string;
}

interface PipelineResult {
  passed: boolean;
  violations: LintViolation[];
  rulesRun: string[];
}

const MAX_VIOLATIONS = 50;

function runLintPipeline(
  file: string,
  content: string,
  rules: LintRule[],
  maxViolations = MAX_VIOLATIONS,
): PipelineResult {
  const violations: LintViolation[] = [];
  const rulesRun: string[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.filePattern && !rule.filePattern.test(file)) continue;

    rulesRun.push(rule.id);
    const found = rule.check(file, content, rule.config);
    violations.push(...found);

    if (violations.length >= maxViolations) {
      // cap — truncate and stop
      violations.splice(maxViolations);
      break;
    }
  }

  const hasError = violations.some((v) => v.severity === "error");
  return { passed: !hasError, violations, rulesRun };
}

function applyFix(
  content: string,
  violation: LintViolation,
  rule: LintRule,
): string {
  if (!rule.fix) return content;
  return rule.fix(content, violation);
}

// ---------------------------------------------------------------------------
// Reusable rule factories
// ---------------------------------------------------------------------------

function makeNoConsoleRule(
  severity: RuleSeverity = "warning",
  enabled = true,
): LintRule {
  return {
    id: "no-console",
    severity,
    enabled,
    check: (file, content) => {
      const violations: LintViolation[] = [];
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const col = line.indexOf("console.");
        if (col !== -1) {
          violations.push({
            file,
            line: i + 1,
            column: col + 1,
            message: "Unexpected console statement",
            severity,
            ruleId: "no-console",
            fixable: true,
            fix: { replacement: line.slice(0, col) + "// " + line.slice(col) },
          });
        }
      });
      return violations;
    },
    fix: (content, violation) => {
      const lines = content.split("\n");
      const idx = violation.line - 1;
      if (idx >= 0 && idx < lines.length) {
        const line = lines[idx]!;
        const col = line.indexOf("console.");
        if (col !== -1) {
          lines[idx] = line.slice(0, col) + "// " + line.slice(col);
        }
      }
      return lines.join("\n");
    },
  };
}

function makeMaxLineLengthRule(
  maxLen = 80,
  severity: RuleSeverity = "warning",
  enabled = true,
): LintRule {
  return {
    id: "max-line-length",
    severity,
    enabled,
    config: { maxLen },
    check: (file, content, config) => {
      const limit = (config?.["maxLen"] as number | undefined) ?? maxLen;
      const violations: LintViolation[] = [];
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (line.length > limit) {
          violations.push({
            file,
            line: i + 1,
            column: limit + 1,
            message: `Line exceeds max length of ${limit} (${line.length} chars)`,
            severity,
            ruleId: "max-line-length",
            fixable: false,
          });
        }
      });
      return violations;
    },
  };
}

function makeNoVarRule(
  severity: RuleSeverity = "error",
  enabled = true,
): LintRule {
  return {
    id: "no-var",
    severity,
    enabled,
    check: (file, content) => {
      const violations: LintViolation[] = [];
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const col = line.search(/\bvar\b/);
        if (col !== -1) {
          violations.push({
            file,
            line: i + 1,
            column: col + 1,
            message: "Unexpected var declaration",
            severity,
            ruleId: "no-var",
            fixable: true,
            fix: { replacement: line.replace(/\bvar\b/, "const") },
          });
        }
      });
      return violations;
    },
    fix: (content, violation) => {
      const lines = content.split("\n");
      const idx = violation.line - 1;
      if (idx >= 0 && idx < lines.length) {
        lines[idx] = lines[idx]!.replace(/\bvar\b/, "const");
      }
      return lines.join("\n");
    },
  };
}

function makeInfoRule(id = "prefer-const"): LintRule {
  return {
    id,
    severity: "info",
    enabled: true,
    check: (file, content) => {
      const lines = content.split("\n");
      const violations: LintViolation[] = [];
      lines.forEach((line, i) => {
        if (line.includes("let ") && !line.includes("=")) {
          violations.push({
            file,
            line: i + 1,
            column: 1,
            message: "Consider using const",
            severity: "info",
            ruleId: id,
            fixable: false,
          });
        }
      });
      return violations;
    },
  };
}

function makeTsOnlyRule(): LintRule {
  return {
    id: "ts-only",
    severity: "error",
    enabled: true,
    filePattern: /\.(ts|tsx)$/,
    check: (file, content) => {
      if (content.includes("any")) {
        return [
          {
            file,
            line: 1,
            column: 1,
            message: "Avoid using any type",
            severity: "error",
            ruleId: "ts-only",
            fixable: false,
          },
        ];
      }
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Helper to build a mock SandboxProtocol
// ---------------------------------------------------------------------------

function makeSandbox(
  result: Partial<ExecResult> | (() => Promise<ExecResult>),
): SandboxProtocol {
  const execute =
    typeof result === "function"
      ? result
      : async () =>
          ({
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            ...result,
          }) as ExecResult;
  return {
    execute,
    uploadFiles: vi.fn(async () => {}),
    downloadFiles: vi.fn(async () => ({})),
    cleanup: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => true),
  } as unknown as SandboxProtocol;
}

// ===========================================================================
// Test suites
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Single rule pass
// ---------------------------------------------------------------------------

describe("lint pipeline — single rule pass", () => {
  it("produces no violations when code satisfies the no-console rule", () => {
    const result = runLintPipeline(
      "src/utils.ts",
      'export function greet() { return "hello" }',
      [makeNoConsoleRule()],
    );
    expect(result.violations).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it("produces no violations when code satisfies the no-var rule", () => {
    const result = runLintPipeline("src/index.ts", "const x = 1\nconst y = 2", [
      makeNoVarRule(),
    ]);
    expect(result.violations).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it("produces no violations for max-line-length with short lines", () => {
    const result = runLintPipeline("src/short.ts", "const x = 1\nconst y = 2", [
      makeMaxLineLengthRule(80),
    ]);
    expect(result.violations).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it("records the rule id in rulesRun when rule passes", () => {
    const result = runLintPipeline("src/clean.ts", "const x = 1", [
      makeNoConsoleRule(),
    ]);
    expect(result.rulesRun).toContain("no-console");
  });
});

// ---------------------------------------------------------------------------
// 2. Single rule fail
// ---------------------------------------------------------------------------

describe("lint pipeline — single rule fail", () => {
  it("produces a violation when console.log is present (warning)", () => {
    const result = runLintPipeline("src/app.ts", 'console.log("debug")', [
      makeNoConsoleRule("warning"),
    ]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.ruleId).toBe("no-console");
  });

  it("produces a violation for var usage (error)", () => {
    const result = runLintPipeline("src/old.ts", "var x = 1", [
      makeNoVarRule("error"),
    ]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.severity).toBe("error");
  });

  it("produces a violation for a line that exceeds max length", () => {
    const longLine = "const x = " + "a".repeat(100);
    const result = runLintPipeline("src/long.ts", longLine, [
      makeMaxLineLengthRule(80),
    ]);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]!.ruleId).toBe("max-line-length");
  });
});

// ---------------------------------------------------------------------------
// 3. Multiple rules — all evaluated, each violation recorded
// ---------------------------------------------------------------------------

describe("lint pipeline — multiple rules", () => {
  it("runs both rules and collects violations from each", () => {
    const content = "var x = 1\nconsole.log(x)";
    const result = runLintPipeline("src/multi.ts", content, [
      makeNoVarRule(),
      makeNoConsoleRule(),
    ]);
    const ruleIds = result.violations.map((v) => v.ruleId);
    expect(ruleIds).toContain("no-var");
    expect(ruleIds).toContain("no-console");
  });

  it("passes when multiple rules each produce no violations", () => {
    const content = "const x = 1\nconst y = 2";
    const result = runLintPipeline("src/clean.ts", content, [
      makeNoVarRule(),
      makeNoConsoleRule(),
      makeMaxLineLengthRule(80),
    ]);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("records all rule ids in rulesRun when all rules run", () => {
    const result = runLintPipeline("src/any.ts", "const x = 1", [
      makeNoVarRule(),
      makeNoConsoleRule(),
      makeMaxLineLengthRule(),
    ]);
    expect(result.rulesRun).toContain("no-var");
    expect(result.rulesRun).toContain("no-console");
    expect(result.rulesRun).toContain("max-line-length");
  });
});

// ---------------------------------------------------------------------------
// 4. Rule ordering
// ---------------------------------------------------------------------------

describe("lint pipeline — rule ordering", () => {
  const runOrder: string[] = [];

  function makeOrderedRule(id: string): LintRule {
    return {
      id,
      severity: "info",
      enabled: true,
      check: () => {
        runOrder.push(id);
        return [];
      },
    };
  }

  it("runs rules in the order they are provided", () => {
    runOrder.length = 0;
    const rules = [
      makeOrderedRule("rule-a"),
      makeOrderedRule("rule-b"),
      makeOrderedRule("rule-c"),
    ];
    runLintPipeline("src/x.ts", "const x = 1", rules);
    expect(runOrder).toEqual(["rule-a", "rule-b", "rule-c"]);
  });

  it("reflects reversed rule list in execution order", () => {
    runOrder.length = 0;
    const rules = [
      makeOrderedRule("rule-z"),
      makeOrderedRule("rule-y"),
      makeOrderedRule("rule-x"),
    ];
    runLintPipeline("src/x.ts", "const x = 1", rules);
    expect(runOrder).toEqual(["rule-z", "rule-y", "rule-x"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Violation structure
// ---------------------------------------------------------------------------

describe("lint pipeline — violation structure", () => {
  it("violation includes file, line, column, message, severity, ruleId", () => {
    const result = runLintPipeline("src/bad.ts", "var x = 1", [
      makeNoVarRule(),
    ]);
    const v = result.violations[0]!;
    expect(v).toHaveProperty("file");
    expect(v).toHaveProperty("line");
    expect(v).toHaveProperty("column");
    expect(v).toHaveProperty("message");
    expect(v).toHaveProperty("severity");
    expect(v).toHaveProperty("ruleId");
  });

  it("violation file matches the file passed to the pipeline", () => {
    const result = runLintPipeline("src/specific.ts", "var x = 1", [
      makeNoVarRule(),
    ]);
    expect(result.violations[0]!.file).toBe("src/specific.ts");
  });

  it("violation line is 1-indexed", () => {
    const result = runLintPipeline("src/a.ts", "const ok = 1\nvar bad = 2", [
      makeNoVarRule(),
    ]);
    expect(result.violations[0]!.line).toBe(2);
  });

  it("violation column is 1-indexed", () => {
    const result = runLintPipeline("src/a.ts", "var x = 1", [makeNoVarRule()]);
    expect(result.violations[0]!.column).toBeGreaterThanOrEqual(1);
  });

  it("violation ruleId matches the rule that fired", () => {
    const result = runLintPipeline("src/a.ts", 'console.log("hi")', [
      makeNoConsoleRule(),
    ]);
    expect(result.violations[0]!.ruleId).toBe("no-console");
  });

  it("violation message is a non-empty string", () => {
    const result = runLintPipeline("src/a.ts", "var x = 1", [makeNoVarRule()]);
    expect(typeof result.violations[0]!.message).toBe("string");
    expect(result.violations[0]!.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Severity levels
// ---------------------------------------------------------------------------

describe("lint pipeline — severity levels", () => {
  it("error severity is reported correctly", () => {
    const result = runLintPipeline("src/a.ts", "var x = 1", [
      makeNoVarRule("error"),
    ]);
    expect(result.violations[0]!.severity).toBe("error");
  });

  it("warning severity is reported correctly", () => {
    const result = runLintPipeline("src/a.ts", 'console.log("x")', [
      makeNoConsoleRule("warning"),
    ]);
    expect(result.violations[0]!.severity).toBe("warning");
  });

  it("info severity is reported correctly", () => {
    const result = runLintPipeline("src/a.ts", "let x", [makeInfoRule()]);
    const infoViolations = result.violations.filter(
      (v) => v.severity === "info",
    );
    expect(infoViolations.length).toBeGreaterThan(0);
  });

  it("mixed severities all appear in violations array", () => {
    const content = "var x = 1\nconsole.log(x)";
    const result = runLintPipeline("src/mixed.ts", content, [
      makeNoVarRule("error"),
      makeNoConsoleRule("warning"),
    ]);
    const severities = result.violations.map((v) => v.severity);
    expect(severities).toContain("error");
    expect(severities).toContain("warning");
  });
});

// ---------------------------------------------------------------------------
// 7. Error severity blocks pipeline
// ---------------------------------------------------------------------------

describe("lint pipeline — error severity blocks", () => {
  it("pipeline fails when an error-severity violation is found", () => {
    const result = runLintPipeline("src/a.ts", "var x = 1", [
      makeNoVarRule("error"),
    ]);
    expect(result.passed).toBe(false);
  });

  it("pipeline fails with single error among multiple warnings", () => {
    const content = "var x = 1\nconsole.log(x)";
    const result = runLintPipeline("src/b.ts", content, [
      makeNoVarRule("error"),
      makeNoConsoleRule("warning"),
    ]);
    expect(result.passed).toBe(false);
  });

  it("pipeline fails on multiple error violations", () => {
    const content = "var x = 1\nvar y = 2";
    const result = runLintPipeline("src/c.ts", content, [
      makeNoVarRule("error"),
    ]);
    expect(result.passed).toBe(false);
    expect(result.violations.every((v) => v.severity === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Warning severity allows pipeline to pass
// ---------------------------------------------------------------------------

describe("lint pipeline — warning severity allows pass", () => {
  it("pipeline passes with warning-only violations", () => {
    const result = runLintPipeline("src/warn.ts", 'console.log("warn")', [
      makeNoConsoleRule("warning"),
    ]);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.severity).toBe("warning");
  });

  it("pipeline passes with info-only violations", () => {
    const result = runLintPipeline("src/info.ts", "let x", [makeInfoRule()]);
    expect(result.passed).toBe(true);
  });

  it("pipeline passes with mixed warning+info violations", () => {
    const content = "let x\nconsole.log(x)";
    const result = runLintPipeline("src/d.ts", content, [
      makeInfoRule(),
      makeNoConsoleRule("warning"),
    ]);
    expect(result.passed).toBe(true);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Auto-fix — fixable violation produces suggested fix
// ---------------------------------------------------------------------------

describe("lint pipeline — auto-fix suggestions", () => {
  it("fixable no-var violation includes a fix replacement", () => {
    const result = runLintPipeline("src/a.ts", "var x = 1", [makeNoVarRule()]);
    const v = result.violations[0]!;
    expect(v.fixable).toBe(true);
    expect(v.fix).toBeDefined();
    expect(v.fix!.replacement).toContain("const");
  });

  it("fixable no-console violation includes a fix replacement", () => {
    const result = runLintPipeline("src/a.ts", 'console.log("hi")', [
      makeNoConsoleRule(),
    ]);
    const v = result.violations[0]!;
    expect(v.fixable).toBe(true);
    expect(v.fix).toBeDefined();
    expect(v.fix!.replacement).toContain("//");
  });

  it("non-fixable max-line-length violation has fixable=false", () => {
    const longLine = "const x = " + "a".repeat(100);
    const result = runLintPipeline("src/a.ts", longLine, [
      makeMaxLineLengthRule(80),
    ]);
    expect(result.violations[0]!.fixable).toBe(false);
    expect(result.violations[0]!.fix).toBeUndefined();
  });

  it("non-fixable info violation has fixable=false", () => {
    const result = runLintPipeline("src/a.ts", "let x", [makeInfoRule()]);
    expect(result.violations[0]!.fixable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. Auto-fix application removes violation on re-lint
// ---------------------------------------------------------------------------

describe("lint pipeline — auto-fix application", () => {
  it("applying no-var fix removes the violation on re-lint", () => {
    const original = "var x = 1";
    const rule = makeNoVarRule();
    const firstResult = runLintPipeline("src/a.ts", original, [rule]);
    const violation = firstResult.violations[0]!;
    const fixed = applyFix(original, violation, rule);
    const secondResult = runLintPipeline("src/a.ts", fixed, [rule]);
    expect(secondResult.violations).toHaveLength(0);
  });

  it("applying no-console fix transforms the line to a comment", () => {
    const original = 'console.log("debug")';
    const rule = makeNoConsoleRule();
    const firstResult = runLintPipeline("src/a.ts", original, [rule]);
    const violation = firstResult.violations[0]!;
    const fixed = applyFix(original, violation, rule);
    // The fix comments out the console call — the line starts with //
    expect(fixed.trimStart()).toMatch(/^\/\//);
    // The original content is preserved after the comment marker
    expect(fixed).toContain("console.log");
  });

  it("applying fix converts var to const in multi-line content", () => {
    const original = "const ok = 1\nvar bad = 2\nconst also_ok = 3";
    const rule = makeNoVarRule();
    const firstResult = runLintPipeline("src/a.ts", original, [rule]);
    const violation = firstResult.violations[0]!;
    const fixed = applyFix(original, violation, rule);
    expect(fixed).toContain("const bad = 2");
    expect(fixed).not.toContain("var bad");
  });
});

// ---------------------------------------------------------------------------
// 11. Non-fixable violations
// ---------------------------------------------------------------------------

describe("lint pipeline — non-fixable violations", () => {
  it("max-line-length violation is not fixable", () => {
    const longLine = "const x = " + "a".repeat(100);
    const result = runLintPipeline("src/a.ts", longLine, [
      makeMaxLineLengthRule(80),
    ]);
    expect(result.violations[0]!.fixable).toBe(false);
  });

  it("ts-only any violation is not fixable", () => {
    const result = runLintPipeline("src/a.ts", "const x: any = 1", [
      makeTsOnlyRule(),
    ]);
    expect(result.violations[0]!.fixable).toBe(false);
  });

  it("applying applyFix to a rule without fix function returns content unchanged", () => {
    const content = "const x: any = 1";
    const rule = makeTsOnlyRule();
    const result = runLintPipeline("src/a.ts", content, [rule]);
    const fixed = applyFix(content, result.violations[0]!, rule);
    expect(fixed).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// 12. Rule disabled
// ---------------------------------------------------------------------------

describe("lint pipeline — rule disabled", () => {
  it("disabled rule is not run and produces no violations", () => {
    const result = runLintPipeline("src/a.ts", "var x = 1", [
      { ...makeNoVarRule(), enabled: false },
    ]);
    expect(result.violations).toHaveLength(0);
    expect(result.rulesRun).not.toContain("no-var");
  });

  it("disabled rule is skipped even when content clearly violates it", () => {
    const result = runLintPipeline(
      "src/a.ts",
      'console.log("x")\nconsole.log("y")',
      [{ ...makeNoConsoleRule(), enabled: false }],
    );
    expect(result.violations).toHaveLength(0);
  });

  it("enabled and disabled rules coexist — only enabled runs", () => {
    const content = "var x = 1\nconsole.log(x)";
    const result = runLintPipeline("src/a.ts", content, [
      makeNoVarRule("error"),
      { ...makeNoConsoleRule(), enabled: false },
    ]);
    const ruleIds = result.violations.map((v) => v.ruleId);
    expect(ruleIds).toContain("no-var");
    expect(ruleIds).not.toContain("no-console");
  });
});

// ---------------------------------------------------------------------------
// 13. Rule config
// ---------------------------------------------------------------------------

describe("lint pipeline — rule config", () => {
  it("max-line-length respects maxLen=40 config", () => {
    const content = "const x = " + "a".repeat(50);
    const result = runLintPipeline("src/a.ts", content, [
      makeMaxLineLengthRule(40),
    ]);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]!.message).toContain("40");
  });

  it("max-line-length with generous limit produces no violations", () => {
    const content = "const x = " + "a".repeat(50);
    const result = runLintPipeline("src/a.ts", content, [
      makeMaxLineLengthRule(200),
    ]);
    expect(result.violations).toHaveLength(0);
  });

  it("config is passed into the check function", () => {
    const checkSpy = vi.fn(() => [] as LintViolation[]);
    const rule: LintRule = {
      id: "spy-rule",
      severity: "info",
      enabled: true,
      config: { threshold: 42 },
      check: checkSpy,
    };
    runLintPipeline("src/a.ts", "const x = 1", [rule]);
    expect(checkSpy).toHaveBeenCalledWith("src/a.ts", "const x = 1", {
      threshold: 42,
    });
  });
});

// ---------------------------------------------------------------------------
// 14. File filter — rules scoped to specific file patterns
// ---------------------------------------------------------------------------

describe("lint pipeline — file filter", () => {
  it("ts-only rule does not run for .js files", () => {
    const result = runLintPipeline("src/a.js", "const x: any = 1", [
      makeTsOnlyRule(),
    ]);
    expect(result.violations).toHaveLength(0);
    expect(result.rulesRun).not.toContain("ts-only");
  });

  it("ts-only rule runs for .ts files", () => {
    const result = runLintPipeline("src/a.ts", "const x: any = 1", [
      makeTsOnlyRule(),
    ]);
    expect(result.violations).toHaveLength(1);
    expect(result.rulesRun).toContain("ts-only");
  });

  it("ts-only rule runs for .tsx files", () => {
    const result = runLintPipeline("src/comp.tsx", "const x: any = 1", [
      makeTsOnlyRule(),
    ]);
    expect(result.violations).toHaveLength(1);
  });

  it("rules without filePattern run for any file", () => {
    const result = runLintPipeline("src/a.css", "var x = 1", [makeNoVarRule()]);
    // no filePattern — runs on any file including css (non-ts check still detects "var ")
    expect(result.rulesRun).toContain("no-var");
  });

  it("custom filePattern restricts to specific directories", () => {
    const srcOnly: LintRule = {
      ...makeNoVarRule(),
      id: "src-no-var",
      filePattern: /^src\//,
    };
    const inSrc = runLintPipeline("src/index.ts", "var x = 1", [srcOnly]);
    const inTest = runLintPipeline("test/index.ts", "var x = 1", [srcOnly]);
    expect(inSrc.violations).toHaveLength(1);
    expect(inTest.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 15. Violation count limit
// ---------------------------------------------------------------------------

describe("lint pipeline — violation count limit", () => {
  it("caps violations at the configured maxViolations", () => {
    const manyVarLines = Array.from(
      { length: 100 },
      (_, i) => `var x${i} = ${i}`,
    ).join("\n");
    const result = runLintPipeline(
      "src/a.ts",
      manyVarLines,
      [makeNoVarRule()],
      10,
    );
    expect(result.violations).toHaveLength(10);
  });

  it("stops evaluating rules after cap is reached mid-rule", () => {
    const manyVarLines = Array.from(
      { length: 30 },
      (_, i) => `var x${i} = ${i}`,
    ).join("\n");
    // no-console runs second but should never be reached because cap hits during no-var
    const callLog: string[] = [];
    const spyConsole: LintRule = {
      ...makeNoConsoleRule(),
      check: (f, c) => {
        callLog.push("no-console");
        return makeNoConsoleRule().check(f, c);
      },
    };
    runLintPipeline("src/a.ts", manyVarLines, [makeNoVarRule(), spyConsole], 5);
    // The no-var rule produces 30 violations but we cap at 5, so no-console never runs
    expect(callLog).not.toContain("no-console");
  });

  it("allows unlimited violations when limit is large", () => {
    const manyVarLines = Array.from(
      { length: 20 },
      (_, i) => `var x${i} = ${i}`,
    ).join("\n");
    const result = runLintPipeline(
      "src/a.ts",
      manyVarLines,
      [makeNoVarRule()],
      1000,
    );
    expect(result.violations).toHaveLength(20);
  });

  it("cap of 1 returns exactly one violation", () => {
    const content = "var a = 1\nvar b = 2\nvar c = 3";
    const result = runLintPipeline("src/a.ts", content, [makeNoVarRule()], 1);
    expect(result.violations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 16. Empty file
// ---------------------------------------------------------------------------

describe("lint pipeline — empty file", () => {
  it("linting an empty file produces no violations (no-console)", () => {
    const result = runLintPipeline("src/empty.ts", "", [makeNoConsoleRule()]);
    expect(result.violations).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it("linting an empty file produces no violations (no-var)", () => {
    const result = runLintPipeline("src/empty.ts", "", [makeNoVarRule()]);
    expect(result.violations).toHaveLength(0);
  });

  it("quickSyntaxCheck on empty TS file is valid", () => {
    const result = quickSyntaxCheck("src/empty.ts", "");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("quickSyntaxCheck on empty JS file is valid", () => {
    const result = quickSyntaxCheck("src/empty.js", "");
    expect(result.valid).toBe(true);
  });

  it("quickSyntaxCheck on empty Vue file is valid", () => {
    const result = quickSyntaxCheck("src/empty.vue", "");
    expect(result.valid).toBe(true);
  });

  it("linting an empty file with multiple rules produces no violations", () => {
    const result = runLintPipeline("src/empty.ts", "", [
      makeNoVarRule(),
      makeNoConsoleRule(),
      makeMaxLineLengthRule(),
    ]);
    expect(result.violations).toHaveLength(0);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17. quickSyntaxCheck — additional coverage
// ---------------------------------------------------------------------------

describe("quickSyntaxCheck — extended coverage", () => {
  it("valid nested function is accepted", () => {
    const content = `
function outer() {
  function inner() {
    return 1
  }
  return inner()
}
`;
    expect(quickSyntaxCheck("src/nested.ts", content).valid).toBe(true);
  });

  it("detects extra closing paren", () => {
    const result = quickSyntaxCheck("src/a.ts", "const x = fn())");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("closing paren"))).toBe(
      true,
    );
  });

  it("single-character valid file is valid", () => {
    expect(quickSyntaxCheck("src/a.ts", "1").valid).toBe(true);
  });

  it("JSX file is treated as TS/JS and validated", () => {
    const content = "const x = (<div>{}</div>";
    // unclosed paren since the outer ( is not closed
    const result = quickSyntaxCheck("src/a.jsx", content);
    // open paren added by ( before <div
    expect(result.errors.some((e) => e.message.includes("paren"))).toBe(true);
  });

  it("TSX file is treated as TS/JS and validated", () => {
    const result = quickSyntaxCheck("src/a.tsx", "export const x = 1");
    expect(result.valid).toBe(true);
  });

  it("deeply nested valid braces are accepted", () => {
    const content =
      "function f() { if (true) { while (false) { const x = {} } } }";
    expect(quickSyntaxCheck("src/a.ts", content).valid).toBe(true);
  });

  it("error has severity field equal to error", () => {
    const result = quickSyntaxCheck("src/a.ts", "function f() {");
    expect(result.errors.every((e) => e.severity === "error")).toBe(true);
  });

  it("error has non-zero line number", () => {
    const result = quickSyntaxCheck("src/a.ts", "const x = fn())");
    expect(result.errors[0]!.line).toBeGreaterThan(0);
  });

  it("returns LintResult shape", () => {
    const result = quickSyntaxCheck("src/a.ts", "const x = 1");
    expect(result).toHaveProperty("valid");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("Python file is skipped (not JS/TS)", () => {
    const result = quickSyntaxCheck("script.py", "def f(: pass");
    expect(result.valid).toBe(true);
  });

  it("multiple unclosed braces yields multiple errors", () => {
    // Two opening braces that are never closed
    const content = "function f() {\nfunction g() {";
    const result = quickSyntaxCheck("src/a.ts", content);
    expect(result.valid).toBe(false);
    const unclosedMsg = result.errors.find((e) =>
      e.message.includes("unclosed brace"),
    );
    expect(unclosedMsg).toBeDefined();
    // The message should mention count >= 2
    expect(unclosedMsg!.message).toContain("2");
  });
});

// ---------------------------------------------------------------------------
// 18. sandboxLintCheck — extended coverage
// ---------------------------------------------------------------------------

describe("sandboxLintCheck — extended coverage", () => {
  it("returns valid when eslint reports no messages", async () => {
    const sandbox = makeSandbox({ stdout: '[{"messages":[]}]' });
    const result = await sandboxLintCheck("src/a.ts", "const x = 1", sandbox);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("maps severity 2 to error", async () => {
    const sandbox = makeSandbox({
      stdout: JSON.stringify([
        {
          messages: [{ line: 1, column: 1, message: "error msg", severity: 2 }],
        },
      ]),
    });
    const result = await sandboxLintCheck("src/a.ts", "const x = 1", sandbox);
    expect(result.errors[0]!.severity).toBe("error");
  });

  it("filters out severity < 2 (warnings)", async () => {
    const sandbox = makeSandbox({
      stdout: JSON.stringify([
        {
          messages: [
            { line: 1, column: 1, message: "warning msg", severity: 1 },
            { line: 2, column: 1, message: "error msg", severity: 2 },
          ],
        },
      ]),
    });
    const result = await sandboxLintCheck("src/a.ts", "const x = 1", sandbox);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toBe("error msg");
  });

  it("multiple error messages all reported", async () => {
    const sandbox = makeSandbox({
      stdout: JSON.stringify([
        {
          messages: [
            { line: 1, column: 1, message: "err1", severity: 2 },
            { line: 2, column: 5, message: "err2", severity: 2 },
            { line: 3, column: 1, message: "err3", severity: 2 },
          ],
        },
      ]),
    });
    const result = await sandboxLintCheck("src/a.ts", "content", sandbox);
    expect(result.errors).toHaveLength(3);
  });

  it("violation includes correct line and column from eslint output", async () => {
    const sandbox = makeSandbox({
      stdout: JSON.stringify([
        {
          messages: [{ line: 7, column: 13, message: "no-undef", severity: 2 }],
        },
      ]),
    });
    const result = await sandboxLintCheck("src/a.ts", "content", sandbox);
    expect(result.errors[0]!.line).toBe(7);
    expect(result.errors[0]!.column).toBe(13);
  });

  it("falls back to quickSyntaxCheck on null stdout", async () => {
    const sandbox = makeSandbox({ stdout: undefined as unknown as string });
    const result = await sandboxLintCheck("src/a.ts", "const x = 1", sandbox);
    expect(result).toHaveProperty("valid");
    expect(result).toHaveProperty("errors");
  });

  it("severity 3 treated as error (>= 2)", async () => {
    const sandbox = makeSandbox({
      stdout: JSON.stringify([
        {
          messages: [{ line: 1, column: 1, message: "critical", severity: 3 }],
        },
      ]),
    });
    const result = await sandboxLintCheck("src/a.ts", "x", sandbox);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.severity).toBe("error");
  });

  it("non-array JSON stdout falls back to quickSyntaxCheck", async () => {
    const sandbox = makeSandbox({ stdout: '{"not": "array"}' });
    const result = await sandboxLintCheck("src/a.ts", "const x = 1", sandbox);
    expect(result).toHaveProperty("valid");
  });

  it("empty messages array yields valid result", async () => {
    const sandbox = makeSandbox({
      stdout: JSON.stringify([{ messages: [] }]),
    });
    const result = await sandboxLintCheck("src/a.ts", "const x = 1", sandbox);
    expect(result.valid).toBe(true);
  });

  it("sandbox timeout fallback still returns a LintResult", async () => {
    const sandbox = makeSandbox(async () => {
      throw new Error("timeout");
    });
    const result = await sandboxLintCheck("src/a.ts", "const x = 1", sandbox);
    expect(result).toHaveProperty("valid");
    expect(result).toHaveProperty("errors");
  });
});

// ---------------------------------------------------------------------------
// 19. Integration: quickSyntaxCheck then multi-rule pipeline
// ---------------------------------------------------------------------------

describe("lint pipeline — integration scenarios", () => {
  it("file that passes quickSyntaxCheck may still have lint violations", () => {
    const content = "var x = 1";
    const syntaxResult = quickSyntaxCheck("src/a.ts", content);
    expect(syntaxResult.valid).toBe(true); // no syntax error

    const pipelineResult = runLintPipeline("src/a.ts", content, [
      makeNoVarRule("error"),
    ]);
    expect(pipelineResult.passed).toBe(false); // but lint rule fails
  });

  it("combining quickSyntaxCheck and pipeline captures both categories", () => {
    const content = "function f() {\nvar x = 1"; // unclosed brace + var
    const syntaxResult = quickSyntaxCheck("src/a.ts", content);
    const pipelineResult = runLintPipeline("src/a.ts", content, [
      makeNoVarRule("error"),
    ]);
    expect(syntaxResult.valid).toBe(false);
    expect(pipelineResult.passed).toBe(false);
  });

  it("clean file passes both quickSyntaxCheck and the pipeline", () => {
    const content = "const x = 1\nexport default x";
    const syntaxResult = quickSyntaxCheck("src/a.ts", content);
    const pipelineResult = runLintPipeline("src/a.ts", content, [
      makeNoVarRule(),
      makeNoConsoleRule(),
      makeMaxLineLengthRule(),
    ]);
    expect(syntaxResult.valid).toBe(true);
    expect(pipelineResult.passed).toBe(true);
  });
});
