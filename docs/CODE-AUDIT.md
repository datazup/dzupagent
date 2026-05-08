# Code Quality Audit - Adapter Rules, Provider Projection, Monitor, Observability, CLI Conformance

## Findings

### DOMAIN-001 - High - OpenAI/OpenRouter are marked policy-projectable but adapter-rules projects no provider config

Status: Resolved

**Impact:** Rules with provider-level effects can appear active for `openai` and `openrouter` while producing no native provider configuration. This is a real maintainability and behavior risk because the provider catalog advertises support, the rule compiler accumulates `auditFlags`, and the projector dispatch silently returns `{}` instead of exposing an unsupported-provider violation.

**Original evidence:**
- `packages/agent-adapters/src/provider-catalog.ts:104` through `packages/agent-adapters/src/provider-catalog.ts:120` marks both `openrouter` and `openai` with `supportsPolicyProjection: true`.
- `packages/adapter-rules/src/projectors/index.ts:28` through `packages/adapter-rules/src/projectors/index.ts:36` registers projectors only for Claude, Codex, Gemini/Gemini SDK, Qwen, Goose, and Crush.
- `packages/adapter-rules/src/projectors/index.ts:42` through `packages/adapter-rules/src/projectors/index.ts:44` returns `{}` when no projector is registered.
- `packages/adapter-rules/src/__tests__/projectors.test.ts:303` through `packages/adapter-rules/src/__tests__/projectors.test.ts:309` codifies the empty-patch behavior for `openrouter` even when `auditFlags: ['approval:bash']` is present. I found no equivalent OpenAI projector coverage in `packages/adapter-rules/src`.

**Remediation:** Make the provider capability source authoritative across `agent-adapters` and `adapter-rules`. Either add explicit OpenAI/OpenRouter projectors and conformance tests for approval/path/watch effects, or mark policy projection unsupported and make `projectProviderConfig()` return a typed warning/error object instead of a silent empty patch for known-but-unprojectable providers.

**Resolved evidence:** `PROVIDER_CATALOG` now documents `supportsPolicyProjection` as native/provider-config projection support and marks API-only `openai` and `openrouter` as unsupported for that capability. `packages/agent-adapters/src/__tests__/request-schemas.test.ts` guards that OpenAI/OpenRouter remain product/HTTP routable without advertising native policy projection, and `packages/adapter-rules/src/__tests__/projectors.test.ts` covers both API-only providers returning an empty provider config patch until real projectors exist.

### DOMAIN-002 - High - Approval support semantics disagree between adapter-rules projection and policy conformance

Status: Resolved

**Impact:** The repo has two current sources of truth for provider approval support. `adapter-rules` projects native approval config for Gemini, Qwen, Goose, and Crush, while `PolicyConformanceChecker` says those providers do not support approval. Callers can receive contradictory guidance depending on whether they enter through canonical rules or policy compilation, which makes best-practice conformance hard to trust.

**Original evidence:**
- `packages/adapter-rules/src/projectors/gemini.ts:26` through `packages/adapter-rules/src/projectors/gemini.ts:38` projects approval flags into `trust_tools: false` and `tool_config.require_confirmation`.
- `packages/adapter-rules/src/projectors/qwen.ts:29` through `packages/adapter-rules/src/projectors/qwen.ts:32` projects approval flags into `approval_mode: 'require'`.
- `packages/adapter-rules/src/projectors/goose.ts:41` through `packages/adapter-rules/src/projectors/goose.ts:44` projects approval flags into `goose.mode: 'approve'`.
- `packages/adapter-rules/src/projectors/crush.ts:26` through `packages/adapter-rules/src/projectors/crush.ts:29` projects approval flags into `permissionMode: 'ask'`.
- `packages/agent-adapters/src/policy/policy-conformance.ts:84` through `packages/agent-adapters/src/policy/policy-conformance.ts:132` sets `supportsApproval: false` for Gemini, Gemini SDK, Qwen, Crush, and Goose.
- `packages/agent-adapters/src/policy/policy-conformance.ts:206` through `packages/agent-adapters/src/policy/policy-conformance.ts:212` then warns that `approvalRequired` is not natively supported for those providers.

