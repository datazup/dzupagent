# Architecture Audit

## Findings

### ARCHITECTURE-001 - High - Canonical adapter rules are not wired into adapter execution by default

**Impact:** The new `@dzupagent/adapter-rules` package can compile canonical rules into prompt sections, provider config patches, monitor subscriptions, deny paths, alerts, and watcher registrations, but current adapter execution only exposes optional hooks for hosts to supply their own validator and watcher factory. That leaves the best-practice/conformance layer advisory unless every consuming host remembers to load rules, compile a `RuntimePlan`, apply the provider patch, attach watchers, and route violations into governance. For the audited focus area, this is the largest architecture gap because the canonical rule projection surface and the runtime adapter surface are separate islands.

**Evidence:** `RuleCompiler.compile()` builds `providerConfigPatch` and `watcherRegistrations` in `packages/adapter-rules/src/compiler.ts:26` through `packages/adapter-rules/src/compiler.ts:43`. The package is only referenced from `packages/agent-adapters` comments and generic extension hooks: `BaseCLIAdapter.validateAndEmitRules()` explicitly says hosts must pass the validator to avoid a dependency in `packages/agent-adapters/src/base/base-cli-adapter.ts:281` through `packages/agent-adapters/src/base/base-cli-adapter.ts:290`, and artifact watching is a no-op unless a host wires `setArtifactWatcherFactory()` in `packages/agent-adapters/src/base/base-cli-adapter.ts:601` through `packages/agent-adapters/src/base/base-cli-adapter.ts:615`. A source search found no production import of `@dzupagent/adapter-rules`; only tests, docs, and comments reference it.

**Remediation:** Add an explicit integration seam, for example `AdapterRuntimePolicyEngine` or `createRuleAwareAdapterRuntime`, owned by `agent-adapters` or a small bridge package. It should load rules, compile the runtime plan per provider/request, merge provider config/input options, install watcher registrations, and emit conformance failures through the governance event side-channel. Keep `adapter-rules` itself dependency-light, but make the runtime bridge first-class and tested so hosts do not have to recreate the wiring.

### ARCHITECTURE-002 - High - Rule loading validates only the outer shell, so malformed effects can silently disappear

**Impact:** Rule files are runtime data, but `RuleLoader` accepts any object whose `kind` is a string as a `RuleEffect`. Missing fields such as `content`, `target`, `path`, or invalid enum values pass loading and are cast to the TypeScript union. The compiler switch has no default branch, so unknown effect kinds are silently ignored; known kinds with missing fields can push `undefined` into runtime plans. This weakens best-practice conformance because a rule pack can look loaded while its enforcement or projection is absent.

**Evidence:** The loader checks required top-level fields and only verifies `effects` with `isValidEffect()` in `packages/adapter-rules/src/loader.ts:86` through `packages/adapter-rules/src/loader.ts:109`; `isValidEffect()` returns true for any object with a string `kind`. The compiler assumes the discriminated union and only handles known cases in `packages/adapter-rules/src/compiler.ts:87` through `packages/adapter-rules/src/compiler.ts:118`, with no runtime default or violation emission for unknown kinds.

**Remediation:** Replace the hand-rolled loader guard with a real runtime schema for `AdapterRule`, `RuleMatch`, and every `RuleEffect` variant. Reject or quarantine malformed rules with structured diagnostics that include file path, rule id, effect index, and field-level errors. Add compiler-level defensive handling for unknown effects so bypasses become explicit conformance failures rather than silent no-ops.

### ARCHITECTURE-003 - Medium - Provider policy projection is split across two incompatible compilers

**Impact:** The repository now has two provider-policy projection systems: `adapter-rules` projects `require_approval`, `deny_path`, watch paths, model, API key, and provider-native config patches; `agent-adapters` separately compiles `AdapterPolicy` into `AdapterConfig`, `AgentInput.options`, and guardrail hints. Because they do not share a common intermediate contract, hosts can apply one path without the other and get inconsistent behavior for approvals, sandbox/network settings, denied paths, and guardrails.

**Evidence:** `adapter-rules` projects `require_approval` into `auditFlags`, `deny_path` into `deniedPaths`, and `watch_path` into monitor subscriptions in `packages/adapter-rules/src/compiler.ts:93` through `packages/adapter-rules/src/compiler.ts:116`; provider projectors then emit native patches such as Codex `approvalPolicy`, Gemini `tool_config.denied_paths`, Qwen `approval_mode`, Goose `goose.mode`, and Crush `permissionMode` in `packages/adapter-rules/src/projectors/codex.ts:12` through `packages/adapter-rules/src/projectors/codex.ts:20`, `packages/adapter-rules/src/projectors/gemini.ts:61` through `packages/adapter-rules/src/projectors/gemini.ts:73`, and `packages/adapter-rules/src/projectors/qwen.ts:29` through `packages/adapter-rules/src/projectors/crush.ts:166`. Separately, `compilePolicyForProvider()` maps `AdapterPolicy` into adapter config/input options and guardrail hints in `packages/agent-adapters/src/policy/policy-compiler.ts:71` through `packages/agent-adapters/src/policy/policy-compiler.ts:305`; its conformance checker owns a separate provider capability map in `packages/agent-adapters/src/policy/policy-conformance.ts:63` through `packages/agent-adapters/src/policy/policy-conformance.ts:154`.

