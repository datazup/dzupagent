# Core Security Architecture

## Scope
This document covers the security subsystem implemented under `packages/core/src/security` and its published surfaces through:

- Root exports in `packages/core/src/index.ts`
- Curated facade exports in `packages/core/src/facades/security.ts`
- Package subpath export `@dzupagent/core/security` from `packages/core/package.json`

In scope:

- `risk-classifier.ts` and `tool-permission-tiers.ts`
- `secrets-scanner.ts` and `pii-detector.ts`
- `output-pipeline.ts`
- `policy/*`
- `audit/*`
- `monitor/*`
- `memory/*`
- `output/*`
- `classification/*`

Out of scope:

- Security behavior implemented in other packages
- Non-security runtime internals except where they are direct integration points (event bus, exports)

## Responsibilities
The security subsystem provides reusable, composable building blocks for:

- Tool risk tiering (`auto`, `log`, `require-approval`)
- Secret detection and redaction
- PII detection and redaction
- Ordered output sanitization pipelines
- Policy authoring/evaluation primitives (zero-trust style, deny-overrides)
- Compliance audit storage and event-driven audit logging
- Runtime safety monitoring with built-in rules
- Memory poisoning heuristics before memory writes
- Data sensitivity classification and classification-aware filtering

The module is mostly policy/scan/evaluation logic. It does not enforce a single global workflow by itself; consumers compose these pieces in their own runtime path.

## Structure
Current file layout:

- `index.ts`
- `risk-classifier.ts`
- `tool-permission-tiers.ts`
- `secrets-scanner.ts`
- `pii-detector.ts`
- `output-pipeline.ts`
- `policy/`
- `policy/policy-types.ts`
- `policy/policy-evaluator.ts`
- `policy/policy-translator.ts`
- `policy/index.ts`
- `audit/`
- `audit/audit-types.ts`
- `audit/audit-store.ts`
- `audit/in-memory-audit-store.ts`
- `audit/audit-logger.ts`
- `audit/index.ts`
- `monitor/`
- `monitor/built-in-rules.ts`
- `monitor/safety-monitor.ts`
- `monitor/index.ts`
- `memory/`
- `memory/memory-defense.ts`
- `memory/index.ts`
- `output/`
- `output/output-filter-enhanced.ts`
- `output/index.ts`
- `classification/`
- `classification/data-classification.ts`
- `classification/index.ts`

Export topology:

- `src/security/index.ts` is the internal security barrel.
- `src/facades/security.ts` re-exports a curated domain API for `@dzupagent/core/security`.
- `src/index.ts` also re-exports security APIs at the root package level.

## Runtime and Control Flow
There is no single orchestrator in this folder. The runtime pattern is composition-based.

Typical composition path for action governance:

1. `createRiskClassifier().classify(toolName, args)` returns a risk tier.
2. `PolicyEvaluator.evaluate(policySet, context)` performs synchronous allow/deny decisioning.
3. The caller emits typed security events (`policy:*`, `safety:*`, `memory:*`) using `DzupEventBus`.
4. `ComplianceAuditLogger.attach(eventBus)` listens to mapped events and appends audit entries via `ComplianceAuditStore`.

Typical composition path for output hardening:

1. Build a pipeline with `createDefaultPipeline()` or `new OutputPipeline({ stages })`.
2. Run `await pipeline.process(content)`.
3. Optional enhanced stages from `output/output-filter-enhanced.ts` can be inserted (`createHarmfulContentFilter`, `createClassificationAwareRedactor`).
4. Final content is returned with `appliedStages`, truncation metadata, and original length.

Safety monitoring flow:

1. Create monitor via `createSafetyMonitor()`.
2. Optionally `attach(eventBus)` to observe `tool:error` and `memory:written`.
3. `scanContent()` executes built-in/custom rules and records violations.
4. For violations, monitor emits `safety:violation`, and optionally `safety:blocked` or `safety:kill_requested` based on rule action.

Memory defense flow:

1. `createMemoryDefense().scan(content)` evaluates homoglyph, encoded payload, and bulk-modification heuristics.
2. Returns `{ allowed, threats, normalizedContent? }`.
3. Caller decides whether to allow, quarantine, or reject based on returned threats/actions.

## Key APIs and Types
Risk classification:

- `createRiskClassifier(config?)`
- `RiskTier = 'auto' | 'log' | 'require-approval'`
- `RiskClassification`, `RiskClassifierConfig`, `RiskClassifier`
- Default tool lists from `DEFAULT_AUTO_APPROVE_TOOLS`, `DEFAULT_LOG_TOOLS`, `DEFAULT_REQUIRE_APPROVAL_TOOLS`

Secrets and PII:

- `scanForSecrets(content)`, `redactSecrets(content)`
- `detectPII(content)`, `redactPII(content)`
- `SecretMatch`, `ScanResult`, `PIIMatch`, `PIIDetectionResult`

Output sanitization:

- `class OutputPipeline`
- `createDefaultPipeline(config?)`
- `SanitizationStage`, `OutputPipelineConfig`, `PipelineResult`

Policy engine:

- `class PolicyEvaluator` (sync evaluate + validate)
- `class PolicyTranslator` (LLM-backed authoring/explanation)
- `class InMemoryPolicyStore`
- `PolicyRule`, `PolicySet`, `PolicyContext`, `PolicyDecision`, condition/operator types

Audit trail:

- `interface ComplianceAuditStore`
- `class InMemoryAuditStore`
- `class ComplianceAuditLogger`
- `ComplianceAuditEntry`, `AuditFilter`, `IntegrityCheckResult`, `AuditRetentionPolicy`

Safety monitor:

- `createSafetyMonitor(config?)`
- `getBuiltInRules()` (5 built-in rules)
- `SafetyMonitor`, `SafetyRule`, `SafetyViolation`, `SafetyCategory`, `SafetySeverity`, `SafetyAction`

Memory defense:

- `createMemoryDefense(config?)`
- `MemoryDefense`, `MemoryDefenseResult`, `MemoryThreat`, `EncodedContentMatch`

Enhanced output and classification:

- `createHarmfulContentFilter(categories?)`
- `createClassificationAwareRedactor(classificationLevel?)`
- `DataClassifier`, `DEFAULT_CLASSIFICATION_PATTERNS`
- `ClassificationLevel`, `DataClassificationTag`, `ClassificationConfig`

## Dependencies
Direct code-level dependencies inside `src/security` are intentionally lightweight:

- Internal core modules:
- `../../events/event-bus.js` (`DzupEventBus` integration for audit/monitor)
- `../../errors/forge-error.js` (`PolicyTranslator` error signaling)
- Local sibling security modules (PII/secrets pipeline composition)

- Platform/runtime primitives:
- `performance.now()` in `PolicyEvaluator`
- `Buffer` usage in memory-defense encoded content detection

Package-level `dependencies` in `packages/core/package.json` are workspace packages (`@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/runtime-contracts`), but the security subtree itself does not directly import them.

No third-party runtime library is directly imported by files under `src/security` in the current code snapshot.

## Integration Points
Published API entry points:

- `@dzupagent/core/security` -> `dist/facades/security.js`
- `@dzupagent/core` root exports include the same security primitives
- `@dzupagent/core/facades` includes `security` namespace via `facades/index.ts`

Event system integration:

- `ComplianceAuditLogger` consumes `DzupEventBus.onAny(...)` and maps selected event types:
- `policy:evaluated`, `policy:denied`, `policy:set_updated`
- `safety:violation`, `safety:blocked`, `safety:kill_requested`
- `memory:threat_detected`, `memory:quarantined`
- `agent:started`, `agent:completed`, `agent:failed`
- `tool:called`, `tool:error`

- `SafetyMonitor` can emit:
- `safety:violation`
- `safety:blocked`
- `safety:kill_requested`

Cross-subsystem composition points within core:

- Output filters from `security/output/*` are `SanitizationStage` providers for `OutputPipeline`.
- Classification output from `DataClassifier` can drive `createClassificationAwareRedactor(...)` level selection by callers.
- Policy decisions and safety signals are intended to be correlated through the event bus and audit store, not through a hardwired in-folder orchestrator.

## Testing and Observability
Security subsystem test coverage is broad at unit level in `packages/core/src/__tests__`, including:

- Risk tiering: `risk-classifier.test.ts`, `security-risk-classifier.test.ts`
- Secrets scanner: `secrets-scanner.test.ts`
- PII detector: `pii-detector.test.ts`, `security-pii-detector.test.ts`
- Output pipeline: `output-pipeline.test.ts`
- Policy engine/store/translator: `policy-engine.test.ts`, `security-policy-engine.test.ts`
- Audit store/logger: `compliance-audit.test.ts`
- Safety monitor + memory defense + enhanced output filters: `security-monitor.test.ts`
- Classification: `data-classification.test.ts`
- Facade export/behavior coverage: `facade-security.test.ts`
- Broader regression bundle coverage: `w15-b2-security.test.ts`

Observability in this subsystem is event-centric:

- Safety monitor emits security events.
- Audit logger converts events into append-only audit entries.
- Audit store supports integrity checks and NDJSON export for downstream pipelines.

No dedicated metrics collector is implemented directly in `src/security`; metrics are expected to be layered by consuming runtimes.

## Risks and TODOs
Current code-level risks and improvement targets:

- `InMemoryAuditStore` uses a non-cryptographic hash (`djb2`-style variant). Commented in code as a development/testing implementation; production-grade stores should use cryptographic hashing/signing.
- `InMemoryPolicyStore.get()` returns the last saved version, not strictly the numerically highest `version` field if versions are inserted out of order.
- `PolicyTranslator` validates only parseability and presence of `rule`; it does not schema-validate translated rules before returning.
- `SafetyMonitor.attach()` only subscribes to `tool:error` and `memory:written`; broader stream coverage must be wired by the caller through explicit `scanContent(...)` usage.
- `createDefaultPipeline({ customDenyList })` compiles regex patterns directly with `new RegExp(...)`; invalid patterns throw at pipeline creation time.
- Classification level sets are not fully unified:
- `DataClassifier` supports `public|internal|confidential|restricted`
- `createClassificationAwareRedactor` also recognizes `top_secret`

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js