**Remediation:** Split capability semantics into one shared typed matrix that distinguishes native provider approvals, CLI config best-effort approvals, and host/orchestrator approval gates. Have both `adapter-rules` projectors and `PolicyConformanceChecker` consume that matrix, then add conformance tests asserting every provider has one agreed approval tier.

**Resolved evidence:** `PROVIDER_CATALOG` now exposes an `approvalSupport` tier with `native`, `provider-config`, and `host-gated` states. `PolicyConformanceChecker` consumes that tier and distinguishes direct AdapterPolicy approval support from adapter-rules provider-config approval projection in its warnings. Regression coverage in `packages/agent-adapters/src/__tests__/policy-compiler-conformance.test.ts` asserts provider-config warnings for Gemini/Gemini SDK/Qwen/Crush/Goose, host-gated warnings for OpenAI/OpenRouter, and no warning for native Claude/Codex approval.

### DOMAIN-003 - Medium - RuleLoader validates only the outer shape and lets invalid rule semantics reach the compiler

Status: Resolved

**Impact:** JSON rule files can pass loader validation with invalid scopes, provider IDs, match shapes, and effect payloads. The compiler then trusts the static `AdapterRule` type and can push `undefined` prompt sections, malformed watch paths, or unrecognized providers into runtime plans. This is type-unsafety at the untyped filesystem boundary, not a style issue.

**Evidence:**
- `packages/adapter-rules/src/loader.ts:86` through `packages/adapter-rules/src/loader.ts:102` validates only required field presence, string `id/name/scope`, string-array `appliesToProviders`, and array `effects`.
- `packages/adapter-rules/src/loader.ts:105` through `packages/adapter-rules/src/loader.ts:109` accepts any effect object whose `kind` is a string; it does not validate the discriminated union fields from `packages/adapter-rules/src/types.ts:30` through `packages/adapter-rules/src/types.ts:37`.
- `packages/adapter-rules/src/compiler.ts:87` through `packages/adapter-rules/src/compiler.ts:118` switches on `effect.kind` and then reads fields such as `effect.content`, `effect.path`, `effect.artifactKind`, and `effect.target` as if loader validation had made them safe.
- `packages/adapter-rules/src/__tests__/loader.test.ts:58` through `packages/adapter-rules/src/__tests__/loader.test.ts:66` covers missing required fields, but there is no negative test for invalid effect payloads, invalid scope values, invalid provider IDs, or malformed match arrays.

**Remediation:** Add a runtime schema or explicit type guards for `AdapterRule`, `RuleMatch`, and every `RuleEffect` variant. Return structured load diagnostics instead of only `console.warn`, and add loader tests for every invalid semantic shape that the compiler currently assumes is impossible.

**Resolved evidence:** `RuleLoader` now applies explicit runtime guards for `AdapterRule`, `RuleMatch`, and each `RuleEffect` variant. It rejects invalid scopes, unsupported providers, malformed match arrays, unknown effect kinds, and missing/invalid effect payload fields before values reach `RuleCompiler`. Regression coverage in `packages/adapter-rules/src/__tests__/loader.test.ts` exercises all of those invalid shapes.

### DOMAIN-004 - Medium - Universal provider rules do not expand into provider watcher registrations

Status: Resolved

**Impact:** `appliesToProviders: ['*']` works for rule matching, but the watcher projector iterates the literal provider list and has no `'*'` expansion. A universal rule therefore becomes active in the runtime plan while only the always-on `.dzupagent/` watcher is registered, so provider-local config/artifact changes can be missed by monitor consumers.

**Evidence:**
- `packages/adapter-rules/src/compiler.ts:50` through `packages/adapter-rules/src/compiler.ts:54` treats `'*'` as matching every current provider.
- `packages/adapter-rules/src/compiler.ts:41` through `packages/adapter-rules/src/compiler.ts:42` builds watcher registrations from the active rules after compilation.
- `packages/adapter-rules/src/projectors/watchers.ts:86` through `packages/adapter-rules/src/projectors/watchers.ts:90` loops `rule.appliesToProviders`, looks up each literal key in `PROVIDER_WATCHERS`, and skips undefined keys.
- `packages/adapter-rules/src/projectors/watchers.ts:29` through `packages/adapter-rules/src/projectors/watchers.ts:58` has no `'*'` key.
- `packages/adapter-rules/src/__tests__/projectors-watchers.test.ts:25` through `packages/adapter-rules/src/__tests__/projectors-watchers.test.ts:161` covers empty, provider-specific, multiple-provider, and unknown-provider rules, but not the universal-provider case.

