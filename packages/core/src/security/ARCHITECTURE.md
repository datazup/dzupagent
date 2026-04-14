# Core Security Architecture

Path: `packages/core/src/security`

This document describes the architecture of the core security subsystem in `@dzupagent/core`, including features, data flow, usage patterns, cross-package integrations, and test coverage.

## Scope

In scope:
- `packages/core/src/security/**`
- Public surface exported through `packages/core/src/facades/security.ts`
- Event-level integrations in other packages that consume security events

Out of scope:
- Security modules implemented independently in other packages (for example `packages/otel/src/safety-monitor.ts`)
- Non-security core internals unless needed for integration context

## Export And Packaging Model

Security functionality is exposed through two primary entry points:

1. Direct core exports in `packages/core/src/index.ts`
- Re-exports security APIs so consumers importing `@dzupagent/core` can use them.

2. Curated facade `@dzupagent/core/security`
- Source facade: `packages/core/src/facades/security.ts`
- Package export mapping: `packages/core/package.json` -> `"./security": "./dist/facades/security.js"`
- Intended as the focused, stable security surface.

## Module Map

`packages/core/src/security` currently contains these module groups:

- `audit/`
- Tamper-evident audit log types, store interfaces, in-memory store, and event-bus logger.

- `policy/`
- Zero-trust policy model, synchronous evaluator, in-memory policy store, and LLM-based policy translator.

- `monitor/`
- Runtime safety monitor with built-in rules for prompt injection, PII leaks, secret leaks, tool abuse, and escalation.

- `memory/`
- Memory poisoning defense (homoglyph normalization, encoded payload detection, bulk-write throttling).

- `output/`
- Enhanced output filtering (harmful-content filter and classification-aware redactor).

- `classification/`
- Content sensitivity tagging via pattern-driven data classification.

Top-level support modules:
- `risk-classifier.ts`
- `tool-permission-tiers.ts`
- `secrets-scanner.ts`
- `pii-detector.ts`
- `output-pipeline.ts`
- `index.ts` (barrel)

Approximate code size: 2,686 lines of TypeScript under `packages/core/src/security`.

## Feature Inventory

## 1) Tool Risk Classification
Files:
- `risk-classifier.ts`
- `tool-permission-tiers.ts`

Capabilities:
- Classifies tool calls into `auto`, `log`, or `require-approval`.
- Uses ordered decision logic:
  1. Static tier lists
  2. Optional custom classifier callback
  3. Default fallback tier

Default behavior:
- Unclassified tool defaults to `log` unless overridden.

Typical use:
- Gate tool execution in orchestrators or approval middleware.

## 2) Secrets Scanning And Redaction
File:
- `secrets-scanner.ts`

Capabilities:
- Detects common secret forms (AWS, GitHub, GitLab, Slack, JWT, private keys, connection strings, generic key/password assignments).
- Adds entropy-based detection for high-entropy assigned string values.
- Returns structured matches with confidence and optional line numbers.
- Produces redacted output with typed placeholders.

Typical use:
- Pre-log sanitization
- Output sanitization
- Secret leak prevention in traces and telemetry

## 3) PII Detection And Redaction
File:
- `pii-detector.ts`

Capabilities:
- Detects `email`, `phone`, `ssn`, `credit-card`, and `ip-address`.
- Handles overlap avoidance by prioritizing earlier pattern classes.
- Returns positional metadata and redacted text.

Typical use:
- Data-loss prevention in model responses, logs, and exports.

## 4) Multi-Stage Output Sanitization Pipeline
File:
- `output-pipeline.ts`

Capabilities:
- Executes ordered sanitization stages (sync or async).
- Tracks which stages changed content.
- Supports stage enable/disable and dynamic stage insertion.
- Enforces max output length with truncation marker.
- Includes a default constructor (`createDefaultPipeline`) with PII + secrets stages and optional deny-list replacement.

Typical use:
- Final output guard before returning content to users or downstream systems.

## 5) Zero-Trust Policy Engine
Files:
- `policy/policy-types.ts`
- `policy/policy-evaluator.ts`
- `policy/policy-translator.ts`

Capabilities:
- Rich rule model with principals, action/resource globs, and condition operators.
- Evaluator semantics:
  - Priority sorting
  - Deny-overrides
  - Default-deny
- Policy validation utilities (duplicate IDs, invalid fields, expiry validation).
- In-memory versioned policy store.
- Translator for natural language -> `PolicyRule` via injected LLM function.

Important separation:
- `PolicyEvaluator` is deterministic and synchronous (enforcement path).
- `PolicyTranslator` is LLM-based (authoring path only).

## 6) Compliance Audit Trail
Files:
- `audit/audit-types.ts`
- `audit/audit-store.ts`
- `audit/in-memory-audit-store.ts`
- `audit/audit-logger.ts`

