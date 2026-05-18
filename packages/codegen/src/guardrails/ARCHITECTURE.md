# Guardrails Architecture

## Scope
This document describes the current guardrails subsystem in `packages/codegen/src/guardrails` and its runtime gate integration in `packages/codegen/src/pipeline`.

Covered files are `src/guardrails/guardrail-types.ts`, `src/guardrails/guardrail-engine.ts`, `src/guardrails/convention-learner.ts`, `src/guardrails/guardrail-reporter.ts`, `src/guardrails/rules/*`, and `src/guardrails/index.ts`. Related pipeline touchpoints are `src/pipeline/guardrail-gate.ts`, `src/pipeline/pipeline-executor.ts`, and `src/pipeline/gen-pipeline-builder.ts`.

The module scope is static analysis of `GeneratedFile[]` content and pass/fail gate decisions. It does not apply automatic code fixes.

## Responsibilities
- Define guardrail contracts for context, rules, violations, reports, project structure, and conventions.
- Execute registered rules through `GuardrailEngine` with fail-fast, rule/category disable lists, and per-rule severity overrides.
- Provide built-in rules for layering, deep import restrictions, naming conventions, secret detection, type-safety anti-patterns, and class/interface contract completeness.
- Learn conventions from file samples through `ConventionLearner`.
- Render guardrail output as text or JSON through `GuardrailReporter`.
- Expose gate semantics via `runGuardrailGate` for pipeline-level blocking.

## Structure
- `guardrail-types.ts`: Defines `GuardrailContext`, `GuardrailRule`, `GuardrailViolation`, `GuardrailReport`, `ProjectStructure`, `ConventionSet`, and category/severity unions. `GuardrailContext` includes optional `repoMap?: RepoMap`.
- `guardrail-engine.ts`: Implements `GuardrailEngineConfig` and `GuardrailEngine` with in-memory rule registration and report aggregation.
- `convention-learner.ts`: Implements `ConventionLearner` and `ConventionLearnerConfig` for inferred naming/export/import conventions with instance caching.
- `guardrail-reporter.ts`: Implements `GuardrailReporter` and `ReporterConfig` for text/JSON output, category grouping, and info-level filtering.
- `rules/index.ts`: Exports all rule factories and `createBuiltinRules()` in this order: `createLayeringRule()`, `createImportRestrictionRule()`, `createNamingConventionRule()`, `createSecurityRule()`, `createTypeSafetyRule()`, `createContractComplianceRule()`.
- `rules/layering-rule.ts`: Enforces dependency direction using configured/default package layers.
- `rules/import-restriction-rule.ts`: Blocks deep scoped-package imports except allowed subpaths.
- `rules/naming-convention-rule.ts`: Checks filename and export naming against `ConventionSet`.
- `rules/security-rule.ts`: Detects hardcoded credentials and tokens by regex patterns.
- `rules/type-safety-rule.ts`: Detects `any`, `@ts-ignore`, `@ts-nocheck`, and warning-level `@ts-expect-error`.
- `rules/contract-compliance-rule.ts`: Parses interface/class members via regex and brace depth to detect missing implementations.
- `index.ts`: Barrel export for types, engine, learner, reporter, and built-in rules.

## Runtime and Control Flow
1. The caller constructs `GuardrailEngine`, optionally with `GuardrailEngineConfig`, and registers rules.
2. The caller prepares `GuardrailContext` with `files`, `projectStructure`, `conventions`, and optional `repoMap`.
3. `GuardrailEngine.evaluate(context)` filters disabled rules/categories, runs enabled rules in order, applies severity overrides, computes per-rule pass state, and aggregates violation counts.
4. If `failFast` is enabled, evaluation stops after the first rule result containing error-severity violations.
5. Optional formatting runs through `GuardrailReporter.format(report)`.
6. Gate evaluation runs through `runGuardrailGate({ engine, strictMode?, reporter? }, context)`. Non-strict mode passes when `errorCount === 0`. Strict mode passes when `errorCount === 0 && warningCount === 0`.
7. `PipelineExecutor` executes guardrails only when `ExecutorConfig.guardrailGate` and `buildGuardrailContext` are both provided. The executor records `state.__phase_<phaseId>_guardrail = { passed, errorCount, warningCount }` and fails the phase when the gate blocks.