**Remediation:** Expand `'*'` to either the current `context.providerId` or the full provider set before watcher projection, depending on whether registrations are meant to be run-local or multi-provider. Add a watcher test for a universal rule and make the intended behavior explicit in `WatcherRegistration` docs.

**Resolved evidence:** `buildWatcherRegistrations()` now expands `'*'` to the current compile provider and deduplicates repeated wildcard/explicit provider paths. Regression coverage in `packages/adapter-rules/src/__tests__/projectors-watchers.test.ts` proves a universal rule compiled for `codex` emits Codex project and home watcher registrations.

### DOMAIN-005 - Medium - Monitor/watch projection has two disconnected hardcoded provider path maps

Status: Resolved

**Impact:** The monitor path model can drift because `adapter-rules` emits `watcherRegistrations`, while the CLI runtime starts artifact watchers from a separate `PROVIDER_WATCH_SPECS` table. `watch_path` effects and rule-derived watcher registrations are not consumed by `BaseCliAdapter`, so changing rules can update the plan without changing what the CLI adapter actually watches.

**Evidence:**
- `packages/adapter-rules/src/compiler.ts:93` through `packages/adapter-rules/src/compiler.ts:96` projects `watch_path` effects into `watchPaths` and `monitorSubscriptions`.
- `packages/adapter-rules/src/compiler.ts:41` through `packages/adapter-rules/src/compiler.ts:42` also adds `watcherRegistrations` using the adapter-rules watcher projector.
- `packages/agent-adapters/src/base/base-cli-adapter.ts:77` through `packages/agent-adapters/src/base/base-cli-adapter.ts:84` defines a separate `PROVIDER_WATCH_SPECS` map.
- `packages/agent-adapters/src/base/base-cli-adapter.ts:362` through `packages/agent-adapters/src/base/base-cli-adapter.ts:369` starts the artifact watcher only from that hardcoded map, independent of a compiled `RuntimePlan`.
- `packages/adapter-rules/src/projectors/watchers.ts:29` through `packages/adapter-rules/src/projectors/watchers.ts:58` duplicates much of the same provider path knowledge in another package.

**Remediation:** Move provider watch-path metadata into one shared contract package or exported adapter-rules helper, and pass compiled watcher registrations into the CLI execution path when rules are active. Keep the hardcoded fallback only for legacy no-rules runs, and add a cross-package test that a `watch_path` rule changes the actual watcher factory input.

**Resolved evidence:** `@dzupagent/agent-adapters` now exposes a `./rules` subpath with `withAdapterRuleRuntimePlan()`, `projectAdapterRuleRuntimePlan()`, `getAdapterRuleRuntimePlan()`, and watcher path resolution helpers for compiled `@dzupagent/adapter-rules` plans. `BaseCliAdapter.execute()` consumes an attached `RuntimePlan` and merges both `watcherRegistrations` and `watchPaths` into the artifact watcher factory input. Default no-rules watcher startup now uses `buildDefaultWatcherRegistrations()` exported by `@dzupagent/adapter-rules`, so provider-local default watch paths no longer live in a second `PROVIDER_WATCH_SPECS` table inside `agent-adapters`. The same helper surface preserves provider config patches, audit flags, denied paths, alerts, and monitor subscriptions in adapter-facing options, with direct mappings for Codex approval policy, Claude provider options, and Goose permission mode where the current adapters already consume those shapes. Regression coverage in `packages/agent-adapters/src/__tests__/base-cli-adapter-artifact-watcher.test.ts` compiles a real `AdapterRule` with `RuleCompiler` and asserts the watcher factory sees `.dzupagent`, provider-local, and rule-specific artifact paths; `packages/agent-adapters/src/__tests__/rule-runtime-plan.test.ts` covers the projection behavior; `packages/adapter-rules/src/__tests__/projectors-watchers.test.ts` covers default watcher registration without active rules.

