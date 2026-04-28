# Core Security Architecture

## Scope
This document describes the security subsystem implemented in `packages/core/src/security`.

It covers:
- Public security API surface exported from `packages/core/src/security/index.ts`.
- Curated facade surface exported from `packages/core/src/facades/security.ts` and published as `@dzupagent/core/security` (`package.json` subpath export `./security -> dist/facades/security.js`).
- Internal security helper `content-sanitizer.ts` that is consumed inside `@dzupagent/core` (not part of the public security barrel).
- Security-focused tests under `packages/core/src/__tests__`.

It does not cover:
- Security logic implemented in other packages.
- App-level policy orchestration outside `@dzupagent/core`.

## Responsibilities
The `src/security` module provides composable primitives for:
- Tool risk tiering (`auto`, `log`, `require-approval`) via configurable and default tool lists.
- Secret detection and redaction (regex plus entropy heuristic for assigned strings).
- PII detection and redaction for email/phone/SSN/card/IP patterns.
- Multi-stage output sanitization through a configurable pipeline.
- Policy modeling, storage abstraction, synchronous evaluation, and LLM-assisted policy translation.
- Tamper-evident audit logging via append-only hash chaining in a store interface.
- Runtime safety monitoring with built-in rules and optional custom rules.
- Memory poisoning defense (homoglyph normalization, encoded payload detection, bulk-fact guardrails).
- Data classification and classification-aware output redaction helpers.
- Shared outbound URL validation for SSRF-sensitive fetch surfaces. The default policy allows public HTTPS destinations only, rejects loopback/private/link-local literal and DNS-resolved IPs, and requires explicit host/IP allowlists for trusted internal deployments.
- Input content scanning used by skill persistence (`skills/skill-manager.ts` imports `scanContent` from `security/content-sanitizer.ts`).

## Structure
Current `src/security` layout:

- `risk-classifier.ts`: creates `RiskClassifier` and classification logic.
- `tool-permission-tiers.ts`: default tool names grouped by risk tier.
- `outbound-url-policy.ts`: shared public-destination URL validator and secure fetch wrapper that revalidates redirect hops.
- `secrets-scanner.ts`: `scanForSecrets` and `redactSecrets`.
- `pii-detector.ts`: `detectPII` and `redactPII`.
- `output-pipeline.ts`: `OutputPipeline` and `createDefaultPipeline`.
- `content-sanitizer.ts`: internal prompt-injection/exfiltration/invisible-unicode scanner used by skills.
- `policy/`
- `policy/policy-types.ts`: policy types and `InMemoryPolicyStore`.
- `policy/policy-evaluator.ts`: synchronous deny-overrides evaluator and validator.
- `policy/policy-translator.ts`: LLM-based rule translation/explanation.
- `policy/index.ts`: policy barrel exports.
- `audit/`
- `audit/audit-types.ts`: audit entry/filter/retention/integrity types.
- `audit/audit-store.ts`: `ComplianceAuditStore` interface.
- `audit/in-memory-audit-store.ts`: in-memory append/search/verify/export implementation.
- `audit/audit-logger.ts`: event-bus integrated logger.
- `audit/index.ts`: audit barrel exports.
- `monitor/`
- `monitor/built-in-rules.ts`: built-in rule definitions and `getBuiltInRules()`.
- `monitor/safety-monitor.ts`: `createSafetyMonitor` implementation.
- `monitor/index.ts`: monitor barrel exports.
- `memory/`
- `memory/memory-defense.ts`: memory poisoning defense implementation.
- `memory/index.ts`: memory-defense barrel exports.
- `output/`
- `output/output-filter-enhanced.ts`: harmful-content and classification-aware filter stages.
- `output/index.ts`: enhanced output barrel exports.
- `classification/`
- `classification/data-classification.ts`: classifier, levels, default patterns.
- `classification/index.ts`: classification barrel exports.
- `index.ts`: top-level security barrel for the public security surface.

## Runtime and Control Flow
Security behavior is composition-based; there is no single central orchestrator in this folder.