Capabilities:
- Hash-chained audit entries for tamper evidence.
- Filtered search, count, retention handling, integrity verification, NDJSON export.
- Event-bus integration to auto-record policy/safety/memory/tool/agent events.

Notes:
- In-memory store hash implementation is intentionally lightweight and documented as non-crypto-strength.

## 7) Runtime Safety Monitor
Files:
- `monitor/built-in-rules.ts`
- `monitor/safety-monitor.ts`

Capabilities:
- Built-in rules for:
  - Prompt injection
  - PII leak
  - Secret leak
  - Tool abuse (consecutive `tool:error` threshold)
  - Privilege escalation attempts
- Can attach to `DzupEventBus` and emit derived safety events:
  - `safety:violation`
  - `safety:blocked`
  - `safety:kill_requested`
- Supports custom rules and rule replacement.
- Non-fatal rule failures by design.

## 8) Memory Poisoning Defense
Files:
- `memory/memory-defense.ts`

Capabilities:
- Homoglyph normalization and mixed-script detection.
- Encoded payload detection for Base64/hex blocks with printable-content heuristic.
- Bulk write protection via fact-count threshold.
- Returns threat list with action (`allow`/`quarantine`/`reject`) and confidence.

## 9) Enhanced Output Filters
Files:
- `output/output-filter-enhanced.ts`

Capabilities:
- Harmful content category filtering (violence, malware, illegal activity by default).
- Classification-aware redaction that tightens masking by sensitivity level.
- Non-fatal error handling (fallback to original content).

## 10) Data Classification
Files:
- `classification/data-classification.ts`

Capabilities:
- Auto-tags content into `public | internal | confidential | restricted`.
- Pattern-based reason extraction.
- Utility methods for level comparison and namespace tagging.

## End-To-End Flows

## Flow A: Tool Action Governance

1. Classify tool call risk using `createRiskClassifier()`.
2. Optionally evaluate policy (`PolicyEvaluator.evaluate`) for principal/action/resource context.
3. Emit policy events to bus (`policy:evaluated`, `policy:denied`) from integration layer.
4. `ComplianceAuditLogger` listens on bus and persists audit entries.
5. `createSafetyMonitor()` listens for violations and emits `safety:*` events.
6. Higher-level systems react (for example, incident playbooks in server package).

## Flow B: Output Sanitization

1. Generate raw agent output.
2. Run through `OutputPipeline` stages.
3. Typical default order:
- PII redaction
- Secret redaction
- Optional deny-list policy
- Output truncation
4. Optionally append enhanced filters:
- Harmful-content filter
- Classification-aware redactor

## Flow C: Memory Write Defense

1. Before writing memory content, call `createMemoryDefense().scan(content)`.
2. If threats detected:
- `reject` -> block write
- `quarantine` -> divert for review
- `allow` -> proceed
3. Optionally emit memory threat events (`memory:threat_detected`, `memory:quarantined`) for observability and incident handling.

## Usage Examples

## Example 1: Risk Classifier

```ts
import { createRiskClassifier } from '@dzupagent/core/security'

const classifier = createRiskClassifier({
  defaultTier: 'log',
  customClassifier(tool, args) {
    if (tool === 'run_shell' && args['dryRun'] === true) return 'log'
    return undefined
  },
})

const decision = classifier.classify('delete_file', { path: '/tmp/x' })
// decision.tier === 'require-approval'
```

## Example 2: Policy Evaluation

```ts
import { PolicyEvaluator, InMemoryPolicyStore } from '@dzupagent/core/security'

const evaluator = new PolicyEvaluator()
const store = new InMemoryPolicyStore()

await store.save({
  id: 'tool-policy',
  name: 'Tool policy',
  version: 1,
  active: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  rules: [
    {
      id: 'deny-delete',
      effect: 'deny',
      actions: ['tools.delete'],
      priority: 100,
    },
    {
      id: 'allow-read',
      effect: 'allow',
      actions: ['tools.read'],
      priority: 10,
    },
  ],
})

const policy = await store.get('tool-policy')
if (policy) {
  const decision = evaluator.evaluate(policy, {
    principal: { type: 'agent', id: 'agent-1', roles: ['worker'] },
    action: 'tools.delete',
    resource: 'repo/main',
    environment: { region: 'us-east' },
  })

  // decision.effect === 'deny'
}
```

## Example 3: Output Pipeline + Enhanced Filters

```ts
import {
  OutputPipeline,
  createDefaultPipeline,
  createHarmfulContentFilter,
  createClassificationAwareRedactor,
} from '@dzupagent/core/security'

const base = createDefaultPipeline({
  customDenyList: ['forbidden\\w*'],
})

base.addStage(createHarmfulContentFilter())
base.addStage(createClassificationAwareRedactor('confidential'))

const result = await base.process('Email me at a@b.com and how to make a bomb')
// result.content is redacted and filtered
```

