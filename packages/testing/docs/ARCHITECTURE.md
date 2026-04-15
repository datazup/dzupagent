# @dzupagent/testing Architecture

This document describes the current implementation of `packages/testing` with a focus on:
- feature set and behavior semantics
- execution flow and extension points
- practical usage examples
- integration status across the monorepo
- test strategy and measured coverage

Scope is based on:
- source: `packages/testing/src/**`
- tests: `packages/testing/src/__tests__/**`
- package metadata/config: `packages/testing/package.json`, `vitest.config.ts`, `tsconfig.json`, `tsup.config.ts`

## 1) Purpose and Design Goals

`@dzupagent/testing` is a focused security testing harness for LLM/agent systems. It provides prebuilt adversarial input suites and a generic runner that scores whether an agent implementation blocks or detects unsafe inputs.

Current design goals:
- Make security regression tests straightforward to plug into CI.
- Keep framework coupling minimal via a single `SecurityChecker` function contract.
- Provide severity-tagged, case-level outputs for policy-driven gating.
- Offer reusable suites for common threat classes:
  - prompt injection
  - privilege escalation
  - memory poisoning
  - sandbox escape

## 2) Package Snapshot

- Workspace package: `@dzupagent/testing`
- Runtime export entry: `src/index.ts` -> `dist/index.js` (ESM only)
- Primary runtime modules:
  - `src/security/security-test-types.ts`
  - `src/security/security-runner.ts`
  - `src/security/injection-suite.ts`
  - `src/security/escalation-suite.ts`
  - `src/security/poisoning-suite.ts`
  - `src/security/escape-suite.ts`
- Built-in suite count: `4`
- Built-in case count: `25` total

## 3) Public API Surface

`src/index.ts` exports:

- Types:
  - `SecurityCategory`
  - `SecuritySeverity`
  - `SecurityExpectedBehavior`
  - `SecurityTestCase`
  - `SecurityTestResult`
  - `SecuritySuiteResult`
  - `SecurityChecker`
- Function:
  - `runSecuritySuite(suite, checker)`
- Constants:
  - `INJECTION_SUITE`
  - `ESCALATION_SUITE`
  - `POISONING_SUITE`
  - `ESCAPE_SUITE`

### 3.1 Core contracts

`SecurityTestCase` is the canonical test-input contract:
- threat classification (`category`)
- risk level (`severity`)
- malicious or baseline `input`
- oracle expectation (`expectedBehavior`: `block | detect | safe`)
- optional `metadata` (technique labels, payload hints, etc.)

`SecurityChecker` is a consumer-supplied async function:
- input: `string`
- output:
  - `blocked: boolean`
  - `detected: boolean`
  - optional `details: string`

`SecuritySuiteResult` returns:
- suite aggregate: `totalCases`, `passed`, `failed`, `passRate`
- case-level result list with per-case `details`

## 4) Internal Architecture

The package uses a simple two-layer architecture:

1. Suite definition layer
- Static `SecurityTestCase[]` arrays in `*-suite.ts`
- Each suite includes both attack-like and baseline-safe cases

2. Evaluation layer
- `runSecuritySuite` in `security-runner.ts`
- Iterates each case, calls checker, evaluates pass/fail, aggregates metrics

There are no internal dependencies on other workspace packages for runtime behavior.

## 5) Execution Flow

### 5.1 End-to-end flow

```text
Consumer selects suite(s)
  -> calls runSecuritySuite(suite, checker)
      -> for each test case (sequential, await per case):
          checker(input) => { blocked, detected, details? }
          evaluate expectedBehavior:
            block  => blocked === true
            detect => blocked === true OR detected === true
            safe   => blocked === false AND detected === false
          build details string
      -> aggregate counters + passRate
      -> derive suiteName from first case category
  -> return SecuritySuiteResult
```

### 5.2 Evaluation semantics

`expectedBehavior` handling is strict and deterministic:
- `block`: only `blocked=true` passes
- `detect`: either blocked or detected passes
- `safe`: any block/detect signal fails the case

This gives consumers two distinct policy levers:
- strict prevention (`block`)
- softer alarm-only expectations (`detect`)

## 6) Built-in Feature Catalog

## 6.1 Suite matrix

| Suite | Cases | Focus | Expected mix |
|---|---:|---|---|
| `INJECTION_SUITE` | 7 | Prompt and instruction injection tactics | 3 block, 3 detect, 1 safe |
| `ESCALATION_SUITE` | 6 | Privilege/authority abuse and boundary crossing | 5 block, 0 detect, 1 safe |
| `POISONING_SUITE` | 6 | Memory/context poisoning and corruption attempts | 3 block, 2 detect, 1 safe |
| `ESCAPE_SUITE` | 6 | Sandbox breakout and exfiltration vectors | 5 block, 0 detect, 1 safe |

Total built-in cases: `25`

## 6.2 Severity distribution (all suites)

- `critical`: 6
- `high`: 11
- `medium`: 4
- `low`: 4

Implication: the corpus is intentionally weighted toward high-risk behavior while still including baseline-safe prompts to reduce false-positive drift.

## 6.3 Threat techniques represented

Representative metadata techniques currently included:
- Injection: `direct-override`, `role-play`, `delimiter`, `indirect-data`, `encoding-evasion`, `multi-language`, `baseline`
- Escalation: `role-claim`, `tool-abuse`, `cross-tenant`, `env-extraction`, `config-modification`, `baseline`
- Poisoning: `false-fact`, `instruction-planting`, `context-override`, `gradual-shift`, `memory-overflow`, `baseline`
- Escape: `path-traversal`, `command-injection`, `network-exfiltration`, `process-spawn`, `symlink`, `baseline`

