# `src/guardrails` Architecture

This document describes the current implementation in `packages/codegen/src/guardrails` as of **April 4, 2026**.

## 1. Scope

`src/guardrails` provides static architecture and code-quality checks for generated files in `@dzupagent/codegen`.

It is built around:

1. A rule engine (`GuardrailEngine`) that executes guardrail rules.
2. A conventions learner (`ConventionLearner`) that infers naming/import conventions from existing files.
3. A reporter (`GuardrailReporter`) that formats results as text or JSON.
4. Built-in rules for layering, imports, naming, security, type safety, and interface contract compliance.

This module is not the same as runtime safety guardrails in `@dzupagent/agent/src/guardrails`; this one is for generated source files and architecture policy validation.

## 2. File Map

| File | Responsibility |
|---|---|
| `guardrail-types.ts` | Type system for rules, context, violations, and report aggregation |
| `guardrail-engine.ts` | Rule registration, filtering, execution, severity overrides, fail-fast |
| `convention-learner.ts` | Heuristic convention inference + caching |
| `guardrail-reporter.ts` | Text/JSON rendering with grouping/filtering |
| `rules/layering-rule.ts` | Package-layer dependency direction enforcement |
| `rules/import-restriction-rule.ts` | Deep-import prevention for scoped packages |
| `rules/naming-convention-rule.ts` | File/export naming checks |
| `rules/security-rule.ts` | Hardcoded secret/token/password detection |
| `rules/type-safety-rule.ts` | `any` and TypeScript suppression checks |
| `rules/contract-compliance-rule.ts` | Regex-based `interface` vs `class implements` completeness checks |
| `rules/index.ts` | Built-in rule exports + `createBuiltinRules()` |
| `index.ts` | Public barrel exports for this submodule |

## 3. Core Contracts

`guardrail-types.ts` defines the shared contracts:

1. `GuardrailContext`:
   - `files: GeneratedFile[]` (path + content)
   - `projectStructure: ProjectStructure` (package map + root)
   - `conventions: ConventionSet`
   - optional `repoMap`
2. `GuardrailRule`:
   - static metadata (`id`, `name`, `description`, `severity`, `category`)
   - `check(context) => GuardrailResult`
3. `GuardrailViolation`:
   - includes `ruleId`, file/line, severity, suggestion, and optional `fix`.
4. `GuardrailReport`:
   - aggregate counts + flattened violations + per-rule map.

Important behavior:

1. Rule-level pass/fail is derived from whether error-severity violations exist.
2. Report-level `passed` is also error-only (`errorCount === 0`).
3. Warning/info violations never fail the report unless a higher-level gate enforces stricter policy.

## 4. Engine Design (`guardrail-engine.ts`)

`GuardrailEngine` is intentionally small and deterministic:

1. Rule registration:
   - `addRule(rule)` and `addRules(rules)`.
2. Execution filtering:
   - skips disabled categories and disabled rule IDs.
3. Severity override:
   - per-rule override map applied to produced violations.
4. Fail-fast:
   - when enabled, stops once a rule result contains any error-level violation.
5. Aggregation:
   - returns full counts (`errorCount`, `warningCount`, `infoCount`) and flattened violations list.

Operational notes:

1. Rule ordering matters when `failFast: true`.
2. `severityOverrides` can effectively reclassify rule outcomes at runtime.
3. The engine does not mutate input files and does not run auto-fixes.

## 5. Convention Learning (`convention-learner.ts`)

`ConventionLearner` infers defaults from existing files (extensions default: `.ts`, `.tsx`, `.js`, `.jsx`).

### 5.1 Learned dimensions

1. File naming:
   - chooses majority among `kebab-case`, `camelCase`, `PascalCase`, `snake_case`.
2. Export naming:
   - function case chosen by observed `export function` names.
   - const case chosen by observed `export const` names.
   - class case fixed as `PascalCase`.
3. Import style:
   - `indexOnly` inferred from deep vs index package import ratio.
   - `separateTypeImports` inferred from `import type` frequency.