### DOMAIN-006 - Medium - Trace propagation is implemented but not wired into CLI execution

Status: Resolved

**Impact:** `AdapterTracer` exposes W3C `TRACEPARENT` propagation and comments say trace context is propagated to child processes by default, but CLI execution never calls `buildPropagationEnv()`. Operators can enable tracing and still get child processes without trace context, which is a fragile observability invariant and a misleading API contract.

**Evidence:**
- `packages/agent-adapters/src/observability/adapter-tracer.ts:7` through `packages/agent-adapters/src/observability/adapter-tracer.ts:8` documents propagation to adapter child processes when `propagateContext` is enabled.
- `packages/agent-adapters/src/observability/adapter-tracer.ts:293` through `packages/agent-adapters/src/observability/adapter-tracer.ts:302` builds a `TRACEPARENT` env patch.
- `packages/agent-adapters/src/observability/tracing-middleware.ts:24` through `packages/agent-adapters/src/observability/tracing-middleware.ts:29` creates a root span but only observes the event stream.
- `packages/agent-adapters/src/base/base-cli-adapter.ts:376` through `packages/agent-adapters/src/base/base-cli-adapter.ts:389` builds spawn args/env before calling `spawnAndStreamJsonl`, but the env comes only from `this.buildEnv()`.
- `packages/agent-adapters/src/base/base-cli-adapter.ts:664` through `packages/agent-adapters/src/base/base-cli-adapter.ts:672` filters `process.env` and merges `this.config.env`; it has no trace context input.

**Remediation:** Decide whether propagation belongs in middleware, `AgentInput.options`, or `AdapterConfig.env`. Then wire `TRACEPARENT` into `BaseCliAdapter` spawn env and add a focused test asserting traced CLI execution passes the env var to `spawnAndStreamJsonl`. If propagation is intentionally not supported for this path, remove or narrow the public comment.

**Resolved evidence:** `AdapterTracer` now exposes the `ADAPTER_TRACE_ENV_OPTION` option key and `createTracingMiddleware()` attaches `buildPropagationEnv()` output to the shared `AgentInput.options` before adapter execution begins. `BaseCliAdapter.execute()` now builds spawn env through `buildSpawnEnv(input)`, which merges the per-run trace env into the child process environment. Regression coverage in `packages/agent-adapters/src/__tests__/tracing-middleware.test.ts` asserts that middleware attaches a W3C `TRACEPARENT`, and `packages/agent-adapters/src/__tests__/base-cli-adapter-artifact-watcher.test.ts` asserts the spawned CLI process receives it.

### DOMAIN-007 - Medium - Tool spans are keyed only by tool name, so repeated in-flight calls overwrite each other

Status: Resolved

**Impact:** Observability loses span fidelity when the same tool is called more than once before corresponding results arrive. The second `adapter:tool_call` with the same `toolName` overwrites the first open span, and the first result can close the wrong span or leave a span unrecorded. This is a correctness issue in monitor data, not formatting noise.

**Evidence:**
- `packages/agent-adapters/src/observability/adapter-tracer.ts:101` through `packages/agent-adapters/src/observability/adapter-tracer.ts:124` stores open tool spans in `Map<string, TraceSpan>` keyed by `event.toolName`.
- `packages/agent-adapters/src/observability/adapter-tracer.ts:128` through `packages/agent-adapters/src/observability/adapter-tracer.ts:134` closes spans by looking up the same `toolName`.
- `packages/agent-adapters/src/observability/tracing-middleware.ts:31` through `packages/agent-adapters/src/observability/tracing-middleware.ts:59` repeats the same keying strategy in the middleware.
- Existing tests in `packages/agent-adapters/src/__tests__/adapter-tracer.test.ts:80` through `packages/agent-adapters/src/__tests__/adapter-tracer.test.ts:132` and `packages/agent-adapters/src/__tests__/tracing-middleware.test.ts:55` through `packages/agent-adapters/src/__tests__/tracing-middleware.test.ts:79` cover only one in-flight call per tool name.