**Remediation:** Introduce one canonical runtime policy model and make both rule packs and `AdapterPolicy` lower into it. Provider projectors should consume that model once and produce `{ adapterConfig, inputOptions, providerConfigPatch, guardrails, monitors }`. Keep compatibility wrappers for existing APIs, but make conformance checks validate the final compiled plan rather than only the original policy object.

### ARCHITECTURE-004 - Medium - Wildcard rules do not expand to provider-specific monitor watchers

**Impact:** A rule with `appliesToProviders: ["*"]` matches every provider during compilation, but watcher projection later iterates the literal provider string and has no watcher spec for `"*"`. The result is a plan that applies effects to the selected provider while only registering the generic `.dzupagent/` watcher, missing provider-local config paths such as `.codex/`, `.claude/`, `.gemini/`, or home config directories. This undercuts the requested projection-monitor observability area because global rules are likely to be the normal way to express shared best practices.

**Evidence:** Provider matching treats `'*'` as a match-all sentinel in `packages/adapter-rules/src/compiler.ts:50` through `packages/adapter-rules/src/compiler.ts:53`. `buildWatcherRegistrations()` later loops over `rule.appliesToProviders` and looks each literal string up in `PROVIDER_WATCHERS`; unknown entries are skipped in `packages/adapter-rules/src/projectors/watchers.ts:86` through `packages/adapter-rules/src/projectors/watchers.ts:90`. Only the generic DzupAgent watcher is always pushed in `packages/adapter-rules/src/projectors/watchers.ts:80` through `packages/adapter-rules/src/projectors/watchers.ts:84`.

**Remediation:** Resolve `'*'` against the compile context before watcher projection. For a per-provider compile, expand it to `context.providerId`; for a fleet compile, expand it to the known provider catalog. Add a regression test where a global rule compiled for `codex` registers Codex project/home watcher paths in addition to `.dzupagent/`.

### ARCHITECTURE-005 - Medium - Adapter monitor integration remains best-effort and optional at the base runtime layer

**Impact:** Provider catalog metadata distinguishes monitorable providers, and base adapters have watcher lifecycle hooks, but monitoring is not a guaranteed runtime contract. If no factory is installed, `startArtifactWatcher()` returns without observable diagnostics; if factory creation fails, the failure is swallowed. That is reasonable for a low-level optional peer, but it means the framework cannot prove monitor coverage or report why a monitor is absent, which matters for operator observability and best-practice conformance.

**Evidence:** The provider catalog marks monitor introspection tiers in `packages/agent-adapters/src/provider-catalog.ts:40` through `packages/agent-adapters/src/provider-catalog.ts:122`, and `getMonitorableProviders()` returns all providers whose tier is not `none` in `packages/agent-adapters/src/provider-catalog.ts:130` through `packages/agent-adapters/src/provider-catalog.ts:135`. During execution, `BaseCLIAdapter` starts watchers from static provider watch specs in `packages/agent-adapters/src/base/base-cli-adapter.ts:362` through `packages/agent-adapters/src/base/base-cli-adapter.ts:369`, but `startArtifactWatcher()` returns when no factory exists and swallows factory errors in `packages/agent-adapters/src/base/base-cli-adapter.ts:623` through `packages/agent-adapters/src/base/base-cli-adapter.ts:632`.

**Remediation:** Make monitor availability explicit in the runtime health/conformance plane. Expose a `monitorStatus` field per provider with states such as `not_configured`, `active`, `failed_to_start`, and `unsupported`; emit governance or adapter events when monitoring is skipped or fails. Let host products keep the monitor dependency optional, but require a visible status so operators can distinguish unsupported providers from misconfigured monitor wiring.

### ARCHITECTURE-006 - Medium - CLI configuration commands are disconnected from the adapter-rule/provider projection system

**Impact:** The CLI presents `config get`, `config set`, and `config validate`, but it only reads a narrow server JSON schema and does not compile adapter rules, preview provider config patches, validate provider-native configs, or manage the projection output. This creates an operator UX gap: the framework has rule and projection primitives, yet the CLI cannot answer whether adapter best practices are applied or what provider config would be written.

