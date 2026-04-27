# Guardrails Architecture

## Scope
This document covers `packages/codegen/src/guardrails` and its direct execution path through `packages/codegen/src/pipeline/guardrail-gate.ts` and `packages/codegen/src/pipeline/pipeline-executor.ts`.

Within this scope, guardrails are static checks over generated file content (`GeneratedFile[]`) and project layout metadata (`ProjectStructure`). The module does not apply fixes automatically; it reports violations and lets pipeline consumers decide whether to block.

## Responsibilities
- Define shared guardrail contracts (`GuardrailContext`, `GuardrailRule`, `GuardrailReport`, violations, conventions).
- Execute a configurable set of rules with category/rule disables, fail-fast behavior, and per-rule severity overrides.
- Provide built-in rules for layering, deep import restrictions, naming conventions, secret detection, type-safety checks, and interface/class contract completeness.
- Learn naming/import conventions from sample files to parameterize rule behavior.
- Format reports as text or JSON for pipeline output and developer-facing diagnostics.
- Expose a gate function (`runGuardrailGate`) used by `PipelineExecutor` to pass/fail phases.

## Structure
- `guardrail-types.ts`: Core types for rules, contexts, reports, conventions, and project metadata.
- `guardrail-engine.ts`: `GuardrailEngine` with rule registration and evaluation.
- `convention-learner.ts`: `ConventionLearner` heuristics and per-instance caching.
- `guardrail-reporter.ts`: `GuardrailReporter` (`text`/`json`) with severity filtering and category grouping.
- `rules/index.ts`: Built-in rule factory exports and `createBuiltinRules()` ordering.
- `rules/layering-rule.ts`: Layer-direction checks for scoped package imports.
- `rules/import-restriction-rule.ts`: Deep-import restriction checks for configured scopes.
- `rules/naming-convention-rule.ts`: File/export naming checks driven by `ConventionSet`.
- `rules/security-rule.ts`: Regex-based hardcoded secret/token detection.
- `rules/type-safety-rule.ts`: Forbids `any`, `@ts-ignore`, `@ts-nocheck`; warns on `@ts-expect-error`.
- `rules/contract-compliance-rule.ts`: Regex/brace-depth interface vs class implementation checks.
- `index.ts`: Guardrails submodule barrel exports.

Related pipeline wiring in `src/pipeline`:
- `guardrail-gate.ts`: Adapts engine output to pass/fail gate semantics.
- `pipeline-executor.ts`: Runs guardrail checks after successful phase execution when configured.
- `gen-pipeline-builder.ts`: Stores guardrail gate config and inserts a `guardrail` phase descriptor.

## Runtime and Control Flow
1. A consumer creates a `GuardrailEngine`, typically registers rules via `createBuiltinRules()`, and optionally creates a `GuardrailReporter`.
2. A `GuardrailContext` is built from generated files, project structure, and conventions.
3. `GuardrailEngine.evaluate(context)` filters disabled categories/rules, executes rules in registration order, applies severity overrides, aggregates violations, and computes counts.
4. If `failFast` is enabled, evaluation stops on the first rule result that contains error-severity violations.
5. `runGuardrailGate({ engine, strictMode, reporter }, context)` determines gate result:
- Non-strict: pass when `errorCount === 0`.
- Strict: pass when `errorCount === 0 && warningCount === 0`.
6. In `PipelineExecutor`, when `guardrailGate` and `buildGuardrailContext` are provided, the gate runs after phase output is merged into state.
7. Executor stores gate summary under `state.__phase_<phaseId>_guardrail` and fails the phase with `summarizeGateResult(...)` when blocking conditions are met.

## Key APIs and Types
- `GuardrailEngineConfig`
- `failFast?: boolean`
- `disabledCategories?: GuardrailCategory[]`
- `disabledRules?: string[]`
- `severityOverrides?: Map<string, GuardrailSeverity>`

