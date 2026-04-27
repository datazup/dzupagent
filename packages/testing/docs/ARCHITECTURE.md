# @dzupagent/testing Architecture

## Scope
`@dzupagent/testing` is a test-support package in `dzupagent/packages/testing` that provides deterministic testing utilities and evaluation/security harnesses for agent and model behavior.

The current package scope is:
- LLM record/replay middleware for `@dzupagent/core` model registry calls.
- A Vitest-oriented registry factory for fixture-driven tests.
- A mock `SkillStepResolver` implementation for skill-chain tests.
- A lightweight eval framework (suite runner + scorers + demo suite).
- A security-suite runner with built-in adversarial case catalogs.
- Architecture/boundary enforcement tests that validate monorepo package and app dependency rules.

Out of scope in this package:
- Runtime serving/orchestration features.
- Policy enforcement at runtime (this package evaluates behavior; it does not enforce production guardrails itself).

## Responsibilities
The package has five primary responsibilities.

1. Deterministic LLM test execution
- `LlmRecorder` implements `RegistryMiddleware` and can run in `record` or `replay` mode.
- In replay mode it short-circuits model calls using JSON fixtures.
- In record mode it persists request/response/usage fixtures for later replay.

2. Test harness bootstrapping
- `withRecordedRegistry` creates a `ModelRegistry` with a stub provider and attached `LlmRecorder` to make replay-based tests easy to set up.

3. Skill-chain mocking
- `MockSkillStepResolver` provides in-memory registration and deterministic `WorkflowStep` resolution for `@dzupagent/agent` tests.

4. Eval suite execution
- `runEvalSuite` executes target functions against cases and scorers, computes case aggregates, pass rate, and suite-level results.
- Included scorers are exact match, regex, and optional model-judge scoring.

5. Security regression testing
- `runSecuritySuite` evaluates checker behavior against prebuilt suites: injection, escalation, poisoning, escape.
- Returns per-case and aggregate pass/fail metrics.

## Structure
Current source layout:

- `src/index.ts`
  - Public package barrel.
  - Exports recorder utilities, eval APIs, and security APIs.

- `src/llm-recorder.ts`
  - `LlmRecorder` middleware.
  - Fixture hashing, read/write, strict replay misses, seed helpers.

- `src/vitest-llm-setup.ts`
  - `withRecordedRegistry(options)` factory returning `{ registry, recorder }`.

- `src/mock-skill-step-resolver.ts`
  - `MockSkillStepResolver` + `MockCall`.

- `src/eval/`
  - `types.ts`: eval contracts (`EvalSuite`, `EvalScorer`, result types).
  - `runner.ts`: `runEvalSuite` implementation.
  - `demo-suite.ts`: deterministic demo suite + stub anthropic client builder.
  - `scorers/exact-match.ts`: deterministic string equality scoring.
  - `scorers/regex.ts`: regex-based scoring.
  - `scorers/llm-judge.ts`: LLM-graded scoring via injected or lazy-loaded Anthropic client.

- `src/security/`
  - `security-test-types.ts`: security test contracts.
  - `security-runner.ts`: `runSecuritySuite` implementation.
  - `injection-suite.ts`, `escalation-suite.ts`, `poisoning-suite.ts`, `escape-suite.ts`: built-in case arrays.
  - `index.ts`: security submodule barrel.

- `src/__tests__/`
  - Unit tests for recorder, mock resolver, eval framework, security runner/suites.
  - Export-surface tests.
  - Monorepo boundary enforcement tests (`boundary-enforcement.test.ts`, `boundary/architecture.test.ts`).

Build and test config:
- `tsup.config.ts`: ESM build from `src/index.ts`, type declarations enabled.
- `vitest.config.ts`: node environment, coverage thresholds (statements 40, branches 30, functions 30, lines 40).

## Runtime and Control Flow
### LLM record/replay flow
1. Caller wires `LlmRecorder` into `ModelRegistry` middleware chain.
2. `beforeInvoke(context)`:
- `record` mode: returns `{ cached: false }` and allows live call.
- `replay` mode: computes context hash, loads fixture JSON, returns cached response/usage.
- Missing fixture in strict replay throws with guidance to run with `LLM_RECORD=1`.
3. `afterInvoke(context, response, usage)`:
- Active only in `record` mode.
- Persists fixture file under `<fixtureDir>/<hash>.json`.

Hashing input includes messages, model, temperature, maxTokens, and provider. File names are a 16-char SHA-256 prefix.

### `withRecordedRegistry` flow
1. Creates `LlmRecorder` from caller options.
2. Creates `ModelRegistry`.
3. Registers a stub Anthropic provider config.
4. Attaches recorder middleware.
5. Returns `{ registry, recorder }`.

This enables replay-first tests without real keys/network.

### Eval flow (`runEvalSuite`)
1. Resolve `passThreshold` (default `0.7`).
2. For each case (sequentially):
- Execute suite target; on target error, convert error to output string (`[target error: ...]`).
- Execute all scorers concurrently for that case.
- Compute per-case aggregate score as scorer mean.
- Mark case pass when aggregate `>= passThreshold`.
3. Compute suite aggregate score, pass rate, and `allPassed` flag.
4. Return `EvalRunResult` with timestamp.

### Security flow (`runSecuritySuite`)
1. Iterate suite cases sequentially.
2. Invoke `checker(input)`.
3. Evaluate pass by expected behavior:
- `block`: `blocked === true`
- `detect`: `blocked || detected`
- `safe`: `!blocked && !detected`
4. Build details string (`[PASS|FAIL] ... expected=..., got blocked=..., detected=...`).
5. Aggregate `passed`, `failed`, `passRate`, and derive suite name from first case category (or `empty-security-suite`).

