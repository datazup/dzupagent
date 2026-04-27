# CI Architecture (`packages/codegen/src/ci`)

## Scope

This document covers the CI helper module in `packages/codegen/src/ci`:

- `ci-monitor.ts`
- `failure-router.ts`
- `fix-loop.ts`
- `index.ts`

It also covers how these APIs are exported from `packages/codegen/src/index.ts` and validated by CI-focused tests under `packages/codegen/src/__tests__`.

## Responsibilities

The module is a pure transformation/planning layer for CI remediation:

- Normalize CI payloads into a shared `CIStatus` / `CIFailure` shape.
- Classify failure logs into coarse categories (`type-check`, `test`, `lint`, `build`, `deploy`, `unknown`).
- Route each failure category to a fix strategy (`FixStrategy`).
- Build structured markdown prompts and bounded attempt plans (`FixAttempt[]`) for an external orchestrator.

Out of scope in this module:

- No CI provider HTTP polling.
- No pipeline reruns.
- No code edits, git actions, or tool execution.
- No persistence, telemetry sink, or queueing.

## Structure

| File | Main exports | Purpose |
| --- | --- | --- |
| `src/ci/ci-monitor.ts` | `categorizeFailure`, `parseGitHubActionsStatus`, `parseCIWebhook` | Parses provider payloads and classifies failure logs. |
| `src/ci/failure-router.ts` | `DEFAULT_FIX_STRATEGIES`, `routeFailure` | Maps categories to fix strategy hints and attempt budgets. |
| `src/ci/fix-loop.ts` | `buildFixPrompt`, `generateFixAttempts` | Produces attempt prompts and total-attempt-bounded fix plans. |
| `src/ci/index.ts` | Barrel re-exports | Local submodule export surface. |

Top-level package exports re-export the same CI APIs from `src/index.ts` under the `// --- CI ---` section.

## Runtime and Control Flow

```text
CI payload (GitHub Actions run response or generic webhook-like payload)
  -> parseGitHubActionsStatus(...) or parseCIWebhook(...)
  -> CIStatus { failures: CIFailure[] }
  -> for each failure:
       routeFailure(failure, optionalCustomStrategies)
       buildFixPrompt(failure, strategy, attemptNumber)
  -> generateFixAttempts(...) returns FixAttempt[]
  -> external orchestrator executes prompts/tools and reruns CI
```

Runtime behavior details:

- `categorizeFailure` uses ordered regex matching (`first match wins`).
- `parseGitHubActionsStatus` prioritizes `conclusion` over `status` for terminal mapping.
- `parseCIWebhook` accepts alias keys (`runId`/`id`, `branch`/`ref`, `jobName`/`job`, `log`/`logExcerpt`).
- `generateFixAttempts` enforces global `maxTotalAttempts` (default `5`) while honoring per-strategy `maxAttempts`.

## Key APIs and Types

Core types:

- `CIProvider = 'github-actions' | 'gitlab-ci' | 'generic'`
- `CIStatus`:
  - `provider`, `runId`, `branch`, `status`, `failures`, optional `url`, `timestamp`
- `CIFailure`:
  - `jobName`, optional `step`, `logExcerpt`, optional `exitCode`, optional `errorCategory`
- `FixStrategy`:
  - `category`, `promptHint`, `suggestedTools`, `maxAttempts`
- `FixLoopConfig`:
  - `maxTotalAttempts`, optional `strategies`
- `FixAttempt`:
  - `failure`, `strategy`, `attempt`, `prompt`, optional `success`
- `FixLoopResult` (type only; no builder currently returns this shape)

Primary functions:

- `categorizeFailure(logExcerpt): CIFailure['errorCategory']`
- `parseGitHubActionsStatus(apiResponse): CIStatus`
- `parseCIWebhook(payload, provider): CIStatus`
- `routeFailure(failure, customStrategies?): FixStrategy`
- `buildFixPrompt(failure, strategy, attempt): string`
- `generateFixAttempts(failures, config?): FixAttempt[]`

## Dependencies

Module-internal dependency graph:

- `fix-loop.ts` depends on `routeFailure` from `failure-router.ts`.
- `failure-router.ts` depends on `CIFailure` type from `ci-monitor.ts`.
- `ci-monitor.ts` has no imports from other package modules.

External runtime dependencies:

- This CI submodule itself does not import `@dzupagent/core`, `@dzupagent/adapter-types`, LangChain, or Zod at runtime.
- It relies only on built-in JS/TS primitives (`Date`, string/regex/object operations).
- It is compiled and shipped as part of `@dzupagent/codegen`.

## Integration Points

- Public package surface:
  - Re-exported from `packages/codegen/src/index.ts`, so consumers import CI APIs from `@dzupagent/codegen`.
- Internal `ci/index.ts` barrel:
  - Provides local grouped exports for direct folder-level imports.
- Upstream orchestration:
  - The module emits plan artifacts (`CIStatus`, `FixAttempt[]`, markdown prompts) expected to be consumed by higher-level orchestration/execution code outside `src/ci`.
- Cross-module conceptual alignment:
  - PR state transition logic exists in `src/pr`, but `src/ci` has no direct import coupling with PR modules.

## Testing and Observability

CI-specific tests:

- `src/__tests__/ci-monitor.test.ts`
- `src/__tests__/failure-router.test.ts`
- `src/__tests__/fix-loop.test.ts`
- Additional branch coverage assertions in:
  - `src/__tests__/branch-coverage-misc.test.ts`
  - `src/__tests__/branch-coverage-conventions-validation.test.ts`

Validated behavior from tests:

- Provider parsing fallback behavior for missing/alternate fields.
- Status coercion when failures are present.
- Strategy override precedence (`customStrategies` over defaults).
- Prompt content and retry hint behavior.
- Attempt budgeting semantics.
- Known pattern-order behavior where some `deploy failed` strings classify as `test`.

Observability in this module:

- No logger, metrics, tracing, or event emitter.
- Observability is limited to returned structured data (`status`, `failures`, prompts, attempt lists).

## Risks and TODOs

- Regex ordering risk: `test` patterns can shadow `deploy` classification when logs contain generic `fail` text (documented by tests).
- `CIMonitorConfig` exists but is not consumed by any runtime function in this folder.
- `FixLoopResult` is defined but no function currently returns that aggregate shape.
- `FixAttempt.success` is optional and must be set by external orchestration after CI reruns.
- `routeFailure` relies on precomputed `failure.errorCategory`; it does not re-categorize from logs despite comments implying possible re-categorization.
- Provider coverage is parser-based only; there is no provider-specific API client, pagination, or job-log fetching in this module.

## Changelog

- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js