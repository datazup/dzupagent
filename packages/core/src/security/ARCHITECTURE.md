# Security Architecture (`packages/core/src/security`)

## Scope
This document describes the security subsystem implemented under `packages/core/src/security` in `@dzupagent/core`.

In scope:
- top-level security modules: `index.ts`, `risk-classifier.ts`, `tool-permission-tiers.ts`, `secrets-scanner.ts`, `pii-detector.ts`, `output-pipeline.ts`, `outbound-url-policy.ts`, `content-sanitizer.ts`
- grouped modules: `audit/*`, `policy/*`, `monitor/*`, `memory/*`, `output/*`, `classification/*`
- export wiring and reachability through `src/facades/security.ts` and `src/index.ts`

Checked integration call sites in `packages/core`:
- `src/mcp/mcp-client.ts` (outbound URL policy)
- `src/skills/skill-manager.ts` (content sanitizer before skill writes)

## Responsibilities
The subsystem provides reusable security primitives for runtime governance and content safety:

- tool risk tiering for operation gating (`auto`, `log`, `require-approval`)
- secrets and PII detection/redaction for arbitrary text payloads
- staged output sanitization pipelines with configurable redaction and truncation
- outbound URL validation and secure fetch wrapper with redirect re-validation
- policy evaluation (enforcement), policy translation (authoring helper), and policy version storage
- tamper-evident-style compliance audit logging with chain verification and query/export APIs
- safety monitoring with built-in rules plus host-provided rule/scanner overrides
- memory poisoning heuristics for mixed scripts, encoded payloads, and bulk fact writes
- data classification based on sensitivity patterns
- internal content scanning helper (`content-sanitizer.ts`) used by write paths outside the public security facade

## Structure
| Path | Role | Main exports |
| --- | --- | --- |
| `src/security/index.ts` | Security barrel used by root exports | Re-exports risk/scanners/pipeline/policy/audit/monitor/memory/output/classification |
| `src/security/risk-classifier.ts` | Tool risk classifier | `createRiskClassifier`, `RiskTier`, `RiskClassifier` |
| `src/security/tool-permission-tiers.ts` | Default tool-tier lists | `DEFAULT_AUTO_APPROVE_TOOLS`, `DEFAULT_LOG_TOOLS`, `DEFAULT_REQUIRE_APPROVAL_TOOLS` |
| `src/security/secrets-scanner.ts` | Regex + entropy secret scan/redaction | `scanForSecrets`, `redactSecrets`, `SecretMatch`, `ScanResult` |
| `src/security/pii-detector.ts` | Adapter over `@dzupagent/security` PII scanner | `detectPII`, `redactPII`, `PIIType`, `PIIDetectionResult` |
| `src/security/output-pipeline.ts` | Ordered sanitization stage runner | `OutputPipeline`, `createDefaultPipeline`, pipeline types |
| `src/security/outbound-url-policy.ts` | SSRF-focused URL validation + secure fetch | `validateOutboundUrlSyntax`, `validateOutboundUrl`, `fetchWithOutboundUrlPolicy`, `isPublicIpAddress` |
| `src/security/content-sanitizer.ts` | Internal threat scan for persisted content | `scanContent`, `stripInvisibleUnicode` |
| `src/security/policy/*` | Policy model, evaluator, translator, in-memory store | `InMemoryPolicyStore`, `PolicyEvaluator`, `PolicyTranslator`, policy types |
| `src/security/audit/*` | Audit model, store contract, in-memory store, logger | `InMemoryAuditStore`, `ComplianceAuditLogger`, audit types |
| `src/security/monitor/*` | Built-in safety rules + monitor runtime | `createSafetyMonitor`, `getBuiltInRules`, safety types |
| `src/security/memory/*` | Memory poisoning defense | `createMemoryDefense`, defense types |
| `src/security/output/*` | Additional output filter stages | `createHarmfulContentFilter`, `createClassificationAwareRedactor` |
| `src/security/classification/*` | Sensitivity classification model + defaults | `DataClassifier`, `DEFAULT_CLASSIFICATION_PATTERNS`, classification types |

## Runtime and Control Flow
Risk classifier flow:
1. `createRiskClassifier(config)` builds lookup sets from config or default tier arrays.
2. `classify(toolName, args)` checks `require-approval`, then `log`, then `auto`.
3. For unclassified names, optional `customClassifier` can override.
4. Final fallback is `defaultTier` (default `'log'`).

Secrets scanner flow:
1. `scanForSecrets(content)` runs curated regex patterns (provider tokens, keys, connection strings, JWT, private key, generic assignments).
2. It then runs entropy checks on assignment-like quoted values (`>20` chars and entropy `>4.5`).
3. It builds redactions from end-to-start offsets and returns `{ hasSecrets, matches, redacted }`.

