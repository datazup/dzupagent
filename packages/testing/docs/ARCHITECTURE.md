# @dzupagent/testing Architecture

## Scope
`@dzupagent/testing` provides test-oriented utilities for DzupAgent packages. The package is focused on deterministic LLM testing, evaluation helpers, and security regression suites, plus boundary-enforcement tests that validate architecture constraints in the monorepo.

Included scope in `packages/testing`:
- LLM record/replay middleware (`LlmRecorder`) for `@dzupagent/core/llm` registries.
- Vitest helper (`withRecordedRegistry`) for building a recorder-wired `ModelRegistry`.
- Mock `SkillStepResolver` for workflow/skill-chain tests.
- Eval framework (`runEvalSuite`) with built-in scorers (`ExactMatchScorer`, `RegexScorer`, `LlmJudgeScorer`) and a deterministic demo suite.
- Security suite runner (`runSecuritySuite`) with built-in suites: injection, escalation, poisoning, escape.
- Architecture boundary enforcement tests in `src/__tests__/boundary*.test.ts`.

Out of scope:
- Runtime policy enforcement in production systems.
- Agent orchestration/server behavior.
- Any application-owned product features.

## Responsibilities
1. Provide deterministic LLM tests by recording and replaying model interactions as JSON fixtures.
2. Offer low-friction Vitest setup for replay-first registry tests.
3. Provide a mock resolver for skill execution tests without live agent dependencies.
4. Run eval suites that score target outputs against one or more scorers and aggregate pass/fail results.
5. Run security suites against a caller-provided checker and report per-case plus aggregate security results.
6. Enforce declared dependency and import-graph boundaries through static test suites.

## Structure
Current package layout:
- `src/index.ts`: public barrel for recorder, setup helper, eval exports, security exports.
- `src/llm-recorder.ts`: `LlmRecorder`, fixture hashing/loading/writing, strict replay behavior, seeding helpers.
- `src/vitest-llm-setup.ts`: `withRecordedRegistry`, returns `{ registry, recorder }`.
- `src/mock-skill-step-resolver.ts`: `MockSkillStepResolver` and `MockCall` tracking.
- `src/eval/`
- `types.ts`: eval contracts.
- `runner.ts`: `runEvalSuite` implementation.
- `demo-suite.ts`: deterministic suite + stub Anthropic client factory.
- `scorers/exact-match.ts`: exact equality scorer.
- `scorers/regex.ts`: regex match scorer.
- `scorers/llm-judge.ts`: LLM-based judge scorer with lazy Anthropic SDK import.
- `src/security/`
- `security-test-types.ts`: security contracts.
- `security-runner.ts`: `runSecuritySuite` implementation.
- `injection-suite.ts`, `escalation-suite.ts`, `poisoning-suite.ts`, `escape-suite.ts`: built-in case catalogs.
- `index.ts`: security submodule barrel.
- `src/__tests__/`: unit tests for recorder, resolver, eval, security, export surface, and architecture boundaries.
- `package.json`: package entrypoints and scripts.
- `tsup.config.ts`: ESM build config with entries `src/index.ts` and `src/vitest-llm-setup.ts`.
- `vitest.config.ts`: node test config, single-thread `vmThreads` pool for architecture test stability, coverage thresholds.

## Runtime and Control Flow
### LLM recorder flow
1. `LlmRecorder` is attached as `RegistryMiddleware` to a `ModelRegistry`.
2. `beforeInvoke(context)`:
- In `record` mode: returns `{ cached: false }` and lets the real call proceed.
- In `replay` mode: computes a stable hash from `messages`, `model`, `temperature`, `maxTokens`, `provider`; loads fixture `<fixtureDir>/<hash>.json`.
- If fixture is missing and `strict` is true (default), throws an error instructing to run with `LLM_RECORD=1`.
3. `afterInvoke(context, response, usage)` writes fixture JSON in `record` mode only.

### Vitest registry helper flow
1. `withRecordedRegistry(options)` creates `LlmRecorder`.
2. Creates a fresh `ModelRegistry` from `@dzupagent/core/llm`.
3. Adds a stub Anthropic provider config.
4. Attaches the recorder middleware.
5. Returns `{ registry, recorder }` for test usage.

### Eval runner flow
1. `runEvalSuite(suite)` resolves `passThreshold` (`0.7` default).
2. For each case, it runs `suite.target` sequentially.
- Target errors are converted into output strings (`[target error: ...]`) instead of throwing.
3. For the case output, all scorers run concurrently.
4. Case aggregate score is the mean of scorer scores; pass when `aggregateScore >= passThreshold`.
5. Suite result includes per-case details, aggregate score, pass rate, `allPassed`, and timestamp.

