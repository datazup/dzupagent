# CI Module Architecture (`packages/codegen/src/ci`)

## 1. Purpose

The CI module is a small, composable "CI reaction engine" for `@dzupagent/codegen`.
It is designed to:

- normalize CI failure payloads into a common shape,
- classify failures into actionable categories,
- map each category to a fix strategy,
- generate structured retry prompts for automated fix loops.

This module does not call CI providers, rerun pipelines, or apply code changes itself. It only transforms CI data and plans fix attempts.

---

## 2. Module Composition

Files in this folder:

- `ci-monitor.ts`: parsing and failure categorization.
- `failure-router.ts`: category-to-strategy routing.
- `fix-loop.ts`: prompt generation and bounded attempt planning.
- `index.ts`: local barrel export for the CI submodule.

Top-level package exports are re-exported in `packages/codegen/src/index.ts` so consumers can import these APIs from `@dzupagent/codegen`.

---

## 3. Core Data Model

### 3.1 `CIStatus`

Canonical status object after parsing provider payloads:

- `provider`: `'github-actions' | 'gitlab-ci' | 'generic'`
- `runId`: CI run identifier (stringified)
- `branch`: source branch/ref
- `status`: `'pending' | 'running' | 'success' | 'failure' | 'cancelled'`
- `failures`: `CIFailure[]`
- `url?`: optional run URL
- `timestamp`: parsed date or current time fallback

### 3.2 `CIFailure`

Normalized failed-job signal:

- `jobName`: failed job name
- `step?`: optional failed step
- `logExcerpt`: relevant log chunk
- `exitCode?`: optional numeric exit code
- `errorCategory?`: `'build' | 'test' | 'lint' | 'type-check' | 'deploy' | 'unknown'`

### 3.3 `FixStrategy`

How the system should attempt repair for a category:

- `category`: the failure category
- `promptHint`: instruction text for the fixing agent
- `suggestedTools`: tool hints (for orchestration layer)
- `maxAttempts`: per-failure attempt budget

---

## 4. Feature Analysis

### 4.1 Failure Categorization (`categorizeFailure`)

Regex-based classification from log text:

- `type-check`: `tsc`, TypeScript codes (`TS1234`), type errors
- `test`: `FAIL`, `vitest`, `jest`, test-fail patterns
- `lint`: `eslint`, lint errors
- `build`: compile/build fail patterns
- `deploy`: deployment fail patterns
- fallback: `unknown`

Design characteristics:

- simple and fast (no provider dependency),
- heuristic-driven, not semantic parsing,
- deterministic fallback to `unknown`.

### 4.2 Provider Parsing (`parseGitHubActionsStatus`, `parseCIWebhook`)

### GitHub Actions parser

- accepts a GitHub run object shape (`/actions/runs/{run_id}` style),
- derives final status from `conclusion` first, then falls back to `status`,
- scans `jobs[]` and extracts failures where `conclusion === 'failure'`,
- categorizes each failed job via `categorizeFailure`.

### Generic webhook parser

- accepts untyped payload + explicit `provider`,
- reads `failures[]` with tolerant field aliases (`jobName`/`job`, `log`/`logExcerpt`),
- normalizes status using a shared status mapper,
- forces `status = 'failure'` when failures exist but input status says success.

### 4.3 Strategy Routing (`routeFailure`)

- starts from `DEFAULT_FIX_STRATEGIES`,
- merges optional custom strategies (custom overrides default for matching keys),
- uses `failure.errorCategory` (or `'unknown'`) to pick strategy,
- returns unknown fallback if category key is missing.

Default strategy catalog:

- `type-check` -> focused type fixes, up to 3 attempts.
- `test` -> assertion/mocks/expectation diagnosis, up to 3 attempts.
- `lint` -> rule-by-rule cleanup, up to 2 attempts.
- `build` -> dependency/import/config repair, up to 3 attempts.
- `deploy` -> deployment config/script checks, up to 2 attempts.
- `unknown` -> general root-cause analysis, up to 2 attempts.

### 4.4 Fix Attempt Planning (`buildFixPrompt`, `generateFixAttempts`)

### Prompt builder

`buildFixPrompt` composes a markdown prompt containing:

- attempt counter (`attempt/maxAttempts`),
- failed job metadata (job/step/exit code/category),
- strategy instructions,
- suggested tools,
- raw CI log excerpt fenced as code,
- escalation note for attempts > 1.

### Attempt generator

`generateFixAttempts`:

- resolves defaults (`maxTotalAttempts` default = `5`),
- iterates failures in input order,
- routes each failure to a strategy,
- allocates per-failure attempts as `min(strategy.maxAttempts, remainingBudget)`,
- creates one prompt per attempt,
- stops when global budget is consumed.

---

## 5. End-to-End Flow

```text
CI payload (GitHub or generic webhook)
        |
        v
parseGitHubActionsStatus(...) OR parseCIWebhook(...)
        |
        v
CIStatus { failures: CIFailure[] }
        |
        v
for each failure:
  routeFailure(failure, optionalCustomStrategies)
        |
        v
buildFixPrompt(failure, strategy, attemptN)
        |
        v
generateFixAttempts(...) => FixAttempt[]
        |
        v
orchestrator executes attempts + reruns CI externally
```

---

## 6. Usage Examples

### 6.1 Example: GitHub Actions Failure -> Planned Attempts

