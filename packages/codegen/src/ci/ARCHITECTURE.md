# CI Architecture (`packages/codegen/src/ci`)

## Scope
This document describes the CI helper subsystem in `packages/codegen/src/ci` within `@dzupagent/codegen`.

Files covered:
- `ci-monitor.ts`
- `failure-router.ts`
- `fix-loop.ts`
- `index.ts`

Package-level context covered:
- Re-exports from `packages/codegen/src/index.ts` under the `// --- CI ---` section.
- CI-focused tests in `packages/codegen/src/__tests__/`.

Out of scope:
- CI provider API clients, webhooks server handlers, or polling loops.
- Applying code fixes, rerunning pipelines, or persisting run state.

## Responsibilities
The CI module provides deterministic parsing, classification, and planning primitives that higher-level orchestrators can use.

Primary responsibilities:
- Convert raw provider payloads into a normalized `CIStatus` shape.
- Extract failed jobs into `CIFailure` entries.
- Categorize failures from log excerpts via ordered pattern matching.
- Map categorized failures to `FixStrategy` definitions.
- Generate bounded fix-attempt prompts (`FixAttempt[]`) with retry-aware instructions.

Non-responsibilities:
- No network I/O.
- No sandbox/tool execution.
- No git operations or filesystem mutation.
- No telemetry emission or queue integration.

## Structure
| File | Exports | Role |
| --- | --- | --- |
| `src/ci/ci-monitor.ts` | `categorizeFailure`, `parseGitHubActionsStatus`, `parseCIWebhook` + CI types | Status normalization and log-based categorization. |
| `src/ci/failure-router.ts` | `DEFAULT_FIX_STRATEGIES`, `routeFailure`, `FixStrategy` | Category-to-strategy routing with optional custom overrides. |
| `src/ci/fix-loop.ts` | `buildFixPrompt`, `generateFixAttempts` + fix-loop types | Prompt construction and attempt budgeting. |
| `src/ci/index.ts` | Barrel re-exports | Local entrypoint for the CI folder. |

Internal dependency direction:
- `fix-loop.ts` imports `routeFailure` from `failure-router.ts`.
- `failure-router.ts` imports `CIFailure` type from `ci-monitor.ts`.
- `ci-monitor.ts` is standalone.

## Runtime and Control Flow
Nominal flow:

1. CI payload arrives from an external caller.
2. Caller uses one of:
   - `parseGitHubActionsStatus(apiResponse)`
   - `parseCIWebhook(payload, provider)`
3. Parser returns `CIStatus` with normalized status and `failures` array.
4. For each `CIFailure`, `generateFixAttempts`:
   - selects strategy via `routeFailure`
   - creates one or more prompts via `buildFixPrompt`
   - enforces global max attempts (`maxTotalAttempts`, default `5`)
5. Caller executes prompts/tooling externally and tracks success outside this module.

Important behavior details from implementation:
- Categorization is first-match-wins (`CATEGORY_PATTERNS` order matters).
- GitHub parsing prefers `conclusion` for terminal state, then falls back to mapped `status`.
- Generic webhook parsing supports alias keys (`runId`/`id`, `branch`/`ref`, `jobName`/`job`, `log`/`logExcerpt`).
- `parseCIWebhook` coerces final status to `failure` when failures are present and incoming status says `success`.

## Key APIs and Types
Core CI status types:
- `CIProvider = 'github-actions' | 'gitlab-ci' | 'generic'`
- `CIStatus`:
  - `provider`, `runId`, `branch`, `status`, `failures`, optional `url`, `timestamp`
- `CIFailure`:
  - `jobName`, optional `step`, `logExcerpt`, optional `exitCode`, optional `errorCategory`
- `CIMonitorConfig`:
  - `provider`, optional `pollIntervalMs`, optional `maxLogLines` (declared type, currently not consumed by runtime functions)

Routing and fix-planning types:
- `FixStrategy`:
  - `category`, `promptHint`, `suggestedTools`, `maxAttempts`