Typical flow for tool governance and audit:
1. Caller classifies a tool call through `createRiskClassifier().classify(toolName, args)`.
2. Caller evaluates request context with `PolicyEvaluator.evaluate(policySet, context)`.
3. Caller emits runtime events on `DzupEventBus` (`policy:*`, `tool:*`, `memory:*`, `safety:*`, `agent:*`, `llm:*`).
4. `ComplianceAuditLogger.attach(eventBus)` receives mapped event types via `onAny` and appends entries through `ComplianceAuditStore`.

Output hardening flow:
1. Build `OutputPipeline` directly or via `createDefaultPipeline`.
2. Run `await pipeline.process(content)`.
3. Optional enhanced stages (`createHarmfulContentFilter`, `createClassificationAwareRedactor`) can be inserted as `SanitizationStage` providers.
4. Result returns transformed content and metadata: `appliedStages`, `truncated`, `originalLength`.

Safety monitor flow:
1. Build monitor via `createSafetyMonitor(config?)`.
2. Optionally attach to `DzupEventBus`; current subscriptions are `tool:error` and `memory:written`.
3. `scanContent` evaluates built-in/custom rules and records violations.
4. For each violation, monitor emits `safety:violation`; then emits `safety:blocked` for `block` actions or `safety:kill_requested` for `kill` actions.

Memory defense flow:
1. Call `createMemoryDefense().scan(content, metadata?)`.
2. Module checks mixed-script/homoglyph patterns, base64/hex encoded payloads, and approximate fact-count limit.
3. Returns `{ allowed, threats, normalizedContent? }` for caller-side allow/quarantine/reject decisions.

Internal skill-write guard flow:
1. `SkillManager` (`src/skills/skill-manager.ts`) runs `scanContent` from `security/content-sanitizer.ts` before create/edit/patch writes.
2. Unsafe content short-circuits with security-scan failure.

## Key APIs and Types
Risk classification:
- `createRiskClassifier(config?)`
- `RiskTier`, `RiskClassification`, `RiskClassifierConfig`, `RiskClassifier`
- `DEFAULT_AUTO_APPROVE_TOOLS`, `DEFAULT_LOG_TOOLS`, `DEFAULT_REQUIRE_APPROVAL_TOOLS`

Outbound URL policy:
- `validateOutboundUrl(url, policy?)`
- `validateOutboundUrlSyntax(url, policy?)`
- `fetchWithOutboundUrlPolicy(url, init?, options?)`
- `isPublicIpAddress(address)`
- `OutboundUrlSecurityPolicy`

Secrets and PII:
- `scanForSecrets(content)`, `redactSecrets(content)`
- `detectPII(content)`, `redactPII(content)`
- `SecretMatch`, `ScanResult`, `PIIType`, `PIIMatch`, `PIIDetectionResult`

Output sanitization:
- `OutputPipeline`, `createDefaultPipeline(config?)`
- `SanitizationStage`, `OutputPipelineConfig`, `PipelineResult`

Policy subsystem:
- `InMemoryPolicyStore`
- `PolicyEvaluator` (`evaluate`, `validate`)
- `PolicyTranslator` (`translate`, `explain`)
- `PolicySet`, `PolicyRule`, `PolicyContext`, `PolicyDecision`, `PolicyCondition`, `ConditionOperator`, `PolicyTranslationResult`

Audit subsystem:
- `ComplianceAuditStore` interface
- `InMemoryAuditStore`
- `ComplianceAuditLogger`
- `ComplianceAuditEntry`, `AuditFilter`, `AuditRetentionPolicy`, `IntegrityCheckResult`, `AuditLoggerConfig`

Safety monitoring:
- `createSafetyMonitor(config?)`
- `getBuiltInRules()`
- `SafetyMonitor`, `SafetyRule`, `SafetyViolation`, `SafetyCategory`, `SafetySeverity`, `SafetyAction`

Memory defense:
- `createMemoryDefense(config?)`
- `MemoryDefense`, `MemoryDefenseConfig`, `MemoryDefenseResult`, `MemoryThreat`, `MemoryThreatAction`, `EncodedContentMatch`

Enhanced output + classification:
- `createHarmfulContentFilter(categories?)`
- `createClassificationAwareRedactor(level?)`
- `DataClassifier`, `DEFAULT_CLASSIFICATION_PATTERNS`
- `ClassificationLevel`, `DataClassificationTag`, `ClassificationPattern`, `ClassificationConfig`

