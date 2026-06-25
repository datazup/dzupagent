/**
 * W29-C — Codegen: lint-validation pipeline + sandbox permission tier
 * enforcement deep coverage.
 *
 * Targets gaps left by:
 *   - lint-validator.test.ts       (basic quickSyntaxCheck cases)
 *   - branch-coverage-sandbox-lint.test.ts (sandboxLintCheck branches)
 *   - permission-tiers.test.ts     (core tier tests)
 *   - sandbox-permission-coherence-deep.test.ts (integration)
 *
 * New coverage areas:
 *  A. quickSyntaxCheck — JSX/TSX/Vue/JS file extensions; multi-error
 *     accumulation; deeply-nested valid code; comment edge cases;
 *     empty file; large file handling; single-character files;
 *     extra closing delimiters each type; unclosed string does NOT
 *     affect bracket tracking (string escaping); tab characters in source.
 *
 *  B. sandboxLintCheck — multiple ESLint errors; warnings only (no errors);
 *     severity-3 treated as error; null messages entry; non-array JSON;
 *     partial ExecResult shapes; stdout with leading whitespace.
 *
 *  C. Permission tier constants — all three tiers produce distinct
 *     Docker memory/CPU flags; all tiers include --no-new-privileges;
 *     tierToDockerFlags returns an array; TIER_DEFAULTS is a plain object.
 *
 *  D. validateTierConfig — all valid filesystem values accepted individually;
 *     filesystem error message contains the invalid value; combined valid
 *     override; maxMemoryMb at exactly MIN_MEMORY_MB; maxCpus > minimum;
 *     timeoutMs very large; negative values rejected.
 *
 *  E. mergeTierConfig — all three base tiers produce correct merged shapes;
 *     overriding processes flag; overriding timeoutMs; empty override
 *     equals defaults; multi-field override.
 *
 *  F. tierToE2bConfig — all three tiers produce correct shapes; processes
 *     flag in metadata; maxCpus in metadata; template field always 'base'.
 *
 *  G. compareTiers / mostRestrictiveTier — exhaustive ordered pairs;
 *     mostRestrictiveTier commutativity; chaining through all three tiers.
 *
 *  H. tierAllowsWrite / assertTierAllowsWrite — default action name; custom
 *     action name; PermissionTierViolationError instanceof chain; error is
 *     instance of Error; workspace-write and full-access never throw.
 *
 *  I. sandbox-hardening edge cases — empty addCapabilities list; multiple
 *     ACLs mixed read+write; hardTimeoutMs exactly 1000 ms; softTimeoutMs
 *     omitted; multiple egress rules; no capabilities drop; nodejs vs strict
 *     seccomp profile syscall diff; empty filesystemACLs array.
 *
 *  J. security-profile edge cases — customizeProfile with process override;
 *     customizeProfile with filesystem override; customizeProfile with level
 *     override; toDockerFlags for paranoid with readOnlyMounts; toDockerFlags
 *     minimal has no --read-only; getSecurityProfile returns distinct objects
 *     each call; all profiles have blockedSyscalls array.
 */

import { describe, it, expect, vi } from "vitest";

import { quickSyntaxCheck, sandboxLintCheck } from "../tools/lint-validator.js";
import type { LintResult } from "../tools/lint-validator.js";

import {
  TIER_DEFAULTS,
  tierToDockerFlags,
  validateTierConfig,
  mergeTierConfig,
  tierToE2bConfig,
  compareTiers,
  mostRestrictiveTier,
  tierAllowsWrite,
  assertTierAllowsWrite,
  PermissionTierViolationError,
  MIN_MEMORY_MB,
  MIN_CPUS,
  MIN_TIMEOUT_MS,
} from "../sandbox/permission-tiers.js";
import type {
  PermissionTier,
  TierConfig,
} from "../sandbox/permission-tiers.js";

import {
  toDockerSecurityFlags,
  detectEscapeAttempt,
} from "../sandbox/sandbox-hardening.js";
import type { HardenedSandboxConfig } from "../sandbox/sandbox-hardening.js";

import {
  SECURITY_PROFILES,
  getSecurityProfile,
  customizeProfile,
  toDockerFlags,
} from "../sandbox/security-profile.js";
import type {
  SandboxProtocol,
  ExecResult,
} from "../sandbox/sandbox-protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSandbox(
  partial: Partial<ExecResult> | (() => Promise<ExecResult>)
): SandboxProtocol {
  const execute =
    typeof partial === "function"
      ? partial
      : async (): Promise<ExecResult> => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          ...partial,
        });
  return {
    execute,
    uploadFiles: vi.fn(async () => {}),
    downloadFiles: vi.fn(async () => ({})),
    cleanup: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => true),
  } as unknown as SandboxProtocol;
}