### LLM judge scorer flow
1. `LlmJudgeScorer.score(...)` uses an injected `AnthropicClient` if supplied.
2. Otherwise it lazy-imports `@anthropic-ai/sdk` and constructs the default client.
3. Sends a strict JSON response prompt and parses the returned text.
4. Parsed score is clamped to `[0,1]`; parse/call failures return `{ score: 0, pass: false, reasoning: ... }`.

### Security runner flow
1. `runSecuritySuite(suite, checker)` iterates each `SecurityTestCase` sequentially.
2. Calls `checker(input)` and evaluates against `expectedBehavior`:
- `block`: requires `blocked`.
- `detect`: requires `blocked || detected`.
- `safe`: requires `!blocked && !detected`.
3. Builds human-readable `details` for each case.
4. Returns aggregate counts and `passRate`; suite name is derived from first case category or `empty-security-suite`.

## Key APIs and Types
Top-level exports from `src/index.ts`:
- `LlmRecorder`, `LlmRecorderOptions`, `LlmFixture`, `RecorderMode`.
- `withRecordedRegistry`, `RecordedRegistry`.
- `MockSkillStepResolver`, `MockCall`.
- Eval types: `EvalScore`, `EvalScorer`, `EvalCase`, `EvalSuite`, `EvalCaseResult`, `EvalRunResult`.
- Eval APIs: `runEvalSuite`, `ExactMatchScorer`, `RegexScorer`, `LlmJudgeScorer`, `createDemoEvalSuite`, `buildStubAnthropicClient`.
- Eval LLM judge types: `AnthropicClient`, `LlmJudgeOptions`.
- Security types: `SecurityCategory`, `SecuritySeverity`, `SecurityExpectedBehavior`, `SecurityTestCase`, `SecurityTestResult`, `SecuritySuiteResult`, `SecurityChecker`.
- Security APIs: `runSecuritySuite`, `INJECTION_SUITE`, `ESCALATION_SUITE`, `POISONING_SUITE`, `ESCAPE_SUITE`.

Published subpath export:
- `@dzupagent/testing/vitest-llm-setup` -> `dist/vitest-llm-setup.js` (+ typings).

## Dependencies
Runtime dependencies (`package.json`):
- `@dzupagent/core` (LLM registry/middleware types and implementation).
- `@dzupagent/agent` (workflow and resolver types used by mock resolver).

Dev/build/test dependencies:
- `typescript`, `tsup`, `vitest`.

Soft dependency behavior:
- `LlmJudgeScorer` dynamically imports `@anthropic-ai/sdk` only when no client override is provided.
- This package does not declare `@anthropic-ai/sdk` directly in `package.json`.

Packaging/build characteristics:
- ESM package (`"type": "module"`).
- `tsup` builds `src/index.ts` and `src/vitest-llm-setup.ts` to `dist/` with declaration files and sourcemaps.

## Integration Points
- `@dzupagent/core/llm`:
- `LlmRecorder` implements `RegistryMiddleware`.
- `withRecordedRegistry` creates and configures `ModelRegistry`.
- `@dzupagent/agent`:
- `MockSkillStepResolver` implements `SkillStepResolver` and returns `WorkflowStep`.
- Anthropic SDK ecosystem:
- `LlmJudgeScorer` can run with a real Anthropic client or with a stubbed client for deterministic tests.
- CI/test workflows:
- Security/eval outputs are structured for assertions and log consumption.
- Boundary tests validate monorepo dependency policy (`config/architecture-boundaries.json`, `config/package-tiers.json`) by static analysis.

## Testing and Observability
Testing coverage includes:
- `llm-recorder.test.ts`: replay/record modes, strict misses, fixture helpers.
- `mock-skill-step-resolver.test.ts`: registration modes, delays/errors, call tracking.
- `eval/*` tests: scorer correctness and runner aggregation/error behavior.
- `security*.test.ts`: suite validity and runner pass/fail semantics.
- `exports.test.ts`: verifies public export surface and vitest setup subpath export.
- `boundary-enforcement.test.ts`: dependency declarations and cycles checks.
- `boundary/architecture.test.ts`: static import-graph boundary checks across packages and app workspace rules.

Observability surfaces from APIs:
- `SecurityTestResult.details` for explicit case-level pass/fail reasoning.
- `EvalScore.reasoning` and per-scorer breakdown in `EvalCaseResult`.
- Recorder fixture JSON stores request/response/usage snapshots for deterministic replay and debugging.

## Risks and TODOs
- `runSecuritySuite` is sequential and fail-fast on checker exceptions; one thrown checker error stops remaining cases.
- `runEvalSuite` handles target errors but does not isolate scorer exceptions; scorer failures can fail the suite run.
- `POISONING_SUITE` contains a `Math.random()`-generated payload in one test case, which may reduce deterministic snapshot behavior.
- `LlmJudgeScorer` default path depends on runtime availability of `@anthropic-ai/sdk`; environments without it must inject a client.
- Vitest architecture checks are intentionally configured single-threaded due to heavy workspace scanning; this keeps stability but can increase runtime.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js