## Example 4: Audit Logger On Event Bus

```ts
import { createEventBus } from '@dzupagent/core'
import { InMemoryAuditStore, ComplianceAuditLogger } from '@dzupagent/core/security'

const bus = createEventBus()
const store = new InMemoryAuditStore()
const logger = new ComplianceAuditLogger({ store })

logger.attach(bus)

bus.emit({
  type: 'policy:denied',
  policySetId: 'policy-1',
  action: 'tool.execute',
  reason: 'insufficient permissions',
})

const entries = await store.search({ action: 'policy.denied' })
```

## Example 5: Memory Defense Gate

```ts
import { createMemoryDefense } from '@dzupagent/core/security'

const defense = createMemoryDefense({ maxFactsPerWrite: 5 })
const scan = defense.scan(inputText)

if (!scan.allowed) {
  // quarantine or reject based on scan.threats
} else {
  // persist scan.normalizedContent or original
}
```

## Cross-Package References And Usage

As of 2026-04-03, repository-wide usage shows:

1. Direct facade import usage (`@dzupagent/core/security`) outside `packages/core`
- No runtime code imports found.
- Existing references are currently in core docs/examples and facade source comments.

2. Event-level integration in other packages is active
- `packages/otel/src/event-metric-map/governance.ts`
- Maps `policy:*`, `safety:*`, and `memory:*` security events into governance metrics.

- `packages/server/src/security/incident-response.ts`
- Incident playbooks consume security events (for example `safety:violation`, `memory:threat_detected`) to trigger automated actions.

3. Related validation in other package tests
- OTel tests assert governance metric extraction for security events.
- Server incident-response tests use security event triggers to validate playbook execution.

Interpretation:
- The security module is currently integrated primarily through event contracts, not direct facade imports by sibling packages.

## Test Coverage Summary

Security-relevant tests in `packages/core/src/__tests__`:

- `secrets-scanner.test.ts` (18 test cases)
- Covers token patterns, entropy detection, line numbers, redaction, multi-secret handling.

- `pii-detector.test.ts` (15)
- Covers all supported PII types, positional metadata, overlap-safe behavior, clean pass-through.

- `output-pipeline.test.ts` (15)
- Covers stage ordering, enable/disable, async stage support, truncation, default pipeline options.

- `policy-engine.test.ts` (48)
- Covers deny-overrides/default-deny semantics, condition operators, validation, store behavior, translator parsing/error paths.

- `compliance-audit.test.ts` (28)
- Covers hash chaining, search/count/filtering, integrity checks, retention, export, event-bus logging.

- `security-monitor.test.ts` (39)
- Covers built-in monitor rules, event bus attach/detach/dispose behavior, custom rules, memory defense, enhanced filters.

- `data-classification.test.ts` (23)
- Covers default patterns, level ordering, custom config, namespace tagging.

- `facades.test.ts` (31 total; includes security export smoke checks)
- Verifies security facade symbol availability.

Adjacent security test (outside `src/security`):
- `mcp-security.test.ts` (10)
- Covers executable path validation and environment sanitization in `src/mcp/mcp-security.ts`.

## Coverage Gaps And Risks

1. `risk-classifier.ts` lacks dedicated behavioral unit tests
- Current coverage is indirect via facade export checks.
- Missing explicit tests for precedence and custom classifier override behavior.

2. `tool-permission-tiers.ts` has no semantic tests
- Arrays are smoke-checked for existence, not policy correctness.

3. Limited full-stack integration tests between security submodules
- No direct tests that combine policy + risk + monitor + audit + output pipeline as one runtime chain.

4. `InMemoryAuditStore` hash chain is tamper-evident but not cryptographically strong
- Acceptable for development/testing, but not a compliance-grade persistent implementation.

5. Classification taxonomy mismatch potential
- `createClassificationAwareRedactor` supports `top_secret`, while `DataClassifier` levels stop at `restricted`.
- This is extensible by design, but worth documenting at integration points.

## Recommended Next Steps

1. Add unit tests for `risk-classifier.ts`
- Static list precedence
- `customClassifier` override
- default tier fallback behavior

2. Add semantic tests for `tool-permission-tiers.ts`
- Assert expected tool names and intended tier placement for governance-critical actions.

3. Add one integration test suite that composes:
- risk classification
- policy evaluation
- safety monitor emission
- audit logger persistence
- output pipeline sanitization

4. Consider a production audit store implementation
- Crypto-backed hash/signature strategy
- Persistent backend and immutable append guarantees