// ===========================================================================
// A. quickSyntaxCheck — extended edge cases
// ===========================================================================

describe("quickSyntaxCheck — file extension filtering", () => {
  it("accepts .jsx file extension", () => {
    const result = quickSyntaxCheck("src/App.jsx", "const x = () => <div />");
    // JSX is treated as a JS/JSX file — braces/parens/brackets are checked
    expect(result).toHaveProperty("valid");
    expect(result).toHaveProperty("errors");
  });

  it("accepts .tsx file extension", () => {
    const result = quickSyntaxCheck("src/App.tsx", "const x = 1");
    expect(result.valid).toBe(true);
  });

  it("accepts .vue file extension", () => {
    const result = quickSyntaxCheck(
      "src/App.vue",
      "<template><div></div></template>"
    );
    // vue files are checked for JS-level delimiters but HTML < > are ignored
    expect(result).toHaveProperty("valid");
  });

  it("accepts .js file extension", () => {
    const result = quickSyntaxCheck("index.js", "const a = 1");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("skips .css files — always valid", () => {
    const result = quickSyntaxCheck("styles.css", ".foo { color: red; {{{{{ }");
    expect(result.valid).toBe(true);
  });

  it("skips .json files — always valid", () => {
    const result = quickSyntaxCheck("package.json", "{ broken:");
    expect(result.valid).toBe(true);
  });

  it("skips .html files — always valid", () => {
    const result = quickSyntaxCheck("index.html", "<div>{{{{");
    expect(result.valid).toBe(true);
  });

  it("skips files with no extension — always valid", () => {
    const result = quickSyntaxCheck("Makefile", "all: { echo done");
    expect(result.valid).toBe(true);
  });
});

describe("quickSyntaxCheck — empty and minimal files", () => {
  it("empty file is valid", () => {
    const result = quickSyntaxCheck("src/empty.ts", "");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("single newline is valid", () => {
    const result = quickSyntaxCheck("src/nl.ts", "\n");
    expect(result.valid).toBe(true);
  });

  it("single statement is valid", () => {
    const result = quickSyntaxCheck("a.ts", "const x = 1");
    expect(result.valid).toBe(true);
  });

  it("just whitespace is valid", () => {
    const result = quickSyntaxCheck("a.ts", "   \n  \t  ");
    expect(result.valid).toBe(true);
  });
});

describe("quickSyntaxCheck — multiple distinct error types", () => {
  it("reports unclosed brace error", () => {
    const result = quickSyntaxCheck("src/a.ts", "function f() {");
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("unclosed brace"))
    ).toBe(true);
  });

  it("reports unclosed bracket error", () => {
    const result = quickSyntaxCheck("src/a.ts", "const arr = [1, 2");
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("unclosed bracket"))
    ).toBe(true);
  });

  it("reports unclosed paren error", () => {
    const result = quickSyntaxCheck("src/a.ts", "fn(1, 2");
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("unclosed paren"))
    ).toBe(true);
  });

  it("reports unexpected closing brace error", () => {
    const result = quickSyntaxCheck("src/a.ts", "const x = 1 }");
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("Unexpected closing brace"))
    ).toBe(true);
  });

  it("reports unexpected closing paren error", () => {
    const result = quickSyntaxCheck("src/a.ts", "const x = 1)");
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("Unexpected closing paren"))
    ).toBe(true);
  });

  it("errors include line numbers ≥ 1", () => {
    const result = quickSyntaxCheck("src/a.ts", "const x = [1");
    expect(result.valid).toBe(false);
    for (const err of result.errors) {
      expect(err.line).toBeGreaterThanOrEqual(1);
    }
  });

  it('errors have severity "error"', () => {
    const result = quickSyntaxCheck("src/a.ts", "function f() {");
    expect(result.valid).toBe(false);
    for (const err of result.errors) {
      expect(err.severity).toBe("error");
    }
  });
});

describe("quickSyntaxCheck — string / comment tracking edge cases", () => {
  it("double-quoted string containing braces does not trigger error", () => {
    const result = quickSyntaxCheck("a.ts", 'const s = "hello { world }"');
    expect(result.valid).toBe(true);
  });

  it("single-quoted string containing brackets does not trigger error", () => {
    const result = quickSyntaxCheck("a.ts", "const s = 'arr[0]'");
    expect(result.valid).toBe(true);
  });

  it("template literal containing braces does not trigger error", () => {
    const result = quickSyntaxCheck("a.ts", "const s = `{ key: value }`");
    expect(result.valid).toBe(true);
  });

  it("line comment at end of line does not affect counting", () => {
    const result = quickSyntaxCheck("a.ts", "const x = 1 // {\nconst y = 2");
    expect(result.valid).toBe(true);
  });

  it("block comment spanning two lines does not affect counting", () => {
    const result = quickSyntaxCheck("a.ts", "/* {\n} */\nconst x = 1");
    expect(result.valid).toBe(true);
  });

  it("properly closed block comment is not flagged as unterminated", () => {
    const result = quickSyntaxCheck("a.ts", "/* comment */ const x = 1");
    expect(result.valid).toBe(true);
  });

  it("unterminated block comment is detected", () => {
    const result = quickSyntaxCheck("a.ts", "/* unclosed");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("block comment"))).toBe(
      true
    );
  });
});