**Remediation:** Key spans by a stable tool-call ID when the event provides one; otherwise store a FIFO queue per tool name and close the oldest open span on each result. Add tests for two interleaved calls with the same `toolName`, both in `AdapterTracer` and `createTracingMiddleware`.

**Resolved evidence:** `AdapterTracer` and `createTracingMiddleware()` now share `ToolSpanTracker`, which indexes spans by provider-supplied call IDs when present and otherwise keeps a FIFO queue per `toolName`. Tool spans now also record `tool.call_id` when a stable call ID is present. Regression coverage in `packages/agent-adapters/src/__tests__/adapter-tracer.test.ts` and `packages/agent-adapters/src/__tests__/tracing-middleware.test.ts` covers concurrent same-name tool calls for both FIFO fallback and explicit call IDs.

### DOMAIN-008 - Medium - BaseCliAdapter is a multi-responsibility hotspot for CLI execution, governance, monitor hooks, interactions, env policy, and health

**Impact:** `BaseCliAdapter` is the central path for CLI best-practice conformance, but it combines too many policies in one stateful class. Changes to env filtering, interaction approval, governance side-channel emission, artifact watcher lifecycle, process execution, and terminal event behavior all share the same method and mutable fields. That increases regression risk and makes focused testing harder as new CLI providers are added.

**Evidence:**
- `packages/agent-adapters/src/base/base-cli-adapter.ts:116` through `packages/agent-adapters/src/base/base-cli-adapter.ts:720` defines one class spanning current abort controller state, artifact watcher state, governance listeners, run context, interaction handling, hook detection, process spawning, health checks, env filtering, and provider mapping.
- `packages/agent-adapters/src/base/base-cli-adapter.ts:342` through `packages/agent-adapters/src/base/base-cli-adapter.ts:565` implements a long `execute()` generator that starts the run, watcher, abort composition, interaction resolver, governance event mirroring, provider hook detection, provider event mapping, terminal event synthesis, error normalization, rethrow policy, and cleanup.
- `packages/agent-adapters/src/base/base-cli-adapter.ts:457` through `packages/agent-adapters/src/base/base-cli-adapter.ts:514` embeds provider JSONL hook-shape heuristics directly inside the run loop.
- `packages/agent-adapters/src/base/base-cli-adapter.ts:664` through `packages/agent-adapters/src/base/base-cli-adapter.ts:672` also owns env construction, and appends `this.config.env` after filtering the inherited environment.

**Remediation:** Extract only stable seams: `CliRunLifecycle`, `GovernanceEventMirror`, `ProviderHookRecordDetector`, and `CliEnvBuilder`. Keep the public abstract adapter contract unchanged, and back each extraction with the existing artifact-watcher/env-filter/governance tests plus one end-to-end base adapter fixture.

## Finding Manifest

```json
{
  "domain": "code quality",
  "counts": { "critical": 0, "high": 0, "medium": 1, "low": 0, "info": 0, "resolved": 7 },
  "findings": [
    { "id": "DOMAIN-001", "severity": "high", "status": "resolved", "title": "OpenAI/OpenRouter are marked policy-projectable but adapter-rules projects no provider config", "file": "packages/agent-adapters/src/provider-catalog.ts" },
    { "id": "DOMAIN-002", "severity": "high", "status": "resolved", "title": "Approval support semantics disagree between adapter-rules projection and policy conformance", "file": "packages/agent-adapters/src/provider-catalog.ts" },
    { "id": "DOMAIN-003", "severity": "medium", "status": "resolved", "title": "RuleLoader validates only the outer shape and lets invalid rule semantics reach the compiler", "file": "packages/adapter-rules/src/loader.ts" },
    { "id": "DOMAIN-004", "severity": "medium", "status": "resolved", "title": "Universal provider rules do not expand into provider watcher registrations", "file": "packages/adapter-rules/src/projectors/watchers.ts" },
    { "id": "DOMAIN-005", "severity": "medium", "status": "resolved", "title": "Monitor/watch projection has two disconnected hardcoded provider path maps", "file": "packages/adapter-rules/src/projectors/watchers.ts" },
    { "id": "DOMAIN-006", "severity": "medium", "status": "resolved", "title": "Trace propagation is implemented but not wired into CLI execution", "file": "packages/agent-adapters/src/observability/adapter-tracer.ts" },
    { "id": "DOMAIN-007", "severity": "medium", "status": "resolved", "title": "Tool spans are keyed only by tool name, so repeated in-flight calls overwrite each other", "file": "packages/agent-adapters/src/observability/adapter-tracer.ts" },
    { "id": "DOMAIN-008", "severity": "medium", "title": "BaseCliAdapter is a multi-responsibility hotspot for CLI execution, governance, monitor hooks, interactions, env policy, and health", "file": "packages/agent-adapters/src/base/base-cli-adapter.ts" }
  ]
}
```