4. Required patterns:
   - currently returns `[]` (not learned by default).

### 5.2 Caching model

1. `getConventions(files)` returns cached result if present.
2. `clearCache()` must be called to force re-learn.
3. If relevant files are below `minFiles`, defaults are returned.

### 5.3 Limitations

1. Heuristics are regex/line-based, not AST-based.
2. Cache is instance-wide, not keyed by project path or file set hash.
3. Deep import detection heuristic focuses on scoped package imports.

## 6. Reporting (`guardrail-reporter.ts`)

`GuardrailReporter` supports `text` and `json`.

### 6.1 Text mode

1. Header with pass/fail and counts.
2. Optional category grouping (default on).
3. Severity-first sorting (`error`, `warning`, `info`).
4. Optional inline suggestions.

### 6.2 JSON mode

1. Emits normalized structure:
   - `passed`
   - `summary`
   - `violations[]`
2. Omits internal structures like `ruleResults` map.

### 6.3 Notable behavior

1. `showInfo=false` filters displayed violations.
2. Summary counts still come from raw report counts, not filtered view.
3. Category grouping uses static `ruleId -> category` mapping; unknown IDs fall back to `patterns`.

## 7. Built-In Rules

`createBuiltinRules()` returns this default order:

1. `layering`
2. `import-restriction`
3. `naming-convention`
4. `security`
5. `type-safety`
6. `contract-compliance`

### 7.1 Layering Rule

Purpose:

1. Enforce dependency direction by layer index.
2. Prevent lower-layer package importing higher-layer package.

Defaults:

1. `@dzupagent/core`
2. `@dzupagent/memory`, `@dzupagent/context`, `@dzupagent/codegen`
3. `@dzupagent/agent`
4. `@dzupagent/server`

Notes:

1. Uses file path prefix to resolve source package.
2. Evaluates scoped `import ... from` statements.
3. Does not currently use `allowedDependencies` from `ProjectStructure`.

### 7.2 Import Restriction Rule

Purpose:

1. Block deep imports into internal package paths for configured scopes.
2. Encourage public entrypoint imports.

Defaults:

1. Scope: `@dzupagent`
2. Allowed subpaths: `dist`, `types`, plus `index(.ts|.js)`.

Notes:

1. Ignores non-scoped imports.
2. Checks only static `import ... from` patterns.

### 7.3 Naming Convention Rule

Purpose:

1. Validate file stem naming against learned convention.
2. Validate exported symbol naming:
   - classes/interfaces/enums/types: `PascalCase`
   - functions: learned function case
   - consts: flexible acceptance based on learned const case

Notes:

1. File-level violations are warnings.
2. Const naming violation uses info severity.
3. Ignores `index` and dotfiles for file naming.

### 7.4 Security Rule

Purpose:

1. Detect hardcoded sensitive material:
   - AWS keys, generic API keys/secrets/passwords
   - private keys, JWTs, DB URLs with credentials
   - GitHub and Slack tokens

Safeguards:

1. Skips test/spec and fixture files.
2. Skips obvious safe lines (`process.env`, placeholders, example/test comments).
3. Emits one violation per line max.

### 7.5 Type Safety Rule

Purpose:

1. Forbid `any` usage patterns:
   - `: any`
   - `as any`
   - `<any>`
2. Flag suppression directives:
   - `@ts-ignore` as error
   - `@ts-expect-error` as warning
   - `@ts-nocheck` as error

Scope:

1. Applies only to TypeScript-like files (`.ts`, `.tsx`, `.cts`, `.mts`).

### 7.6 Contract Compliance Rule

Purpose:

1. Parse `interface` declarations and `class ... implements ...`.
2. Ensure implemented classes contain all interface member names.

Approach:

1. Regex parsing with brace-depth tracking.
2. Cross-file matching within provided `context.files`.
3. Skips interface checks if interface definition is not in current file set.

Limitations:

1. Name-based matching only; no type-signature compatibility checking.
2. Complex TypeScript constructs can evade detection.

## 8. End-to-End Flow

Guardrail modules are integrated into codegen pipeline control flow:

1. `GenPipelineBuilder.withGuardrails(config)` stores a guardrail gate config and inserts a `guardrail` phase descriptor.
2. `PipelineExecutor` runs generation phase.
3. After successful phase execution, if `guardrailGate` + `buildGuardrailContext` are provided:
   - it builds `GuardrailContext`
   - runs `runGuardrailGate(config, context)`.
4. `runGuardrailGate` semantics:
   - normal mode: pass when `errorCount === 0`
   - strict mode: pass when `errorCount === 0 && warningCount === 0`.
5. Executor stores phase state:
   - `__phase_<id>_guardrail = { passed, errorCount, warningCount }`.
6. If gate fails:
   - phase is marked failed
   - summary from `summarizeGateResult()` becomes error text
   - pipeline stops with failed status.

## 9. Usage Examples

### 9.1 Basic engine + built-ins + reporter

```ts
import {
  GuardrailEngine,
  GuardrailReporter,
  ConventionLearner,
  createBuiltinRules,
  type GeneratedFile,
  type ProjectStructure,
} from '@dzupagent/codegen'

const files: GeneratedFile[] = [
  { path: 'packages/codegen/src/foo.ts', content: 'export const value: string = "ok"' },
]

const projectStructure: ProjectStructure = {
  rootDir: process.cwd(),
  packages: new Map([
    [
      '@dzupagent/codegen',
      { name: '@dzupagent/codegen', dir: 'packages/codegen/', allowedDependencies: [], entryPoints: ['index.ts'] },
    ],
  ]),
}

const conventions = new ConventionLearner().learn(files)
const engine = new GuardrailEngine().addRules(createBuiltinRules())
const report = engine.evaluate({ files, projectStructure, conventions })

const text = new GuardrailReporter({ format: 'text' }).format(report)
console.log(text)
```

### 9.2 Custom rule injection

```ts
import { GuardrailEngine, createBuiltinRules, type GuardrailRule } from '@dzupagent/codegen'

const noConsoleRule: GuardrailRule = {
  id: 'no-console',
  name: 'NoConsoleRule',
  description: 'Disallow console.log in generated files',
  severity: 'warning',
  category: 'patterns',
  check(context) {
    const violations = []
    for (const file of context.files) {
      const lines = file.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.includes('console.log(')) {
          violations.push({
            ruleId: 'no-console',
            file: file.path,
            line: i + 1,
            message: 'Avoid console.log in generated output',
            severity: 'warning',
            autoFixable: false,
          })
        }
      }
    }
    return { passed: true, violations }
  },
}

const engine = new GuardrailEngine({ disabledRules: ['naming-convention'] })
  .addRules(createBuiltinRules())
  .addRule(noConsoleRule)
```

### 9.3 Pipeline gate integration

```ts
import {
  PipelineExecutor,
  GuardrailEngine,
  GuardrailReporter,
  createBuiltinRules,
  ConventionLearner,
} from '@dzupagent/codegen'

const engine = new GuardrailEngine({ failFast: true }).addRules(createBuiltinRules())
const reporter = new GuardrailReporter({ format: 'text' })

const executor = new PipelineExecutor({
  guardrailGate: { engine, strictMode: false, reporter },
  buildGuardrailContext: (_phaseId, state) => {
    const files = (state['generatedFiles'] as Array<{ path: string; content: string }>) ?? []
    if (files.length === 0) return undefined
    return {
      files,
      projectStructure: {
        rootDir: '.',
        packages: new Map(),
      },
      conventions: new ConventionLearner().learn(files),
    }
  },
})
```

## 10. Common Use Cases