```ts
import {
  parseGitHubActionsStatus,
  generateFixAttempts,
} from '@dzupagent/codegen'

const ghRun = {
  id: 987654321,
  head_branch: 'feature/refactor-auth',
  status: 'completed',
  conclusion: 'failure',
  html_url: 'https://github.com/acme/repo/actions/runs/987654321',
  updated_at: '2026-04-04T10:15:00Z',
  jobs: [
    {
      name: 'test',
      conclusion: 'failure',
      step: 'Run Vitest',
      exit_code: 1,
      log: 'FAIL src/auth/login.test.ts ... expected 401 to equal 200',
    },
  ],
}

const status = parseGitHubActionsStatus(ghRun)
const attempts = generateFixAttempts(status.failures, { maxTotalAttempts: 4 })

// attempts[0].prompt now contains a structured "CI Fix - Attempt 1/3" prompt
```

### 6.2 Example: Generic Webhook + Custom Strategy Override

```ts
import {
  parseCIWebhook,
  generateFixAttempts,
  type FixStrategy,
} from '@dzupagent/codegen'

const payload = {
  id: 'run-42',
  branch: 'main',
  status: 'failure',
  failures: [
    {
      jobName: 'lint',
      logExcerpt: 'eslint: no-unused-vars in src/server.ts',
    },
  ],
}

const customLint: FixStrategy = {
  category: 'lint',
  promptHint: 'Fix lint quickly and run `yarn lint --fix` where safe.',
  suggestedTools: ['read_file', 'edit_file'],
  maxAttempts: 1,
}

const status = parseCIWebhook(payload, 'generic')
const attempts = generateFixAttempts(status.failures, {
  strategies: { lint: customLint },
  maxTotalAttempts: 5,
})
```

### 6.3 Example: Integration With PR State Machine (Codegen Internal Pattern)

```ts
import { transitionState, getNextAction } from '@dzupagent/codegen'

const nextState = transitionState('ci_running', { type: 'ci_failed' })
// nextState => 'changes_requested'

const action = getNextAction({
  owner: 'acme',
  repo: 'repo',
  branch: 'feature',
  baseBranch: 'main',
  title: 'Fix CI',
  body: 'Automated CI remediation',
  state: nextState,
  reviewComments: [],
})
// action => { type: 'address_feedback', comments: [] }
```

This shows how CI outcomes can feed PR lifecycle automation even though the CI module itself remains pure and side-effect free.

---

## 7. Practical Use Cases

- Autonomous fix bot that consumes webhook payloads and generates remediation prompts.
- "Triage first" CI assistant that classifies failures before handing them to specialized agents.
- Internal DevEx tools that maintain retry budgets (`maxTotalAttempts`) to avoid infinite loops.
- Multi-provider normalization layer where GitHub and generic/GitLab-like events map to one `CIStatus` schema.
- PR automation pipelines that combine CI failure planning with `pr/pr-manager.ts` transitions.

---

## 8. Cross-Package References and Current Usage

As of this analysis (2026-04-04):

- CI APIs are exported from `@dzupagent/codegen` via:
  - `packages/codegen/src/ci/index.ts`
  - `packages/codegen/src/index.ts`
- No runtime imports/call sites were found in other workspace packages (`packages/*`) for:
  - `categorizeFailure`
  - `parseGitHubActionsStatus`
  - `parseCIWebhook`
  - `routeFailure`
  - `generateFixAttempts`
  - `buildFixPrompt`
- Existing references outside `src/ci` are currently documentation-level (for example, `packages/codegen/ARCHITECTURE.md`).

Interpretation:

- The module is presently a published extension surface and internal capability, not yet consumed by other local packages.

---

## 9. Test Coverage Status

Validation performed:

- Symbol/reference scan across monorepo source (`packages/**`).
- Targeted Vitest filter run for CI namespace: `yarn workspace @dzupagent/codegen test -- ci` (no matching tests found).
- Full package coverage run: `yarn workspace @dzupagent/codegen test:coverage`.

Coverage results for this module from the coverage run:

- `src/ci/ci-monitor.ts`: 0% statements, 0% branches, 0% functions, 0% lines
- `src/ci/failure-router.ts`: 0% statements, 0% branches, 0% functions, 0% lines
- `src/ci/fix-loop.ts`: 0% statements, 0% branches, 0% functions, 0% lines
- Folder aggregate `src/ci`: 0% across all metrics

What this means:

- CI module behavior is currently unverified by unit tests despite package-level coverage being above thresholds overall.
- Regression risk is concentrated around parsing heuristics, strategy override behavior, and attempt-budget distribution.

Recommended test additions (high value, minimal suite):

1. `ci-monitor.test.ts`
- category detection for each regex bucket + unknown fallback.
- GitHub parser status precedence (`conclusion` over `status`).
- webhook parser alias fields + success-with-failures override.

2. `failure-router.test.ts`
- default routing by category.
- custom strategy override precedence.
- unknown fallback safety.

3. `fix-loop.test.ts`
- prompt rendering content checks (attempt metadata + retry note).
- budget distribution across multiple failures.
- custom strategy integration path.

---

## 10. Constraints and Observed Gaps

- `CIMonitorConfig` is defined but not currently used by runtime logic in this folder.
- Parsing is intentionally schema-light (`Record<string, unknown>`), so malformed payloads degrade to empty strings/defaults rather than hard validation errors.
- `FixLoopResult` type exists but no function in this module currently returns it.
- `failure-router.ts` docs mention possible "re-categorization from log if missing", but routing currently trusts `failure.errorCategory` and falls back to `unknown` without re-running categorization.

These are not necessarily defects, but they should be explicit for maintainers extending this module.