## Key APIs and Types
- Core types: `GuardrailCategory`, `GuardrailSeverity`, `GeneratedFile`, `ProjectStructure`, `PackageInfo`, `ConventionSet`, `FileNamingPattern`, `ExportNamingPattern`, `ImportStylePattern`, `RequiredPattern`, `GuardrailContext`, `GuardrailViolation`, `GuardrailResult`, `GuardrailRule`, `GuardrailReport`.
- Engine config: `GuardrailEngineConfig` with `failFast?: boolean`, `disabledCategories?: GuardrailCategory[]`, `disabledRules?: string[]`, `severityOverrides?: Map<string, GuardrailSeverity>`.
- Engine class: `GuardrailEngine.addRule(rule)`, `addRules(rules)`, `getRules()`, `evaluate(context)`.
- Convention learner: `ConventionLearner.learn(files)`, `getConventions(files)`, `clearCache()`.
- Reporter: `ReportFormat`, `ReporterConfig`, `GuardrailReporter.format(report)`.
- Built-in rule factories: `createBuiltinRules()`, `createLayeringRule(customLayers?)`, `createImportRestrictionRule(config?)`, `createNamingConventionRule()`, `createSecurityRule()`, `createTypeSafetyRule()`, `createContractComplianceRule()`.
- Gate APIs: `GuardrailGateConfig`, `GuardrailGateResult`, `runGuardrailGate(config, context)`, `summarizeGateResult(result)`.

## Dependencies
- Package runtime dependencies in `packages/codegen/package.json`: `@dzupagent/core`, `@dzupagent/adapter-types`.
- Package peer dependencies: `@langchain/core`, `@langchain/langgraph`, `zod`, and optional `tree-sitter-wasms`, `web-tree-sitter`.
- Guardrails-specific imports are internal to the package. `guardrail-types.ts` imports `RepoMap` type from `../repomap/repo-map-builder.js`.
- `src/guardrails/*` has no direct third-party runtime imports.
- Pipeline integration around guardrails depends on `@dzupagent/core/utils` (`calculateBackoff`), `@dzupagent/core/pipeline` types, and `@langchain/core` type imports used by pipeline builder/type modules.

## Integration Points
- Package root exports in `src/index.ts` expose guardrail engine/types/rules plus gate APIs.
- Runtime facade in `src/runtime.ts` re-exports `./guardrails/index.js` and `./pipeline/guardrail-gate.js`.
- `GenPipelineBuilder.withGuardrails(config)` stores `GuardrailGateConfig` and appends a `guardrail` phase descriptor named `guardrail-gate`.
- `PipelineExecutor` does not consume builder descriptors directly. It enforces guardrails through executor config and `buildGuardrailContext`.
- Guardrail checks run after phase output merges into executor state.
- `GuardrailContext.repoMap` is available for integration, but current built-in rules do not consume it.

## Testing and Observability
- `src/__tests__/guardrails.test.ts` covers engine config behavior, built-in rules, learner behavior, and reporter output.
- `src/__tests__/guardrail-rules.test.ts` covers edge cases for security/import/naming/type/layering/contract rules.
- `src/__tests__/pipeline-components.test.ts` covers `runGuardrailGate`, `summarizeGateResult`, and builder guardrail configuration.
- `src/__tests__/pipeline-executor.test.ts` covers executor-level guardrail blocking and `__phase_<id>_guardrail` state markers.
- Primary observability artifact is `GuardrailReport` with severity counts, per-rule results, and flattened violations.
- Optional rendered output is produced through `GuardrailReporter`.
- Pipeline state stores per-phase guardrail summaries.
- No dedicated metrics emitter, tracing hook, or structured logging sink exists in `src/guardrails/*`.

## Risks and TODOs
- Built-in checks are regex and line-based, not AST-backed, so complex syntax can produce false positives or false negatives.
- `ProjectStructure.allowedDependencies` is modeled but not used by `layering-rule`, which currently relies on static/default layer matrices.
- `GuardrailContext.repoMap` is modeled but unused by built-in rules.
- `GuardrailViolation.fix` and `autoFixable` are modeled, but built-in rules currently emit `autoFixable: false` without executable fixes.
- `GuardrailReporter` category grouping uses a fixed `ruleId` mapping and falls back to `patterns` for unknown/custom rule IDs.
- Convention cache in `ConventionLearner` is instance-local and not corpus-fingerprinted, so long-lived processes must call `clearCache()` when inputs change.
- `GenPipelineBuilder.withGuardrails()` adds a guardrail phase descriptor, but runtime enforcement depends on `PipelineExecutor` config; integrators should not assume descriptor presence alone enables execution-time gating.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

