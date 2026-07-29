import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import securityPlugin from "eslint-plugin-security";

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
  // Quality rules for test files — warns without blocking CI immediately.
  // M-05: Real timers cause non-deterministic / slow tests; prefer fake timers
  // (vi.useFakeTimers() + vi.advanceTimersByTimeAsync()). Justified exceptions
  // (real-time polling loops, real subprocess/IO timing) must carry an
  // eslint-disable-next-line with a reason.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message:
            "Avoid real setTimeout in tests. Use vi.useFakeTimers() + vi.advanceTimersByTimeAsync() instead.",
        },
        {
          // A memory-service double built from bare spies — `get`/`put` present,
          // no `getKeyed`. A spy holds no state: it can observe *that* put() was
          // called, never *what the namespace now contains*. That blind spot hid
          // a family of defects in which an operation reported success while the
          // store was untouched (retention reporting `{ pruned: 2 }` while every
          // record survived and the namespace grew each sweep), and it hid them
          // because a mock cannot disagree with the code that drives it.
          //
          // Absence of `getKeyed` is the tell. It is now required on the store
          // contracts precisely because a record's key is not recoverable from
          // its value, so a double lacking it cannot model record identity —
          // which is what every one of those defects got wrong.
          //
          // `warn`, not `error`: 137 pre-existing instances across 75 files. The
          // point is to stop *new* ones and to make the migration visible, not
          // to fail the build on debt this rule was written to surface. Fix the
          // ones you touch; do not bulk-suppress.
          selector:
            "ObjectExpression:has(Property[key.name='get']):has(Property[key.name='put']):not(:has(Property[key.name='getKeyed']))",
          message:
            "Stateless memory double: a spy cannot observe what the store holds, only that it was called. Use createMemoryHarness() from @dzupagent/memory/testing, which wraps a real MemoryService over an InMemoryStore and exposes snapshot()/keys()/liveKeys() for assertions. If this object is not a memory service, add an eslint-disable-next-line with a reason.",
        },
      ],
    },
  },
  // Type-aware rules for TypeScript source files only (requires tsconfig project).
  // Test files are excluded from all package tsconfigs, so they cannot use project-based parsing.
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