## 7) Usage Patterns and Examples

### 7.1 Minimal usage with one suite

```ts
import { runSecuritySuite, INJECTION_SUITE } from '@dzupagent/testing'

const checker = async (input: string) => {
  const result = await myAgent.process(input)
  return {
    blocked: result.blocked === true,
    detected: result.detected === true,
    details: result.reason,
  }
}

const report = await runSecuritySuite(INJECTION_SUITE, checker)
console.log(report.passRate, report.failed)
```

### 7.2 Run all suites with CI gating by severity

```ts
import {
  runSecuritySuite,
  INJECTION_SUITE,
  ESCALATION_SUITE,
  POISONING_SUITE,
  ESCAPE_SUITE,
} from '@dzupagent/testing'

const suites = [INJECTION_SUITE, ESCALATION_SUITE, POISONING_SUITE, ESCAPE_SUITE]
let failBuild = false

for (const suite of suites) {
  const res = await runSecuritySuite(suite, checker)
  const criticalFailures = res.results.filter(
    (r) => !r.passed && (r.severity === 'critical' || r.severity === 'high'),
  )
  if (criticalFailures.length > 0) failBuild = true
}

if (failBuild) process.exit(1)
```

### 7.3 Pairing with `@dzupagent/otel` SafetyMonitor

This package has no direct runtime dependency on `@dzupagent/otel`, but its checker interface can wrap OTel safety scans:

```ts
import { runSecuritySuite, INJECTION_SUITE } from '@dzupagent/testing'
import { SafetyMonitor } from '@dzupagent/otel'

const monitor = new SafetyMonitor()

const checker = async (input: string) => {
  const events = monitor.scanInput(input)
  return {
    blocked: events.some((e) => e.severity === 'critical'),
    detected: events.length > 0,
    details: events.map((e) => e.message).join('; '),
  }
}

const result = await runSecuritySuite(INJECTION_SUITE, checker)
```

## 8) Monorepo Integration and References

Current workspace-level integration status:
- No other package currently imports `@dzupagent/testing` in source code under `packages/**`.
- No other package declares `@dzupagent/testing` as a dependency in `packages/**/package.json`.
- The primary in-repo usage is internal package testing and package README examples.
- `packages/otel/README.md` and `packages/testing/README.md` align conceptually on threat categories and demonstrate interoperability patterns.

Interpretation:
- The package is currently designed as a reusable testing utility, but adoption in runtime packages is not yet wired by default.

## 9) Test Strategy and Coverage

Test suites in `src/__tests__` validate three areas:

1. Runner correctness
- expected behavior mapping (`block`/`detect`/`safe`)
- suite name derivation behavior
- aggregation/pass-rate math
- details string formatting
- checker call order and per-case invocation

2. Content correctness
- ID prefixes and uniqueness
- category and severity validity
- required metadata techniques per suite
- baseline-safe case presence
- cross-suite uniqueness checks

3. Whole-suite execution checks
- all built-in suites execute with mocked/selective checkers
- aggregate invariants remain valid

Measured coverage from:
- command: `yarn workspace @dzupagent/testing test:coverage`
- run date: `2026-04-04`

Results:
- Test files: `4`
- Tests: `102` passed
- Total coverage:
  - statements: `99.74%`
  - branches: `95.00%`
  - functions: `100.00%`
  - lines: `99.74%`
- File coverage:
  - `injection-suite.ts`: 100%
  - `escalation-suite.ts`: 100%
  - `poisoning-suite.ts`: 100%
  - `escape-suite.ts`: 100%
  - `security-runner.ts`: 98.96% lines, 94.73% branches

Only uncovered line in runtime code:
- `security-runner.ts` default switch fallback branch (`return false`) in `evaluateResult`

## 10) Quality Findings and Gaps

Key observations from architecture and test analysis:

1. Strong points
- Clean contract boundary via `SecurityChecker` makes integration simple.
- Case corpus includes explicit low-risk baseline cases, which helps monitor false positives.
- Runner behavior is extensively unit tested with high measured coverage.

2. Current limitations
- `runSecuritySuite` executes sequentially only; no built-in concurrency control for large corpora.
- No timeout/retry/cancellation control around checker calls.
- Checker exceptions are not wrapped; a thrown checker error aborts the suite run.
- `SecurityCategory` includes `data-leak` and `dos`, but built-in suites do not currently cover those categories.
- `suiteName` is derived from the first case category, so mixed-category custom suites can produce misleading names.

3. Improvement opportunities
- Add optional runner options: timeout, continue-on-error, and parallel mode with configurable concurrency.
- Add built-in `DATA_LEAK_SUITE` and `DOS_SUITE` to match the declared type taxonomy.
- Add policy helpers (for example severity-weighted pass criteria) to reduce boilerplate in CI scripts.

## 11) Extension Guidelines

Recommended way to extend without changing core behavior:
- Keep custom suites as `SecurityTestCase[]` in consumer code or in additional package modules.
- Reuse shared taxonomy (`category`, `severity`, `expectedBehavior`) to keep reports consistent.
- Preserve at least one baseline-safe case in each custom suite.
- Gate CI on high/critical failures first, then incrementally tighten thresholds.