Internal-only security helper in this folder:
- `scanContent(content)`, `stripInvisibleUnicode(content)` from `content-sanitizer.ts`.

## Dependencies
Direct dependencies used by files in `src/security` are intentionally minimal.

Internal package dependencies:
- `../../events/event-bus.js` (`DzupEventBus`) used by audit logger and safety monitor.
- `../../errors/forge-error.js` (`ForgeError`) used by `PolicyTranslator`.
- Cross-module security imports (for example `output-pipeline` using `secrets-scanner` and `pii-detector`).

Platform APIs:
- `performance.now()` in `PolicyEvaluator` for microsecond timing.
- `Buffer` in memory-defense encoded-content detection.
- `Date`, `Math.random`, and `RegExp` across scanner/evaluator/logger implementations.

Package-level dependencies in `packages/core/package.json` remain workspace-level (`@dzupagent/agent-types`, `@dzupagent/runtime-contracts`), but the security subtree itself does not import third-party runtime libraries directly in current code.

## Integration Points
Public surfaces:
- `@dzupagent/core/security` (`./security` subpath export to facade build output).
- Root exports from `@dzupagent/core` (`src/index.ts` re-exports security APIs).
- Namespaced facade export via `@dzupagent/core/facades` (`security` namespace).

Event integration:
- `ComplianceAuditLogger` maps and records specific bus events including:
- `policy:evaluated`, `policy:denied`, `policy:set_updated`
- `safety:violation`, `safety:blocked`, `safety:kill_requested`
- `memory:threat_detected`, `memory:quarantined`
- `agent:started`, `agent:completed`, `agent:failed`
- `tool:called`, `tool:error`
- `llm:invoked`

Cross-module integration inside `@dzupagent/core`:
- `skills/skill-manager.ts` uses `security/content-sanitizer.ts` prior to persisting skill files.
- Output filters from `security/output/*` plug into `OutputPipeline` as sanitization stages.
- Classification output can be used by callers to pick stricter output redaction behavior.

## Testing and Observability
Security module tests are concentrated in `packages/core/src/__tests__` and include:
- `risk-classifier.test.ts`, `security-risk-classifier.test.ts`
- `secrets-scanner.test.ts`, `secrets-scanner-deep.test.ts`
- `pii-detector.test.ts`, `pii-detector-deep.test.ts`, `security-pii-detector.test.ts`
- `output-pipeline.test.ts`
- `policy-engine.test.ts`, `security-policy-engine.test.ts`
- `compliance-audit.test.ts`
- `security-monitor.test.ts`
- `data-classification.test.ts`
- `facade-security.test.ts`
- regression bundle coverage in `w15-b2-security.test.ts`

Observability model:
- Event-driven: `SafetyMonitor` emits safety events; `ComplianceAuditLogger` turns selected runtime events into persisted audit entries.
- Audit integrity: `ComplianceAuditStore.verifyIntegrity()` provides chain verification hooks.
- No dedicated metrics collector is implemented directly in `src/security`; metrics are expected to be provided by higher-level observability modules.

## Risks and TODOs
Current risks and open improvement targets visible from implementation:
- `InMemoryAuditStore` uses a djb2-style hash variant rather than cryptographic hashing/signing; suitable for development, weak for high-assurance compliance scenarios.
- `InMemoryPolicyStore.get()` returns last inserted version, not explicitly max numeric version when version history is inserted out of order.
- `PolicyTranslator.translate()` validates JSON shape only at a shallow level (`rule` presence) and does not run full schema validation on generated rules.
- `SafetyMonitor.attach()` subscribes only to `tool:error` and `memory:written`; broader scanning requires explicit `scanContent` calls by consumers.
- `createDefaultPipeline({ customDenyList })` compiles deny-list patterns with `new RegExp`; invalid patterns throw during pipeline construction.
- Classification level vocabularies are not fully unified:
- `DataClassifier` supports `public | internal | confidential | restricted`.
- `createClassificationAwareRedactor` additionally recognizes `top_secret`.
- `content-sanitizer.ts` is security-relevant but not exported through security barrels, so external consumers cannot rely on it as a public API contract.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