**Evidence:** `dzup config get` reads a JSON file and returns a raw key in `packages/server/src/cli/dzup.ts:158` through `packages/server/src/cli/dzup.ts:177`; `dzup config set` only prints that file writes are not implemented in `packages/server/src/cli/dzup.ts:179` through `packages/server/src/cli/dzup.ts:192`. The validator only checks `port`, `auth.mode`, and `rateLimit` in `packages/server/src/cli/config-command.ts:20` through `packages/server/src/cli/config-command.ts:79`. There is no CLI command importing or invoking `RuleLoader`, `RuleCompiler`, provider projectors, provider catalog conformance, or monitor watcher registration.

**Remediation:** Add CLI commands such as `dzup adapter-rules validate`, `dzup adapter-rules plan --provider <id>`, and `dzup adapters doctor --rules <dir>`. These should use the same runtime bridge proposed above, emit JSON for automation, and clearly separate preview/dry-run projection from applying provider config files.

### ARCHITECTURE-007 - Medium - Health and observability planes are split between agent registry and provider adapter registry

**Impact:** `packages/server` has a registry `HealthMonitor` for HTTP-registered agents, while `agent-adapters` has `ProviderAdapterRegistry.getDetailedHealth()` for provider adapters and circuit breakers. They emit different event families and expose different status models. For adapter-monitor observability, this split makes it harder to build one operator view that answers provider health, active monitor state, circuit state, current adapter work, and rule conformance consistently.

**Evidence:** `ProviderAdapterRegistry.getDetailedHealth()` returns per-adapter health, circuit state, consecutive failures, and last success/failure timestamps in `packages/agent-adapters/src/registry/adapter-registry.ts:477` through `packages/agent-adapters/src/registry/adapter-registry.ts:505`. The server `HealthMonitor` probes `AgentRegistry` endpoints, maintains its own circuit manager, and emits `registry:health_changed` events in `packages/server/src/registry/health-monitor.ts:140` through `packages/server/src/registry/health-monitor.ts:257`. Registry events from provider adapters are emitted as `adapter_registry:*`, `agent:*`, and `provider:*` in `packages/agent-adapters/src/registry/adapter-registry.ts:588` through `packages/agent-adapters/src/registry/adapter-registry.ts:618`, separate from the server health monitor's `registry:health_changed` event.

**Remediation:** Define a shared adapter/agent observability contract, likely in `adapter-types` or `runtime-contracts`, that can represent provider adapter health, monitor status, rule conformance status, and server-registered agent health. Keep implementation-specific monitors separate, but normalize their snapshots and events before exposing them to CLI, HTTP routes, or product dashboards.

### ARCHITECTURE-008 - Medium - Agent-adapters root API is still a large compatibility barrel despite subpath intent

**Impact:** `@dzupagent/agent-adapters` exposes adapters, orchestration, workflow, middleware, HTTP, sessions, plugins, recovery, approval, testing, provider catalog, policy compiler, UCL importers, and utilities through one root barrel. That broad root makes dependency boundaries and semver intent harder to reason about, and it works against the package's own docs that describe plane-specific subpaths. This is public API sprawl rather than a stylistic issue because every root export becomes a supported consumer contract.

**Evidence:** The root barrel spans 546 lines and re-exports most package internals from `packages/agent-adapters/src/index.ts:13` through `packages/agent-adapters/src/index.ts:546`. The package manifest declares subpaths for `./providers`, `./orchestration`, `./workflow`, `./http`, `./persistence`, `./learning`, and `./recovery` in `packages/agent-adapters/package.json:8` through `packages/agent-adapters/package.json:37`. The allowlist config still treats this as a transitional root with broad prefix allowances in `config/public-api-allowlists.json` for `@dzupagent/agent-adapters`, while package docs note the root is a compatibility re-export surface.

**Remediation:** Keep existing root exports for 0.x compatibility, but stop adding new surfaces to the root. Promote the provider/rules/conformance/monitor APIs through explicit subpaths and add a public API check that rejects new root exports unless they are classified as stable or transitional with a migration note.

## Scope Reviewed

Read the prepared repo snapshot first:

- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-packages-agent-adapters-adapter-rules-provider-config-projection-monitor-observability-cli-best-practice-conformance-2026-04-30/run-001/codex-prep/context/repo-snapshot.md`

Reviewed current source selectively for the architecture domain, weighted toward `adapter-rules`, provider config projection, monitor/observability, CLI, and best-practice conformance:

- `packages/adapter-rules/src/**`
- `packages/agent-adapters/src/base/base-cli-adapter.ts`
- `packages/agent-adapters/src/policy/**`
- `packages/agent-adapters/src/provider-catalog.ts`
- `packages/agent-adapters/src/registry/adapter-registry.ts`
- `packages/agent-adapters/src/index.ts`
- `packages/adapter-types/src/**`
- `packages/server/src/cli/**`
- `packages/server/src/registry/health-monitor.ts`
- `packages/otel/src/event-metric-map/**`
- `package.json`, relevant package manifests, `config/public-api-allowlists.json`, and `scripts/check-domain-boundaries.mjs`

Generated, dependency, and old-audit artifacts were not used as evidence. I did not run runtime validation, tests, builds, or CLI commands for this audit; findings are based on static source review only.

## Strengths

- `adapter-rules` is a clean low-dependency package with a focused compiler/projector shape and tests for compiler, loader, provider projectors, and watcher projection.
- Provider productization metadata is centralized in `PROVIDER_CATALOG`, including product integration, HTTP routing, monitor introspection, replay, policy projection, and skill projection flags.
- `ProviderAdapterRegistry` has concrete circuit-breaker-aware health reporting and detailed per-adapter snapshots.
- `BaseCLIAdapter` already has a governance side-channel for approvals, hook execution, and rule violations, which is the right integration target for rule conformance.
- The package has explicit agent-adapter subpaths in `package.json`, providing a migration path away from the broad root barrel.
- Boundary tooling exists for package tiers, layer graph classification, route governance, declared dependencies, and public API allowlists.

## Open Questions Or Assumptions

- I treated `@dzupagent/adapter-rules` as intended to be a reusable framework primitive, not a product-only helper, because it is a workspace package with its own manifest and tests.
- I assumed the current absence of runtime integration is not intentional final state; comments in `BaseCLIAdapter` describe host integration, but no default bridge exists in current code.
- I did not verify provider-native config schemas against external provider documentation; findings are about internal consistency and projection architecture, not whether a specific provider field name is externally correct.
- I did not classify optional monitor behavior as a runtime bug. The finding is that optional/no-op monitoring lacks a visible conformance status.
- Existing dirty working-tree changes were treated as user work and were not reverted.

## Recommended Next Actions

1. Build a first-class rule-aware runtime bridge that connects `RuleLoader`, `RuleCompiler`, provider config projection, adapter config/input options, guardrails, watcher registration, and governance events.
2. Replace `RuleLoader` validation with discriminated runtime schemas and structured diagnostics.
3. Consolidate `adapter-rules` projection and `agent-adapters` policy compilation around one canonical compiled runtime policy model.
4. Fix wildcard provider watcher expansion and add tests for global rules against concrete providers.
5. Add monitor status to adapter health/conformance snapshots and expose skipped/failed monitor wiring as visible events or health details.
6. Add CLI preview/validate commands for adapter rules and provider projection; keep apply/write behavior behind explicit opt-in.
7. Normalize provider adapter health and server agent health behind a shared observability contract before product/dashboard expansion.
8. Continue root API contraction for `@dzupagent/agent-adapters` by routing new surfaces to explicit subpaths only.

```json
{
  "domain": "architecture",
  "counts": { "critical": 0, "high": 2, "medium": 6, "low": 0, "info": 0 },
  "findings": [
    { "id": "ARCHITECTURE-001", "severity": "high", "title": "Canonical adapter rules are not wired into adapter execution by default", "file": "packages/agent-adapters/src/base/base-cli-adapter.ts" },
    { "id": "ARCHITECTURE-002", "severity": "high", "title": "Rule loading validates only the outer shell, so malformed effects can silently disappear", "file": "packages/adapter-rules/src/loader.ts" },
    { "id": "ARCHITECTURE-003", "severity": "medium", "title": "Provider policy projection is split across two incompatible compilers", "file": "packages/agent-adapters/src/policy/policy-compiler.ts" },
    { "id": "ARCHITECTURE-004", "severity": "medium", "title": "Wildcard rules do not expand to provider-specific monitor watchers", "file": "packages/adapter-rules/src/projectors/watchers.ts" },
    { "id": "ARCHITECTURE-005", "severity": "medium", "title": "Adapter monitor integration remains best-effort and optional at the base runtime layer", "file": "packages/agent-adapters/src/base/base-cli-adapter.ts" },
    { "id": "ARCHITECTURE-006", "severity": "medium", "title": "CLI configuration commands are disconnected from the adapter-rule/provider projection system", "file": "packages/server/src/cli/dzup.ts" },
    { "id": "ARCHITECTURE-007", "severity": "medium", "title": "Health and observability planes are split between agent registry and provider adapter registry", "file": "packages/server/src/registry/health-monitor.ts" },
    { "id": "ARCHITECTURE-008", "severity": "medium", "title": "Agent-adapters root API is still a large compatibility barrel despite subpath intent", "file": "packages/agent-adapters/src/index.ts" }
  ]
}
```