## Scope Reviewed

- Read first: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-packages-agent-adapters-adapter-rules-provider-config-projection-monitor-observability-cli-best-practice-conformance-2026-04-30/run-001/codex-prep/context/repo-snapshot.md`.
- Reviewed current source/config selectively under `packages/adapter-rules/src`, `packages/agent-adapters/src`, package manifests, and focused tests for projectors, watcher registrations, loader behavior, tracing, artifact watchers, env filtering, and request/provider catalog conformance.
- Weighted the audit toward `adapter-rules`, provider config projection, monitor/watch projection, observability, and CLI conformance as requested.
- Avoided generated/dependency/old-audit artifacts as evidence sources. The existing audit-pack `docs/CODE-AUDIT.md` was treated as a stale target file, not as baseline evidence.
- Static review only. I used file reads and `rg`/`nl` source inspection; I did not run `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test`, or package-focused Vitest commands during this audit.

## Strengths

- `adapter-rules` has focused tests for compiler matching, provider config dispatch, individual provider projectors, loader happy/error paths, and watcher registration basics.
- Provider projectors are pure functions and are kept separate per provider, which makes targeted fixes and conformance tests straightforward.
- `agent-adapters` already exposes a provider catalog and HTTP-routable provider list, which is the right shape for reducing scattered provider policy over time.
- CLI execution has meaningful tests around artifact watcher lifecycle and environment filtering.
- Observability has direct tests for tracing middleware, `AdapterTracer`, trace env propagation, same-name concurrent tool span tracking, span ending, usage capture, callback failure isolation, and event bus emission.
- The code generally avoids broad `any` in this focused slice; the main type-unsafety is at JSON rule loading and provider config patch shapes, not pervasive unchecked TypeScript.

## Open Questions Or Assumptions

- I treated `supportsPolicyProjection` in `provider-catalog.ts` as an authoritative advertised capability because it is exported from both the root and provider subpath.
- I assumed universal rules should produce useful provider watcher registrations. If the intended meaning is "active rule only, no provider watcher", that should be explicit in watcher docs and tests.
- I did not classify all source files without same-name tests as zero-test findings. In this focused slice, the remaining actionable code-quality risk is the `BaseCliAdapter` maintainability hotspot; the OpenAI/OpenRouter projector semantics, `'*'` watcher expansion, invalid rule payloads, trace env propagation, and duplicate tool-call spans have focused regression coverage.
- I treated `BaseCliAdapter` complexity as a maintainability risk because it concentrates multiple CLI governance and monitor invariants in one execution loop, not because of file length alone.

## Recommended Next Actions

1. Keep the new rule bridge helper as resolved groundwork: `prepareAdapterRuleRuntime()` loads rules, compiles a plan, projects it, and emits load/compile diagnostics as governance events.
2. Keep monitor status as resolved groundwork: provider health now reports `unsupported`, `not_configured`, `ready`, `active`, or `failed_to_start`; future monitor work should consume that status instead of adding another health shape.
3. Extract only stable `BaseCliAdapter` seams: provider hook record detection and spawn env construction are the lowest-risk first candidates because they already have focused tests.
4. After remediation, run focused gates first: `yarn workspace @dzupagent/agent-adapters test`, `typecheck`, `lint`, and `build`; then rerun `yarn check:package-tiers`, `yarn check:domain-boundaries`, and `yarn verify` before checkpointing a broader slice.