- `FixLoopConfig`:
  - `maxTotalAttempts`, optional `strategies`
- `FixAttempt`:
  - `failure`, `strategy`, `attempt`, `prompt`, optional `success`
- `FixLoopResult`:
  - `attempts`, `allFixed`, `totalAttempts` (declared type; no constructor function currently returns this shape)

Main functions:
- `categorizeFailure(logExcerpt): CIFailure['errorCategory']`
- `parseGitHubActionsStatus(apiResponse): CIStatus`
- `parseCIWebhook(payload, provider): CIStatus`
- `routeFailure(failure, customStrategies?): FixStrategy`
- `buildFixPrompt(failure, strategy, attempt): string`
- `generateFixAttempts(failures, config?): FixAttempt[]`

Default strategy categories in `DEFAULT_FIX_STRATEGIES`:
- `type-check`
- `test`
- `lint`
- `build`
- `deploy`
- `unknown`

## Dependencies
Runtime dependencies for this subsystem:
- No imports from `@dzupagent/core`, `@dzupagent/adapter-types`, LangChain, or Zod.
- No external npm dependencies used directly in `src/ci/*`.
- Uses only JavaScript/TypeScript built-ins (regex/string/object/date operations).

Packaging context:
- CI exports are available through `@dzupagent/codegen` root exports (`src/index.ts`).
- `package.json` does not expose a dedicated `./ci` subpath export; consumers import CI APIs from the package root.

## Integration Points
Public integration points:
- Root package exports in `packages/codegen/src/index.ts`:
  - CI monitor exports and types
  - failure routing exports and types
  - fix loop exports and types

Internal integration points:
- `src/ci/index.ts` provides a local barrel for direct folder-level imports inside the repo.

Downstream usage model:
- External orchestrators provide payload input and consume:
  - normalized status objects (`CIStatus`)
  - routed strategies (`FixStrategy`)
  - generated markdown prompts (`FixAttempt.prompt`)
- Success/failure feedback loops (`FixAttempt.success`) are expected to be populated by those orchestrators after reruns.

Observed repo usage:
- CI APIs are heavily exercised by unit/branch-coverage tests.
- Outside tests and export surfaces, there are no direct runtime consumers in `packages/codegen/src` as of this refresh.

## Testing and Observability
Test coverage in `packages/codegen/src/__tests__/` includes:
- `ci-monitor.test.ts`
- `failure-router.test.ts`
- `fix-loop.test.ts`
- Additional branch-focused coverage in:
  - `branch-coverage-misc.test.ts`
  - `branch-coverage-conventions-validation.test.ts`

Verified behaviors covered by tests:
- Pattern-based category mapping and first-match ordering effects.
- GitHub Actions parsing for success/failure/cancelled/running and missing fields.
- Generic webhook parsing with alternate key names and status coercion.
- Strategy defaulting and custom strategy override behavior.
- Prompt formatting and retry-note injection for attempts `> 1`.
- `maxTotalAttempts` enforcement and per-strategy attempt fan-out.

Observability characteristics:
- No built-in logger, metrics, or tracing in `src/ci/*`.
- Only structured return values are available for external instrumentation.

## Risks and TODOs
Current risks:
- `CATEGORY_PATTERNS` ordering causes some deploy messages containing "fail" to classify as `test` before `deploy`.
- `routeFailure` relies on `failure.errorCategory`; it does not re-categorize from `logExcerpt` when category is missing.
- `CIMonitorConfig` is exported but unused by parser functions.
- `FixLoopResult` is exported but no function currently assembles/returns it.
- `DEFAULT_FIX_STRATEGIES` is typed as `Record<string, FixStrategy>`, which allows non-standard keys and weakens compile-time exhaustiveness.

Low-level constraints to keep in mind:
- Parser inputs are intentionally loose (`Record<string, unknown>`), so malformed payloads degrade to empty/default fields rather than hard-failing.
- This module does not fetch full job logs, so categorization quality depends on provided `log`/`logExcerpt` snippets.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js