PII detector flow:
1. `detectPII(content)` delegates to `PiiDetector.scanDetailed()` from `@dzupagent/security`.
2. It narrows matches to core-supported canonical types: `email`, `phone`, `ssn`, `credit-card`, `ip-address`.
3. It generates redacted content using `[REDACTED:<type>]` markers.

Output pipeline flow:
1. `OutputPipeline.process()` runs enabled stages in declared order.
2. It tracks `appliedStages` only when stage output differs from previous content.
3. It enforces `maxOutputLength` (default `100_000`) and appends `[TRUNCATED]` when exceeded.
4. `createDefaultPipeline()` wires PII redaction, secrets redaction, and optional deny-list replacement stage.
5. `output/output-filter-enhanced.ts` provides optional stages for harmful-content replacement and level-based extra redaction.

Outbound URL policy flow:
1. `validateOutboundUrlSyntax(url, policy)` parses URL, enforces protocol, blocks local/metadata hosts, and rejects non-public literal IPs unless allowlisted.
2. `validateOutboundUrl(url, policy)` optionally performs DNS resolution (`lookup`) and rejects hostnames that resolve to non-public addresses unless IP-allowlisted.
3. `fetchWithOutboundUrlPolicy(url, init, options)` validates each request URL and each redirect hop (`redirect: 'manual'`) with abort checks and redirect cap (default `5`).

Policy flow:
1. `PolicyEvaluator.evaluate(policySet, context)` sorts rules by `priority` descending.
2. It matches principal, action/resource glob rules, condition operators, and expiration windows.
3. Decision semantics are deny-overrides with default deny on no match.
4. `PolicyEvaluator.validate()` performs structural checks (required fields, duplicate IDs, date validity, condition shape).
5. `PolicyTranslator` is separate from enforcement and only handles NL-to-rule JSON translation plus human explanation.

Safety monitor flow:
1. `createSafetyMonitor(config)` builds rules from built-ins unless `replaceBuiltInRules` is set.
2. Built-ins include prompt injection, PII leak, secret leak, tool abuse, and escalation.
3. Optional `SecurityPolicyConfig` can disable/downgrade prompt injection, PII, and escalation handling; tool abuse threshold reads from `policy.toolAbuse.maxCallsPerTool`.
4. `scanContent()` executes rules defensively; rule failures are swallowed.
5. Violations are always emitted as `safety:violation`.
6. Violations with action `block` also emit `safety:blocked`.
7. Violations with action `kill` also emit `safety:kill_requested`.
8. `attach(eventBus)` subscribes to `tool:error` and `memory:written` and feeds those payloads through `scanContent`.

Audit flow:
1. `ComplianceAuditLogger.attach(eventBus)` subscribes to all events via `onAny`.
2. A fixed event-type map determines which events become audit entries.
3. Tool event details are sanitized before persistence (`tool:called` strips `input`, `tool:result` strips `output`).
4. `InMemoryAuditStore.append()` assigns monotonic `seq`, links `previousHash`, computes hash, and stores entry.
5. `verifyIntegrity()` recomputes chain links/hashes and reports the first break if present.

Memory defense flow:
1. `createMemoryDefense(config).scan(content)` optionally runs homoglyph normalization checks and records mixed-script threats.
2. It optionally detects long base64/hex payloads and decodes when printable.
3. It counts statement-like segments and flags over-limit writes (`maxFactsPerWrite`, default `10`).
4. Any `quarantine` or `reject` threat results in `allowed: false`.

## Key APIs and Types
Risk and tool gating:
- `createRiskClassifier`
- `RiskTier`, `RiskClassification`, `RiskClassifierConfig`, `RiskClassifier`
- `DEFAULT_AUTO_APPROVE_TOOLS`, `DEFAULT_LOG_TOOLS`, `DEFAULT_REQUIRE_APPROVAL_TOOLS`

Secret and PII scanning:
- `scanForSecrets`, `redactSecrets`
- `SecretMatch`, `ScanResult`
- `detectPII`, `redactPII`
- `PIIType`, `PIIMatch`, `PIIDetectionResult`

Output safety:
- `OutputPipeline`, `createDefaultPipeline`
- `SanitizationStage`, `OutputPipelineConfig`, `PipelineResult`
- `createHarmfulContentFilter`, `createClassificationAwareRedactor`, `HarmfulContentCategory`

Outbound network controls:
- `validateOutboundUrlSyntax`, `validateOutboundUrl`, `fetchWithOutboundUrlPolicy`, `isPublicIpAddress`
- `OutboundUrlSecurityPolicy`, `OutboundUrlResolvedAddress`, `OutboundUrlPolicyResult`, `SecureFetchOptions`

Policy system:
- `InMemoryPolicyStore`, `PolicyEvaluator`, `PolicyTranslator`
- `PolicySet`, `PolicyRule`, `PolicyContext`, `PolicyDecision`, `PolicyStore`
- `PolicyTranslatorConfig`, `PolicyTranslationResult`