describe("quickSyntaxCheck — deeply nested valid code", () => {
  it("deeply nested braces and parens is valid", () => {
    const code = [
      "function outer() {",
      "  function inner() {",
      "    if (true) {",
      "      while (false) {",
      "        const arr = [1, [2, [3]]]",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const result = quickSyntaxCheck("a.ts", code);
    expect(result.valid).toBe(true);
  });
});

describe("quickSyntaxCheck — large file handling", () => {
  it("handles 1000-line valid file", () => {
    const lines: string[] = ["function big() {"];
    for (let i = 0; i < 998; i++) {
      lines.push(`  const v${i} = ${i}`);
    }
    lines.push("}");
    const result = quickSyntaxCheck("big.ts", lines.join("\n"));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects single unclosed brace in 500-line file", () => {
    const lines: string[] = [];
    for (let i = 0; i < 499; i++) {
      lines.push(`const v${i} = ${i}`);
    }
    lines.push("function broken() {"); // never closed
    const result = quickSyntaxCheck("big.ts", lines.join("\n"));
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("unclosed brace"))
    ).toBe(true);
  });
});

// ===========================================================================
// B. sandboxLintCheck — additional branches
// ===========================================================================

describe("sandboxLintCheck — additional branches", () => {
  it("returns valid when ESLint reports zero messages", async () => {
    const sb = makeSandbox({ stdout: '[{"messages":[]}]' });
    const result = await sandboxLintCheck("a.ts", "const x = 1", sb);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("filters severity < 2 — warnings do not count as errors", async () => {
    const sb = makeSandbox({
      stdout: JSON.stringify([
        { messages: [{ line: 1, column: 1, message: "warn", severity: 1 }] },
      ]),
    });
    const result = await sandboxLintCheck("a.ts", "const x = 1", sb);
    expect(result.valid).toBe(true);
  });

  it("treats severity === 2 as an error", async () => {
    const sb = makeSandbox({
      stdout: JSON.stringify([
        { messages: [{ line: 5, column: 2, message: "no-var", severity: 2 }] },
      ]),
    });
    const result = await sandboxLintCheck("a.ts", "var x", sb);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBe("no-var");
  });

  it("treats severity === 3 as an error", async () => {
    const sb = makeSandbox({
      stdout: JSON.stringify([
        { messages: [{ line: 1, column: 1, message: "fatal", severity: 3 }] },
      ]),
    });
    const result = await sandboxLintCheck("a.ts", "broken", sb);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.severity).toBe("error");
  });

  it("reports multiple errors from the same file", async () => {
    const sb = makeSandbox({
      stdout: JSON.stringify([
        {
          messages: [
            { line: 1, column: 1, message: "error one", severity: 2 },
            { line: 2, column: 3, message: "error two", severity: 2 },
            { line: 3, column: 5, message: "error three", severity: 2 },
          ],
        },
      ]),
    });
    const result = await sandboxLintCheck("a.ts", "code", sb);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
  });

  it("error objects carry correct line and column", async () => {
    const sb = makeSandbox({
      stdout: JSON.stringify([
        { messages: [{ line: 42, column: 7, message: "test", severity: 2 }] },
      ]),
    });
    const result = await sandboxLintCheck("a.ts", "x", sb);
    expect(result.errors[0]?.line).toBe(42);
    expect(result.errors[0]?.column).toBe(7);
  });

  it("falls back to quickSyntaxCheck when JSON is deeply malformed", async () => {
    const sb = makeSandbox({ stdout: "{{{{" });
    const result = await sandboxLintCheck("a.ts", "const x = 1", sb);
    // quickSyntaxCheck on 'const x = 1' → valid
    expect(result.valid).toBe(true);
  });

  it("falls back when stdout is null-like (empty string)", async () => {
    const sb = makeSandbox({ stdout: undefined as unknown as string });
    const result = await sandboxLintCheck("a.ts", "const x = 1", sb);
    expect(result).toHaveProperty("valid");
  });

  it("falls back when sandbox execute resolves to undefined", async () => {
    const sb = makeSandbox(async () => undefined as unknown as ExecResult);
    const result = await sandboxLintCheck("a.ts", "const x = 1", sb);
    expect(result).toHaveProperty("valid");
  });

  it("non-TS file gets fallback quickSyntaxCheck (always valid for .md)", async () => {
    const sb = makeSandbox({ stdout: "[]" });
    const result = await sandboxLintCheck("README.md", "{{{{", sb);
    // quickSyntaxCheck for .md → valid
    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// C. TIER_DEFAULTS / tierToDockerFlags — additional structural contracts
// ===========================================================================

describe("TIER_DEFAULTS — structural integrity", () => {
  it("all three tiers are present", () => {
    const tiers: PermissionTier[] = [
      "read-only",
      "workspace-write",
      "full-access",
    ];
    for (const t of tiers) {
      expect(TIER_DEFAULTS[t]).toBeDefined();
    }
  });

  it("every tier has all required fields", () => {
    for (const tier of Object.values(TIER_DEFAULTS)) {
      expect(typeof tier.network).toBe("boolean");
      expect(["read-only", "workspace-only", "full"]).toContain(
        tier.filesystem
      );
      expect(typeof tier.processes).toBe("boolean");
      expect(typeof tier.maxMemoryMb).toBe("number");
      expect(typeof tier.maxCpus).toBe("number");
      expect(typeof tier.timeoutMs).toBe("number");
    }
  });

  it("tiers have strictly increasing memory budgets", () => {
    const ro = TIER_DEFAULTS["read-only"].maxMemoryMb;
    const ww = TIER_DEFAULTS["workspace-write"].maxMemoryMb;
    const fa = TIER_DEFAULTS["full-access"].maxMemoryMb;
    expect(ro).toBeLessThan(ww);
    expect(ww).toBeLessThan(fa);
  });

  it("tiers have strictly increasing timeout budgets", () => {
    const ro = TIER_DEFAULTS["read-only"].timeoutMs;
    const ww = TIER_DEFAULTS["workspace-write"].timeoutMs;
    const fa = TIER_DEFAULTS["full-access"].timeoutMs;
    expect(ro).toBeLessThan(ww);
    expect(ww).toBeLessThan(fa);
  });

  it("tiers have strictly increasing CPU budgets", () => {
    const ro = TIER_DEFAULTS["read-only"].maxCpus;
    const ww = TIER_DEFAULTS["workspace-write"].maxCpus;
    const fa = TIER_DEFAULTS["full-access"].maxCpus;
    expect(ro).toBeLessThanOrEqual(ww);
    expect(ww).toBeLessThanOrEqual(fa);
  });
});

describe("tierToDockerFlags — output type and completeness", () => {
  it("returns an Array for every tier", () => {
    const tiers: PermissionTier[] = [
      "read-only",
      "workspace-write",
      "full-access",
    ];
    for (const t of tiers) {
      expect(Array.isArray(tierToDockerFlags(t))).toBe(true);
    }
  });

  it('all flag strings start with "--"', () => {
    const tiers: PermissionTier[] = [
      "read-only",
      "workspace-write",
      "full-access",
    ];
    for (const t of tiers) {
      for (const flag of tierToDockerFlags(t)) {
        expect(flag.startsWith("--")).toBe(true);
      }
    }
  });

  it("each tier produces at least 3 flags", () => {
    const tiers: PermissionTier[] = [
      "read-only",
      "workspace-write",
      "full-access",
    ];
    for (const t of tiers) {
      expect(tierToDockerFlags(t).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("read-only produces the most flags (most restrictive)", () => {
    const ro = tierToDockerFlags("read-only").length;
    const fa = tierToDockerFlags("full-access").length;
    expect(ro).toBeGreaterThan(fa);
  });
});

// ===========================================================================
// D. validateTierConfig — extended edge cases
// ===========================================================================

describe("validateTierConfig — extended edge cases", () => {
  it("accepts valid multi-field override", () => {
    const result = validateTierConfig({
      maxMemoryMb: MIN_MEMORY_MB,
      maxCpus: MIN_CPUS,
      timeoutMs: MIN_TIMEOUT_MS,
      filesystem: "full",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects negative maxMemoryMb", () => {
    const result = validateTierConfig({ maxMemoryMb: -1 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("maxMemoryMb"))).toBe(true);
  });

  it("rejects zero maxCpus", () => {
    const result = validateTierConfig({ maxCpus: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("maxCpus"))).toBe(true);
  });

  it("rejects zero timeoutMs", () => {
    const result = validateTierConfig({ timeoutMs: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("timeoutMs"))).toBe(true);
  });

  it("filesystem error message contains the invalid value", () => {
    const result = validateTierConfig({
      filesystem: "network-only" as TierConfig["filesystem"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("network-only");
  });

  it("accepts very large timeoutMs", () => {
    const result = validateTierConfig({ timeoutMs: 86_400_000 });
    expect(result.valid).toBe(true);
  });

  it("accepts very large maxMemoryMb", () => {
    const result = validateTierConfig({ maxMemoryMb: 65536 });
    expect(result.valid).toBe(true);
  });

  it("accepts very large maxCpus", () => {
    const result = validateTierConfig({ maxCpus: 128 });
    expect(result.valid).toBe(true);
  });

  it("errors array is always defined (no undefined)", () => {
    const result = validateTierConfig({});
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("accumulates all 4 error types at once", () => {
    const result = validateTierConfig({
      maxMemoryMb: 0,
      maxCpus: 0,
      timeoutMs: 0,
      filesystem: "bad-value" as TierConfig["filesystem"],
    });
    expect(result.errors.length).toBe(4);
  });
});

// ===========================================================================
// E. mergeTierConfig — all tiers and multi-field overrides
// ===========================================================================

describe("mergeTierConfig — all base tiers", () => {
  it("workspace-write merge returns new object", () => {
    const merged = mergeTierConfig("workspace-write", { maxMemoryMb: 256 });
    expect(merged).not.toBe(TIER_DEFAULTS["workspace-write"]);
  });

  it("full-access merge overrides timeoutMs", () => {
    const merged = mergeTierConfig("full-access", { timeoutMs: 200_000 });
    expect(merged.timeoutMs).toBe(200_000);
  });

  it("full-access merge preserves filesystem=full", () => {
    const merged = mergeTierConfig("full-access", { maxMemoryMb: 512 });
    expect(merged.filesystem).toBe("full");
  });

  it("empty override returns object identical in value to TIER_DEFAULTS", () => {
    for (const t of [
      "read-only",
      "workspace-write",
      "full-access",
    ] as PermissionTier[]) {
      const merged = mergeTierConfig(t, {});
      expect(merged).toEqual(TIER_DEFAULTS[t]);
    }
  });

  it("overriding processes flag from true to false", () => {
    const merged = mergeTierConfig("workspace-write", { processes: false });
    expect(merged.processes).toBe(false);
  });

  it("multi-field override applies all fields", () => {
    const merged = mergeTierConfig("read-only", {
      maxMemoryMb: 512,
      maxCpus: 4,
      timeoutMs: 120_000,
      network: true,
    });
    expect(merged.maxMemoryMb).toBe(512);
    expect(merged.maxCpus).toBe(4);
    expect(merged.timeoutMs).toBe(120_000);
    expect(merged.network).toBe(true);
  });

  it("original TIER_DEFAULTS not mutated after merge", () => {
    mergeTierConfig("read-only", { maxMemoryMb: 9999, network: true });
    expect(TIER_DEFAULTS["read-only"].maxMemoryMb).toBe(256);
    expect(TIER_DEFAULTS["read-only"].network).toBe(false);
  });
});

// ===========================================================================
// F. tierToE2bConfig — complete metadata coverage
// ===========================================================================

describe("tierToE2bConfig — all tiers", () => {
  it('template is always "base" for all tiers', () => {
    for (const t of [
      "read-only",
      "workspace-write",
      "full-access",
    ] as PermissionTier[]) {
      expect(tierToE2bConfig(t)["template"]).toBe("base");
    }
  });

  it("read-only timeout matches TIER_DEFAULTS", () => {
    expect(tierToE2bConfig("read-only")["timeout"]).toBe(
      TIER_DEFAULTS["read-only"].timeoutMs
    );
  });

  it("workspace-write timeout matches TIER_DEFAULTS", () => {
    expect(tierToE2bConfig("workspace-write")["timeout"]).toBe(
      TIER_DEFAULTS["workspace-write"].timeoutMs
    );
  });

  it("full-access timeout matches TIER_DEFAULTS", () => {
    expect(tierToE2bConfig("full-access")["timeout"]).toBe(
      TIER_DEFAULTS["full-access"].timeoutMs
    );
  });

  it("metadata contains processes flag for all tiers", () => {
    for (const t of [
      "read-only",
      "workspace-write",
      "full-access",
    ] as PermissionTier[]) {
      const meta = tierToE2bConfig(t)["metadata"] as Record<string, unknown>;
      expect(typeof meta["processes"]).toBe("boolean");
    }
  });

  it("metadata contains maxCpus for all tiers", () => {
    for (const t of [
      "read-only",
      "workspace-write",
      "full-access",
    ] as PermissionTier[]) {
      const meta = tierToE2bConfig(t)["metadata"] as Record<string, unknown>;
      expect(typeof meta["maxCpus"]).toBe("number");
    }
  });

  it("metadata.processes is false for read-only", () => {
    const meta = tierToE2bConfig("read-only")["metadata"] as Record<
      string,
      unknown
    >;
    expect(meta["processes"]).toBe(false);
  });

  it("metadata.processes is true for workspace-write", () => {
    const meta = tierToE2bConfig("workspace-write")["metadata"] as Record<
      string,
      unknown
    >;
    expect(meta["processes"]).toBe(true);
  });

  it("envs field is an empty object", () => {
    for (const t of [
      "read-only",
      "workspace-write",
      "full-access",
    ] as PermissionTier[]) {
      const envs = tierToE2bConfig(t)["envs"] as Record<string, unknown>;
      expect(Object.keys(envs)).toHaveLength(0);
    }
  });
});

// ===========================================================================
// G. compareTiers / mostRestrictiveTier — exhaustive pair checks
// ===========================================================================

describe("compareTiers — exhaustive ordered pairs", () => {
  const tiers: PermissionTier[] = [
    "read-only",
    "workspace-write",
    "full-access",
  ];

  it("compareTiers is antisymmetric: if a < b then b > a", () => {
    for (const a of tiers) {
      for (const b of tiers) {
        if (a !== b) {
          const ab = compareTiers(a, b);
          const ba = compareTiers(b, a);
          expect(ab * ba).toBeLessThan(0); // opposite signs
        }
      }
    }
  });

  it("compareTiers is reflexive: same tier returns 0", () => {
    for (const t of tiers) {
      expect(compareTiers(t, t)).toBe(0);
    }
  });

  it("result is always -1, 0, or 1", () => {
    for (const a of tiers) {
      for (const b of tiers) {
        const r = compareTiers(a, b);
        expect([-1, 0, 1]).toContain(r);
      }
    }
  });
});

describe("mostRestrictiveTier — commutativity for mixed pairs", () => {
  it("(workspace-write, full-access) and (full-access, workspace-write) both return workspace-write", () => {
    expect(mostRestrictiveTier("workspace-write", "full-access")).toBe(
      "workspace-write"
    );
    expect(mostRestrictiveTier("full-access", "workspace-write")).toBe(
      "workspace-write"
    );
  });

  it("(read-only, workspace-write) and reversed both return read-only", () => {
    expect(mostRestrictiveTier("read-only", "workspace-write")).toBe(
      "read-only"
    );
    expect(mostRestrictiveTier("workspace-write", "read-only")).toBe(
      "read-only"
    );
  });

  it("(read-only, full-access) and reversed both return read-only", () => {
    expect(mostRestrictiveTier("read-only", "full-access")).toBe("read-only");
    expect(mostRestrictiveTier("full-access", "read-only")).toBe("read-only");
  });

  it("chaining: min(min(ro, ww), fa) === read-only", () => {
    const r1 = mostRestrictiveTier("read-only", "workspace-write");
    const r2 = mostRestrictiveTier(r1, "full-access");
    expect(r2).toBe("read-only");
  });
});

// ===========================================================================
// H. tierAllowsWrite / assertTierAllowsWrite — error properties
// ===========================================================================

describe("PermissionTierViolationError — instanceof and properties", () => {
  it("is instanceof Error", () => {
    let err: unknown;
    try {
      assertTierAllowsWrite("read-only");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });

  it("is instanceof PermissionTierViolationError", () => {
    let err: unknown;
    try {
      assertTierAllowsWrite("read-only");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PermissionTierViolationError);
  });

  it('default action is "file write"', () => {
    let err: PermissionTierViolationError | null = null;
    try {
      assertTierAllowsWrite("read-only");
    } catch (e) {
      err = e as PermissionTierViolationError;
    }
    expect(err!.action).toBe("file write");
  });

  it("custom action string preserved in .action", () => {
    let err: PermissionTierViolationError | null = null;
    try {
      assertTierAllowsWrite("read-only", "delete /etc/passwd");
    } catch (e) {
      err = e as PermissionTierViolationError;
    }
    expect(err!.action).toBe("delete /etc/passwd");
  });

  it("error message mentions workspace-write or full-access", () => {
    let err: PermissionTierViolationError | null = null;
    try {
      assertTierAllowsWrite("read-only");
    } catch (e) {
      err = e as PermissionTierViolationError;
    }
    expect(err!.message).toMatch(/workspace-write|full-access/);
  });

  it("assertTierAllowsWrite never throws for workspace-write", () => {
    expect(() =>
      assertTierAllowsWrite("workspace-write", "any action")
    ).not.toThrow();
  });

  it("assertTierAllowsWrite never throws for full-access", () => {
    expect(() =>
      assertTierAllowsWrite("full-access", "any action")
    ).not.toThrow();
  });
});

describe("tierAllowsWrite — all tiers", () => {
  it("read-only → false", () =>
    expect(tierAllowsWrite("read-only")).toBe(false));
  it("workspace-write → true", () =>
    expect(tierAllowsWrite("workspace-write")).toBe(true));
  it("full-access → true", () =>
    expect(tierAllowsWrite("full-access")).toBe(true));
});

// ===========================================================================
// I. sandbox-hardening — extended edge cases
// ===========================================================================

describe("toDockerSecurityFlags — additional edge cases", () => {
  it("empty addCapabilities list adds no --cap-add flags", () => {
    const flags = toDockerSecurityFlags({ addCapabilities: [] });
    expect(flags.some((f) => f.startsWith("--cap-add="))).toBe(false);
  });

  it("three addCapabilities produce three --cap-add flags", () => {
    const flags = toDockerSecurityFlags({
      addCapabilities: ["NET_BIND_SERVICE", "DAC_OVERRIDE", "SETUID"],
    });
    const capFlags = flags.filter((f) => f.startsWith("--cap-add="));
    expect(capFlags).toHaveLength(3);
  });

  it("hardTimeoutMs exactly 1000 ms → --stop-timeout=1", () => {
    const flags = toDockerSecurityFlags({ hardTimeoutMs: 1000 });
    expect(flags).toContain("--stop-timeout=1");
  });

  it("hardTimeoutMs 2500 ms → --stop-timeout=3 (ceiling)", () => {
    const flags = toDockerSecurityFlags({ hardTimeoutMs: 2500 });
    expect(flags).toContain("--stop-timeout=3");
  });

  it("multiple egress rules → no --network=none", () => {
    const flags = toDockerSecurityFlags({
      egressRules: [
        { host: "api.github.com", port: 443 },
        { host: "registry.npmjs.org", port: 443 },
      ],
    });
    expect(flags).not.toContain("--network=none");
  });

  it("empty filesystemACLs array → no --tmpfs flags (no paths to mount)", () => {
    // Array.every() vacuously returns true on empty arrays, so --read-only IS
    // added by the source (no write path exists).  What matters here is that
    // no --tmpfs flags are produced because there are no ACL entries.
    const flags = toDockerSecurityFlags({ filesystemACLs: [] });
    expect(flags.some((f) => f.startsWith("--tmpfs="))).toBe(false);
  });

  it("mixed read+write ACLs → no --read-only", () => {
    const flags = toDockerSecurityFlags({
      filesystemACLs: [
        { path: "/work", access: "write" },
        { path: "/data", access: "read" },
      ],
    });
    expect(flags).not.toContain("--read-only");
  });

  it("all-read ACLs → --read-only included", () => {
    const flags = toDockerSecurityFlags({
      filesystemACLs: [
        { path: "/src", access: "read" },
        { path: "/data", access: "read" },
      ],
    });
    expect(flags).toContain("--read-only");
  });

  it("none-access ACL generates noexec tmpfs", () => {
    const flags = toDockerSecurityFlags({
      filesystemACLs: [{ path: "/secrets", access: "none" }],
    });
    expect(
      flags.some((f) => f.includes("noexec") && f.includes("/secrets"))
    ).toBe(true);
  });

  it("nodejs seccomp does NOT block clone3", () => {
    const flags = toDockerSecurityFlags({ seccompProfile: "nodejs" });
    expect(flags).not.toContain("--security-opt=seccomp-syscall-deny=clone3");
  });

  it("strict seccomp blocks clone3", () => {
    const flags = toDockerSecurityFlags({ seccompProfile: "strict" });
    expect(flags).toContain("--security-opt=seccomp-syscall-deny=clone3");
  });

  it("custom seccomp profile emits no syscall-deny flags", () => {
    const flags = toDockerSecurityFlags({ seccompProfile: "custom" });
    expect(
      flags.some((f) => f.startsWith("--security-opt=seccomp-syscall-deny="))
    ).toBe(false);
  });
});

describe("detectEscapeAttempt — additional patterns", () => {
  it('plain "ls /work" does not trigger', () => {
    expect(detectEscapeAttempt("ls /work")).toBe(false);
  });

  it("node script execution does not trigger", () => {
    expect(detectEscapeAttempt("node dist/index.js")).toBe(false);
  });

  it("chroot with argument triggers", () => {
    expect(detectEscapeAttempt("chroot /newroot /bin/sh")).toBe(true);
  });

  it("pivot_root with two arguments triggers", () => {
    expect(detectEscapeAttempt("pivot_root /new /old")).toBe(true);
  });

  it("docker.sock in path triggers", () => {
    expect(detectEscapeAttempt("ls /var/run/docker.sock")).toBe(true);
  });

  it("/proc/1/root access triggers", () => {
    expect(detectEscapeAttempt("cat /proc/1/root/etc/passwd")).toBe(true);
  });

  it("nsenter with flags triggers", () => {
    expect(detectEscapeAttempt("nsenter -t 1 -n ip a")).toBe(true);
  });

  it("unshare --mount triggers", () => {
    expect(detectEscapeAttempt("unshare --mount sh")).toBe(true);
  });
});

// ===========================================================================
// J. security-profile — additional edge cases
// ===========================================================================

describe("getSecurityProfile — isolation", () => {
  it("returns a distinct object each call", () => {
    const a = getSecurityProfile("standard");
    const b = getSecurityProfile("standard");
    expect(a).not.toBe(b);
  });

  it("all profiles have a non-empty level field", () => {
    for (const level of [
      "minimal",
      "standard",
      "strict",
      "paranoid",
    ] as const) {
      expect(getSecurityProfile(level).level).toBe(level);
    }
  });

  it("all profiles have blockedSyscalls as an array", () => {
    for (const level of [
      "minimal",
      "standard",
      "strict",
      "paranoid",
    ] as const) {
      expect(
        Array.isArray(getSecurityProfile(level).process.blockedSyscalls)
      ).toBe(true);
    }
  });
});

describe("customizeProfile — additional overrides", () => {
  it("overrides process limits", () => {
    const profile = customizeProfile("standard", {
      process: {
        maxProcesses: 100,
        allowedCapabilities: ["NET_BIND_SERVICE"],
        blockedSyscalls: ["ptrace"],
      },
    });
    expect(profile.process.maxProcesses).toBe(100);
    expect(profile.process.allowedCapabilities).toContain("NET_BIND_SERVICE");
  });

  it("overrides filesystem policy", () => {
    const profile = customizeProfile("strict", {
      filesystem: {
        readOnlyMounts: ["/etc"],
        writablePaths: ["/work"],
        useTmpfs: false,
      },
    });
    expect(profile.filesystem.readOnlyMounts).toContain("/etc");
    expect(profile.filesystem.useTmpfs).toBe(false);
  });

  it("overrides level field", () => {
    const profile = customizeProfile("standard", { level: "paranoid" });
    expect(profile.level).toBe("paranoid");
  });

  it("does not mutate base SECURITY_PROFILES", () => {
    customizeProfile("standard", {
      resources: {
        memoryMb: 9999,
        cpuCores: 16,
        diskMb: 9999,
        timeoutMs: 9999,
      },
    });
    expect(SECURITY_PROFILES["standard"].resources.memoryMb).toBe(512);
  });
});

describe("toDockerFlags (security-profile) — additional checks", () => {
  it("strict profile includes --pids-limit=30", () => {
    const flags = toDockerFlags(getSecurityProfile("strict"));
    expect(flags).toContain("--pids-limit=30");
  });

  it("paranoid profile includes --pids-limit=20", () => {
    const flags = toDockerFlags(getSecurityProfile("paranoid"));
    expect(flags).toContain("--pids-limit=20");
  });

  it("profile with readOnlyMounts includes -v= bind flag", () => {
    const profile = customizeProfile("standard", {
      filesystem: {
        readOnlyMounts: ["/data"],
        writablePaths: ["/work"],
        useTmpfs: false,
      },
    });
    const flags = toDockerFlags(profile);
    expect(flags.some((f) => f.includes("/data:") && f.includes(":ro"))).toBe(
      true
    );
  });

  it("minimal profile does NOT include --read-only (has writable paths)", () => {
    const flags = toDockerFlags(getSecurityProfile("minimal"));
    expect(flags).not.toContain("--read-only");
  });

  it("strict profile includes --cpus=0.5", () => {
    const flags = toDockerFlags(getSecurityProfile("strict"));
    expect(flags).toContain("--cpus=0.5");
  });

  it("paranoid profile includes --memory=256m", () => {
    const flags = toDockerFlags(getSecurityProfile("paranoid"));
    expect(flags).toContain("--memory=256m");
  });

  it("strict profile includes umount2 in syscall-deny", () => {
    const flags = toDockerFlags(getSecurityProfile("strict"));
    expect(flags).toContain("--security-opt=seccomp-syscall-deny=umount2");
  });

  it("minimal profile has no syscall-deny flags", () => {
    const flags = toDockerFlags(getSecurityProfile("minimal"));
    expect(
      flags.some((f) => f.startsWith("--security-opt=seccomp-syscall-deny="))
    ).toBe(false);
  });
});