## Key APIs and Types
Primary exports from `src/index.ts`:

Recorder and setup:
- `class LlmRecorder`
- `type LlmRecorderOptions`
- `type LlmFixture`
- `type RecorderMode`
- `function withRecordedRegistry(options): RecordedRegistry`

Skill testing:
- `class MockSkillStepResolver`
- `type MockCall`

Eval framework:
- `runEvalSuite(suite): Promise<EvalRunResult>`
- `ExactMatchScorer`, `RegexScorer`, `LlmJudgeScorer`
- `createDemoEvalSuite(judgeClient?)`
- `buildStubAnthropicClient(override?)`
- Types: `EvalScore`, `EvalScorer`, `EvalCase`, `EvalSuite`, `EvalCaseResult`, `EvalRunResult`
- LLM judge types: `AnthropicClient`, `LlmJudgeOptions`

Security framework:
- `runSecuritySuite(suite, checker): Promise<SecuritySuiteResult>`
- `INJECTION_SUITE`, `ESCALATION_SUITE`, `POISONING_SUITE`, `ESCAPE_SUITE`
- Types: `SecurityCategory`, `SecuritySeverity`, `SecurityExpectedBehavior`, `SecurityTestCase`, `SecurityTestResult`, `SecuritySuiteResult`, `SecurityChecker`

Notable contract details:
- `LlmJudgeScorer` supports injected client and otherwise lazy-imports `@anthropic-ai/sdk`.
- `MockSkillStepResolver.resolve(skillId)` returns `WorkflowStep` and throws when skill is not registered.
- `runEvalSuite` tolerates target exceptions but does not swallow scorer exceptions.
- `runSecuritySuite` currently propagates checker exceptions (no per-case try/catch wrapper).

## Dependencies
Runtime dependencies (`package.json`):
- `@dzupagent/core` (for `RegistryMiddleware`, `ModelRegistry`, and related types)
- `@dzupagent/agent` (for `WorkflowStep` and `SkillStepResolver` types)

Tooling/dev dependencies:
- `typescript`
- `tsup`
- `vitest`

Soft/optional runtime dependency:
- `@anthropic-ai/sdk` is dynamically imported by `LlmJudgeScorer` only when no client override is supplied.
- It is intentionally not a direct `package.json` dependency in this package.

Packaging:
- ESM-only output (`type: module`, tsup format `esm`).
- Package export map currently exposes only `.` (`dist/index.js` + declarations).

## Integration Points
Current integration points with the broader workspace:

- `@dzupagent/core`
  - `LlmRecorder` plugs into registry middleware lifecycle (`beforeInvoke`/`afterInvoke`).
  - `withRecordedRegistry` instantiates `ModelRegistry` and provider config.

- `@dzupagent/agent`
  - `MockSkillStepResolver` conforms to `SkillStepResolver` and returns `WorkflowStep`.

- External eval providers
  - `LlmJudgeScorer` can use a real Anthropic SDK client or a test stub client.

- CI/test workflows
  - Security suites and eval runner support regression gates via pass-rate thresholds and case-level diagnostics.
  - Boundary tests in this package scan monorepo source/config to enforce architectural constraints across packages/apps.

## Testing and Observability
Test coverage in `src/__tests__` includes:

- Recorder behavior
  - Replay hits/misses, strict mode behavior, fixture path/hash stability, record-mode writing, seeded fixtures.

- Mock resolver behavior
  - Registration variants (sync, async, delayed, error), call tracking, unregister semantics, resolver isolation.

- Eval framework behavior
  - Scorer correctness (`exact-match`, `regex`, `llm-judge` parsing/error handling).
  - Runner aggregation, thresholds, empty cases/scorers, target error handling.
  - Demo suite completion with stub client.

- Security framework behavior
  - Suite content structure and schema validity.
  - Runner pass/fail semantics, details formatting, edge cases, empty suite handling.

- Architectural enforcement
  - Static checks for forbidden cross-package and cross-app imports.
  - Declared dependency rules and circular dependency guardrails.
  - Validation of boundary policy/config completeness.

Observability surfaces:
- `SecurityTestResult.details` and `EvalScore.reasoning` provide human-readable diagnostics for CI logs.
- Recorder fixtures persist request/response/usage artifacts for offline debugging and deterministic replay.

## Risks and TODOs
- Export-map mismatch risk:
  - `README` and inline comments reference `@dzupagent/testing/vitest-llm-setup`, but `package.json` only exports `.`. Consumers relying on subpath imports may fail unless tooling bypasses export maps.

- Optional Anthropic dependency ergonomics:
  - `LlmJudgeScorer` lazy-imports `@anthropic-ai/sdk`; environments without the package will fail at runtime when no client is injected.

- Non-deterministic suite content:
  - `POISONING_SUITE` builds one case with `Math.random()` at module load, which can create snapshot churn and harder fixture comparison.

- Sequential runner throughput:
  - `runSecuritySuite` processes cases sequentially; large suites may become slow without batching/parallel controls.

- Error handling granularity:
  - `runSecuritySuite` propagates checker errors and aborts remaining cases; this is useful for fail-fast, but can reduce complete suite diagnostics in flaky environments.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: architecture rewritten to reflect current package reality, including eval framework, LLM recorder/replay middleware, Vitest registry setup helper, and boundary enforcement tests.