Audit system:
- `InMemoryAuditStore`, `ComplianceAuditLogger`
- `ComplianceAuditStore`
- `ComplianceAuditEntry`, `AuditFilter`, `AuditRetentionPolicy`, `IntegrityCheckResult`, `AuditActor`, `AuditResult`

Safety monitor and memory defense:
- `createSafetyMonitor`, `getBuiltInRules`
- `SafetyMonitor`, `SafetyMonitorConfig`, `SafetyRule`, `SafetyViolation`
- `SafetyCategory`, `SafetySeverity`, `SafetyAction`
- `InjectionScannerCallback`, `PiiScannerCallback`
- `createMemoryDefense`
- `MemoryDefense`, `MemoryDefenseConfig`, `MemoryDefenseResult`, `MemoryThreat`, `MemoryThreatAction`, `EncodedContentMatch`

Classification:
- `DataClassifier`, `DEFAULT_CLASSIFICATION_PATTERNS`
- `ClassificationLevel`, `DataClassificationTag`, `ClassificationPattern`, `ClassificationConfig`

## Dependencies
Direct package dependency used by this subsystem:
- `@dzupagent/security` for `PiiDetector`, `PromptInjectionDetector`, and shared `SecurityPolicyConfig` type

Node built-ins used directly in security modules:
- `node:dns/promises` (`lookup`) for DNS checks in outbound policy
- `node:net` (`isIP`) for IP family parsing in outbound policy

Internal `@dzupagent/core` dependencies:
- `../../events/event-bus.js` consumed by monitor and audit logger
- `../../errors/forge-error.js` used by `PolicyTranslator` for recoverable invalid-response errors
- cross-module composition within `src/security` (`output-pipeline` uses secret/PII scanners, monitor/policy/audit/memory/classification are layered modules)

Package exposure context (`packages/core/package.json`):
- published facade entrypoint: `@dzupagent/core/security` via `./security` export (`dist/facades/security.*`)
- root entrypoint `@dzupagent/core` also re-exports security APIs from `src/index.ts`

## Integration Points
Public integration:
- `src/facades/security.ts` is the curated import surface for `@dzupagent/core/security`
- `src/index.ts` re-exports the same security primitives for root imports

Internal runtime integrations in `packages/core`:
- `src/mcp/mcp-client.ts` uses `fetchWithOutboundUrlPolicy` for `tools/list` and `tools/call` HTTP/SSE requests, including redirect-safe outbound execution
- `src/skills/skill-manager.ts` uses `scanContent` from `content-sanitizer.ts` before create/edit/patch writes to `SKILL.md`

Event integrations:
- `SafetyMonitor` emits `safety:violation`, `safety:blocked`, and `safety:kill_requested`
- `ComplianceAuditLogger` observes global event traffic via `eventBus.onAny` and records selected security-relevant actions

Boundary note:
- `content-sanitizer.ts` is intentionally internal and not exported from `src/security/index.ts` or the security facade

## Testing and Observability
Security-focused tests under `packages/core/src/__tests__` include:
- `facade-security.test.ts`
- `risk-classifier.test.ts`
- `security-risk-classifier.test.ts`
- `secrets-scanner.test.ts`
- `secrets-scanner-deep.test.ts`
- `pii-detector.test.ts`
- `pii-detector-deep.test.ts`
- `security-pii-detector.test.ts`
- `policy-engine.test.ts`
- `security-policy-engine.test.ts`
- `compliance-audit.test.ts`
- `llm-audit-event.test.ts`
- `security-monitor.test.ts`
- `safety-monitor-delegation.test.ts`
- `outbound-url-policy.test.ts`
- `output-pipeline.test.ts`
- `data-classification.test.ts`
- `w15-b2-security.test.ts`
- `mcp-security.test.ts` (adjacent MCP security helpers and integration assumptions)

Operational observability implemented in code:
- monitor and audit paths are event-bus integrated
- monitor rule exceptions and audit auto-record failures are intentionally non-fatal
- policy evaluation returns per-call timing (`evaluationTimeUs`)
- audit chain can be integrity-checked via `verifyIntegrity()`

## Risks and TODOs
- `InMemoryAuditStore` uses a custom synchronous hash function (djb2 variant), not cryptographic hashing
- `in-memory-audit-store.ts` header comment references SHA-256 while implementation is custom hash chaining
- `PolicyTranslator` trusts model output shape after JSON parse with limited semantic validation
- regex and heuristic detectors can produce false positives/false negatives (`secrets-scanner`, `content-sanitizer`, `memory-defense`, enhanced output filters, classification patterns)
- `MemoryDefense` fact counting is sentence/newline heuristic and can mis-estimate dense or highly structured text
- `SafetyMonitor` violation history is in-memory only (no persistence/aggregation in this module)
- outbound URL safety depends on correct allowlists (`allowedHosts`, `allowedIpAddresses`) and DNS behavior in deployment

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js