1. Enforce monorepo layering and import boundaries on generated patches before merge.
2. Block generated code that includes obvious secrets or unsafe TypeScript suppression.
3. Keep generated code style aligned with existing repository conventions.
4. Add project-specific policy checks with custom `GuardrailRule`.
5. Feed pass/fail and counts into deployment confidence logic.

## 11. References in Other Packages

As of April 4, 2026:

1. Export surface:
   - `@dzupagent/codegen` root exports all guardrail engine/types/rules and pipeline gate helpers.
2. Internal codegen usage:
   - `pipeline/guardrail-gate.ts` executes the engine and computes strict/non-strict pass.
   - `pipeline/pipeline-executor.ts` applies this gate after phase execution.
   - `pipeline/gen-pipeline-builder.ts` carries guardrail phase config.
3. `@dzupagent/server` usage:
   - `deploy/signal-checkers.ts` accepts `{ passed, errorCount, warningCount }`.
   - `deploy/confidence-calculator.ts` converts these counts into `guardrailCompliance` score.
   - `routes/deploy.ts` invokes signal computation route flow.
4. Cross-package import status:
   - no runtime source files in other packages directly instantiate `GuardrailEngine`/rules today.
   - current direct usage is primarily inside `@dzupagent/codegen`, with downstream packages consuming summarized guardrail signal data.

## 12. Test Coverage

### 12.1 Executed verification

Executed on **April 4, 2026**:

```bash
yarn workspace @dzupagent/codegen test -- \
  src/__tests__/guardrails.test.ts \
  src/__tests__/pipeline-executor.test.ts \
  src/__tests__/pipeline-components.test.ts \
  src/__tests__/convention-detector-and-adapters.test.ts
```

Result:

1. 4 test files.
2. 177 tests passed.
3. 0 failed.

### 12.2 Focused coverage run

Command:

```bash
yarn workspace @dzupagent/codegen test:coverage \
  --coverage.include=src/guardrails/**/*.ts \
  --coverage.include=src/pipeline/guardrail-gate.ts \
  --coverage.include=src/pipeline/pipeline-executor.ts \
  --coverage.thresholds.statements=0 \
  --coverage.thresholds.lines=0 \
  --coverage.thresholds.branches=0 \
  --coverage.thresholds.functions=0 \
  src/__tests__/guardrails.test.ts \
  src/__tests__/pipeline-executor.test.ts \
  src/__tests__/pipeline-components.test.ts \
  src/__tests__/convention-detector-and-adapters.test.ts
```

Coverage highlights:

1. Scoped total:
   - Statements: **93.73%**
   - Branches: **85.87%**
   - Functions: **98.41%**
   - Lines: **93.73%**
2. `src/guardrails`:
   - Statements/Lines: **97.23%**
   - Branches: **92.68%**
   - Functions: **100%**
3. `src/guardrails/rules`:
   - Statements/Lines: **95.84%**
   - Branches: **89.50%**
   - Functions: **100%**
4. Guardrail pipeline integration:
   - `pipeline/guardrail-gate.ts`: **100% lines**, **92.3% branches**
   - `pipeline/pipeline-executor.ts`: **84.07% lines**, **58.92% branches**

### 12.3 What is covered well

1. Engine config behavior:
   - disabled rules/categories
   - severity overrides
   - fail-fast behavior
2. All built-in rules have dedicated positive and negative tests.
3. Reporter behavior tested for:
   - text/json mode
   - grouping
   - info filtering
   - suggestions
   - unknown rule category fallback
4. Pipeline-level gate pass/fail behavior and summary rendering are tested.

### 12.4 Current gaps and risk areas

1. Rules are regex/line-based; AST-heavy TypeScript constructs are not exhaustively covered.
2. `GuardrailContext.repoMap` is currently unconsumed by built-in rules and has no direct test assertions.
3. `GuardrailViolation.fix` exists in types but built-in rules mark `autoFixable: false`; auto-fix execution path is effectively unused.
4. `pipeline/pipeline-executor.ts` still has lower branch coverage than guardrail modules themselves, especially around retry/timeout/checkpoint edge paths.
