import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import securityPlugin from 'eslint-plugin-security'

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/*.d.ts',
      '**/*.map',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.yarn/**',
      '**/*.vue',
    ],
  },
  // Base rules for all source files (no type-aware linting)
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        NodeJS: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        console: 'readonly',
        describe: 'readonly',
        expect: 'readonly',
        fetch: 'readonly',
        global: 'readonly',
        it: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setImmediate: 'readonly',
        test: 'readonly',
        vi: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'security': securityPlugin,
    },
    rules: {
      // Type safety: no explicit `any`
      '@typescript-eslint/no-explicit-any': 'error',
      // Import clarity: enforce type-only imports for type-only usage
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      // Security: detect common vulnerability patterns
      'security/detect-buffer-noassert': 'error',
      'security/detect-child-process': 'warn',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-no-csrf-before-method-override': 'error',
      'security/detect-non-literal-fs-filename': 'off',    // too noisy for framework code
      'security/detect-non-literal-regexp': 'off',          // common pattern in this codebase
      'security/detect-non-literal-require': 'off',         // ESM dynamic imports are intentional
      'security/detect-object-injection': 'off',             // too many false positives
      'security/detect-possible-timing-attacks': 'warn',
      'security/detect-pseudoRandomBytes': 'warn',
      'security/detect-unsafe-regex': 'error',
    },
  },
  // Type-aware rules for TypeScript source files only (requires tsconfig project).
  // Test files are excluded from all package tsconfigs, so they cannot use project-based parsing.
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Async safety: catch unhandled promise rejections
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
]