- `class GuardrailEngine`
- `addRule(rule: GuardrailRule): this`
- `addRules(rules: GuardrailRule[]): this`
- `getRules(): readonly GuardrailRule[]`
- `evaluate(context: GuardrailContext): GuardrailReport`

- `interface GuardrailContext`
- `files: GeneratedFile[]`
- `projectStructure: ProjectStructure`
- `conventions: ConventionSet`
- `repoMap?: RepoMap`

- `type GuardrailCategory`
- `'layering' | 'naming' | 'imports' | 'patterns' | 'security' | 'contracts' | 'file-structure'`

- `createBuiltinRules(): GuardrailRule[]`
- Rule IDs: `layering`, `import-restriction`, `naming-convention`, `security`, `type-safety`, `contract-compliance`

- `class ConventionLearner`
- `learn(files: GeneratedFile[]): ConventionSet`
- `getConventions(files: GeneratedFile[]): ConventionSet`
- `clearCache(): void`

- `class GuardrailReporter`
- `format(report: GuardrailReport): string`

- `runGuardrailGate(config, context): GuardrailGateResult`
- `summarizeGateResult(result): string`

## Dependencies
From `@dzupagent/codegen` package metadata and imports used by this module path:
- Runtime internal dependencies:
- `@dzupagent/core` (used by pipeline executor through `calculateBackoff` and skill context types).
- `@dzupagent/adapter-types` is a package dependency but not used directly by `src/guardrails`.

- Peer dependencies relevant to this area:
- None are directly imported by `src/guardrails` itself.
- Pipeline-side typing references `@langchain/core/tools` in `gen-pipeline-builder.ts`.

- Test/runtime tooling:
- Vitest for tests under `src/__tests__`.

## Integration Points
- Package root exports from `src/index.ts` re-export guardrail engine, types, reporter, learner, and built-in rule factories.
- `GenPipelineBuilder.withGuardrails(...)` captures `GuardrailGateConfig` and appends a `guardrail` phase descriptor.
- `PipelineExecutor` executes the guardrail gate after phase execution when `ExecutorConfig.guardrailGate` and `buildGuardrailContext` are set.
- `PipelineExecutor` writes guardrail outcome metadata into pipeline state and can stop pipeline execution on gate failure.

## Testing and Observability
Implemented test coverage includes:
- `src/__tests__/guardrails.test.ts`: engine behavior, all built-in rules, learner behavior, reporter formatting, and end-to-end built-in rule execution.
- `src/__tests__/guardrail-rules.test.ts`: detailed rule-specific edge cases and metadata assertions.
- `src/__tests__/pipeline-components.test.ts`: guardrail-gate behavior, summary formatting, and builder integration checks.
- `src/__tests__/pipeline-executor*.test.ts` files (outside guardrails folder) cover executor-level integration paths.

Observability characteristics in current code:
- Primary observability artifact is `GuardrailReport` (counts, violations, ruleResults).
- Optional textual/JSON rendering via `GuardrailReporter`.
- Pipeline-level state markers `__phase_<id>_guardrail` expose pass/error/warning counts.
- No dedicated metrics/tracing/log emitter in `src/guardrails` itself.

## Risks and TODOs
- All built-in checks are regex/line-oriented (non-AST). Complex syntax and multiline constructs can produce false positives/negatives.
- `GuardrailViolation.fix` and `autoFixable` exist in the type model, but built-in rules currently set `autoFixable: false` and do not provide executable fixes.
- `GuardrailContext.repoMap` is optional and currently unused by built-in rules.
- Layering uses static default layer lists and path-prefix package resolution; `ProjectStructure.allowedDependencies` is not consumed by the current layering rule implementation.
- `GuardrailReporter` category grouping maps categories from rule IDs using a static table; custom rule IDs default to `patterns` unless reporter logic is extended.
- Convention learning cache is instance-level and not keyed by project fingerprint; long-lived instances must call `clearCache()` when input corpus changes.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js.

