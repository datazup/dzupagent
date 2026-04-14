# @dzupagent/testing Architecture

## Purpose
`@dzupagent/testing` is a security validation harness for agent deployments. It ships curated adversarial suites and a runner that evaluates whether a target system blocks or detects hostile prompts/behaviors.

## Main Responsibilities
- Define security test case schema and severity taxonomy.
- Provide built-in suites for injection, escalation, poisoning, and escape threats.
- Execute suites against user-provided checker functions.
- Return case-level and aggregate pass/fail outcomes for CI policy enforcement.

## Module Structure
Top-level modules under `src/`:
- `security/security-test-types.ts`: shared type contracts.
- `security/security-runner.ts`: suite runner and scoring logic.
- `security/injection-suite.ts`: prompt injection vectors.
- `security/escalation-suite.ts`: privilege escalation vectors.
- `security/poisoning-suite.ts`: memory poisoning vectors.
- `security/escape-suite.ts`: sandbox escape vectors.

## How It Works
1. Consumer provides `SecurityChecker(input) -> { blocked, detected, details }`.
2. `runSecuritySuite` iterates test cases in selected suite.
3. Each result is evaluated against expected behavior (`block`, `detect`, `safe`).
4. Aggregate suite metrics are computed (`passRate`, totals, failed list).
5. CI can fail build on threshold breach or critical-case failures.

## Main Features
- Ready-made adversarial corpora for common LLM-agent attack classes.
- Simple checker interface decoupled from agent implementation.
- Severity-tagged reporting for policy-based gating.
- Designed for continuous regression detection in secure deployment pipelines.

## Integration Boundaries
- Works with any agent runtime that can expose a checker function.
- Often paired with `@dzupagent/otel` safety monitor and server CI flows.

## Extensibility Points
- Add organization-specific threat suites.
- Add custom result policies (for example weighted severity thresholds).
- Extend runner outputs with richer compliance metadata.

## Quality and Test Posture
- Includes package-level tests validating suite execution and expected behavior mapping.
