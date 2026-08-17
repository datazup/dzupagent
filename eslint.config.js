import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import securityPlugin from "eslint-plugin-security";
import { TEST_QUALITY_BASELINE } from "./eslint.baseline.js";

// The two test-quality selectors below are defined once and applied at two
// severities: `error` on files written since 2026-07-29, and `warn` on the
// pre-existing violations listed in eslint.baseline.js. Defining them once
// keeps the selector and its message from drifting between the two blocks.
const STATELESS_MEMORY_DOUBLE = {
  selector:
    "ObjectExpression:has(Property[key.name='get']):has(Property[key.name='put']):not(:has(Property[key.name='getKeyed']))",
  message:
    "Stateless memory double: a spy cannot observe what the store holds, only that it was called. Use createMemoryHarness() from @dzupagent/memory/testing, which wraps a real MemoryService over an InMemoryStore and exposes snapshot()/keys()/liveKeys() for assertions. If this object is not a memory service, add an eslint-disable-next-line with a reason.",
};

const VACUOUS_EVERY = {
  selector:
    "CallExpression[callee.property.name='toBe'][arguments.0.value=true][callee.object.callee.name='expect'][callee.object.arguments.0.callee.property.name='every']",
  message:
    "Vacuous on an empty array: [].every() is true, so this passes when the collection is empty. Assert the collection is non-empty first (expect(xs.length).toBeGreaterThan(0) or toHaveLength(n)), or use expect(xs.filter(p)).toHaveLength(n). If an empty collection is an acceptable pass here, add an eslint-disable-next-line with a reason.",
};

const SET_TIMEOUT_IN_TEST = {
  selector: "CallExpression[callee.name='setTimeout']",
  message:
    "Avoid real setTimeout in tests. Use vi.useFakeTimers() + vi.advanceTimersByTimeAsync() instead.",
};

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.vite/**",
      "**/*.d.ts",
      "**/*.map",
      "**/coverage/**",
      "**/.turbo/**",
      "**/.yarn/**",
    ],
  },
  // Base rules for all source files (no type-aware linting)
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        Buffer: "readonly",
        NodeJS: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        afterAll: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        console: "readonly",
        describe: "readonly",
        expect: "readonly",
        fetch: "readonly",
        global: "readonly",
        it: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
        setImmediate: "readonly",
        test: "readonly",
        vi: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      security: securityPlugin,
    },
    rules: {
      // Type safety: no explicit `any`
      "@typescript-eslint/no-explicit-any": "error",
      // Import clarity: enforce type-only imports for type-only usage
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // Security: detect common vulnerability patterns
      "security/detect-buffer-noassert": "error",
      "security/detect-child-process": "warn",
      "security/detect-disable-mustache-escape": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-new-buffer": "error",
      "security/detect-no-csrf-before-method-override": "error",
      "security/detect-non-literal-fs-filename": "off", // too noisy for framework code
      "security/detect-non-literal-regexp": "off", // common pattern in this codebase
      "security/detect-non-literal-require": "off", // ESM dynamic imports are intentional
      "security/detect-object-injection": "off", // too many false positives
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-pseudoRandomBytes": "warn",
      "security/detect-unsafe-regex": "error",
      // Billing guard: `buildModelTariff` prices an unknown model from the
      // generic `default` rate, so a caller that bills from it stores a
      // fabricated charge as the record of what was spent. Its safe sibling
      // `buildKnownModelTariff` returns undefined instead, letting the caller
      // report cost as unknown with a reason.
      //
      // The unsafe variant stays exported because non-billing callers
      // (estimates, capacity planning) legitimately want a number for any
      // model — this rule is what stops new billing code reaching for it.
      //
      // Scoped to this block on purpose: the test-file blocks below REPLACE
      // `no-restricted-syntax` rather than merging (see the layering note),
      // so this does not apply to tests — which is correct, since the unsafe
      // variant's own specs must call it.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='buildModelTariff']",
          message:
            "buildModelTariff invents a price for unknown models from the `default` rate. " +
            "Use buildKnownModelTariff for anything that bills, records, or reports spend. " +
            "If this site is a non-billing estimate, add an eslint-disable-next-line with a justification.",
        },
      ],
      // SSRF guard: route outbound HTTP through fetchWithOutboundUrlPolicy
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "Use fetchWithOutboundUrlPolicy from @dzupagent/core instead of raw fetch(). " +
            "If this site is intentionally allowlisted (vectordb adapters, sandbox clients), " +
            "add an eslint-disable-next-line comment with a justification.",
        },
      ],
    },
  },
  // Quality rules for test files.
  //
  // NOTE ON LAYERING: ESLint severity is per-config-object, and a later config
  // REPLACES an earlier `no-restricted-syntax` entry rather than merging with
  // it. So each severity needs its own block, and every block that matches a
  // file must list every selector meant to apply to it — omitting one silently
  // drops that rule for those files.
  //
  // M-05: Real timers cause non-deterministic / slow tests; prefer fake timers
  // (vi.useFakeTimers() + vi.advanceTimersByTimeAsync()). Justified exceptions
  // (real-time polling loops, real subprocess/IO timing) must carry an
  // eslint-disable-next-line with a reason. `warn` everywhere: 401 pre-existing
  // instances and no baseline taken, so gating it would just be noise.
  //
  // The other two rules FAIL the build. Both shipped as `warn` so the debt they
  // surfaced would not block CI, but a rule people learn to ignore decays into
  // noise — and both exist to catch defect classes that a stateless mock or an
  // empty collection can hide from a passing test. They error everywhere EXCEPT
  // the 194 files that already violated them when the baseline was taken
  // (eslint.baseline.js), so new and newly-touched code gets the real gate while
  // the backlog keeps warning. A bulk migration was measured and rejected: 341
  // warnings across 194 files, and ~15% of the vacuity hits are negative
  // predicates where an empty collection is a fair pass — judgement, not codemod.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**/*.ts"],
    ignores: TEST_QUALITY_BASELINE,
    rules: {
      "no-restricted-syntax": [
        "error",
        STATELESS_MEMORY_DOUBLE,
        VACUOUS_EVERY,
        SET_TIMEOUT_IN_TEST,
      ],
    },
  },
  // Grandfathered violations of the two rules above: keep warning, never fail.
  //
  // Warning is not the whole gate. eslint.baseline.js records HOW MANY
  // violations each listed file had, and scripts/run-package-lint.mjs fails the
  // lint when a recorded count rises, when an unlisted file has violations, or
  // when a count is stale after a fix. Without that ceiling a listed file could
  // accrue new violations forever at `warn` while `yarn lint` stayed green —
  // which is exactly how the stateless-memory-double count drifted 135 -> 139.
  //
  // Spread conditionally: ESLint rejects a config object whose `files` is an
  // empty array, and an empty baseline is the goal state.
  ...(TEST_QUALITY_BASELINE.length > 0
    ? [
        {
          files: TEST_QUALITY_BASELINE,
          rules: {
            "no-restricted-syntax": [
              "warn",
              STATELESS_MEMORY_DOUBLE,
              VACUOUS_EVERY,
              SET_TIMEOUT_IN_TEST,
            ],
          },
        },
      ]
    : []),
  // Type-aware rules for TypeScript source files only (requires tsconfig project).
  // Most package tsconfigs still exclude test files, so they cannot use
  // project-based parsing. (memory-ipc, security, rag and context now include
  // their tests; the exclusion here is kept uniform rather than per-package.)
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Async safety: catch unhandled promise rejections
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: true },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
];
