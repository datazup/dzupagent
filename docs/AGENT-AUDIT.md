# Agent Pattern Audit

## Findings

### DOMAIN-001 - High - Per-run policy overrides mutate shared adapter configuration

Impact: Request-scoped policy can leak into later runs because the orchestrator applies compiled policy by calling `adapter.configure(...)` on the registered adapter instance. In a long-lived registry, a run that sets a permissive or restrictive sandbox/provider option can alter the adapter defaults observed by unrelated future requests.

Evidence: `OrchestratorFacade.applyPolicyOverrides()` resolves a target provider, compiles the active policy, then calls `adapter.configure(compiled.config)` on the registry adapter at `packages/agent-adapters/src/facade/orchestrator-facade.ts:363` and `packages/agent-adapters/src/facade/orchestrator-facade.ts:369`. The core adapters merge those values into instance state, for example `BaseCliAdapter.configure()` in `packages/agent-adapters/src/base/base-cli-adapter.ts:597`, `ClaudeAgentAdapter.configure()` in `packages/agent-adapters/src/claude/claude-adapter.ts:207`, and `CodexAgentAdapter.configure()` in `packages/agent-adapters/src/codex/codex-adapter.ts:338`.

Remediation: Treat policy compilation as per-execution input, not adapter mutation. Pass compiled config through an execution-scoped adapter wrapper or clone/reset adapter configuration around the run. Add a regression test with two sequential runs proving policy on the first run cannot affect the second.

### DOMAIN-002 - High - Policy guardrail hints are compiled but not applied to the guardrail layer

Impact: Policies can declare `blockedTools` and `maxBudgetUsd`, and conformance warnings claim these will rely on guardrail or cost middleware, but the common orchestrator path does not merge the compiled guardrail hints into the active `AdapterGuardrails` instance. This makes policy enforcement dependent on preconfigured global middleware rather than the request policy.

Evidence: `extractGuardrailHints()` emits `maxIterations`, `maxCostCents`, and `blockedTools` at `packages/agent-adapters/src/policy/policy-compiler.ts:253`. `applyPolicyOverrides()` only mutates adapter config, merges `inputOptions`, and copies `compiled.guardrails.maxIterations` into `input.maxTurns`; it ignores `maxCostCents` and `blockedTools` at `packages/agent-adapters/src/facade/orchestrator-facade.ts:366` and `packages/agent-adapters/src/facade/orchestrator-facade.ts:371`. The actual blocking logic lives in `AdapterGuardrails.handleToolCall()` at `packages/agent-adapters/src/guardrails/adapter-guardrails.ts:381`, but no inspected orchestration code constructs or updates that guardrail instance from per-run policy hints.

Remediation: Build an execution-scoped guardrail overlay from `compiled.guardrails` and apply it after event bridging for that run. Add tests where a per-run `blockedTools` policy blocks a tool even when the facade was constructed without a preconfigured blocklist.

### DOMAIN-003 - High - Unsupported policy controls continue after warning-only conformance

Impact: A policy can request controls such as disabling network access, requiring approval, or enforcing tool allow/block lists on providers that do not natively support them. The conformance checker emits warnings, but the orchestrator proceeds without a required compensating control, so callers can believe a best-practice policy is active when it is only advisory.

Evidence: `PolicyConformanceChecker.check()` marks unsupported `networkAccess: false`, native approval, allowlists, blocklists, and budget controls as `warning` for many providers at `packages/agent-adapters/src/policy/policy-conformance.ts:191`, `packages/agent-adapters/src/policy/policy-conformance.ts:206`, and `packages/agent-adapters/src/policy/policy-conformance.ts:215`. `compilePolicyWithConformance()` throws only when `result.conformant` is false, and `conformant` only considers `error` severities at `packages/agent-adapters/src/policy/policy-conformance.ts:269` and `packages/agent-adapters/src/facade/orchestrator-facade.ts:805`.

Remediation: Introduce an explicit conformance mode. Production/default policy mode should fail closed when a requested control cannot be enforced natively or by a known middleware fallback. If warning-only behavior is retained for compatibility, surface structured warnings on the event bus and response metadata.

### DOMAIN-004 - High - Explicit policy can be compiled for a different provider than the one actually routed

Impact: In auto-routing mode, policy projection chooses the first registered adapter when `preferredProvider` is omitted, but execution later routes through the registry. If the router selects a different provider, provider-specific config projection and conformance validation were performed against the wrong provider.

Evidence: `applyPolicyOverrides()` selects `preferredProvider ?? this._registry.listAdapters()[0]` as the policy target at `packages/agent-adapters/src/facade/orchestrator-facade.ts:363`. The actual run then calls `ProviderAdapterRegistry.executeWithFallback(input, task)` at `packages/agent-adapters/src/facade/orchestrator-facade.ts:461`, and that registry computes the routed provider from healthy IDs and the active router at `packages/agent-adapters/src/registry/adapter-registry.ts:249` and `packages/agent-adapters/src/registry/adapter-registry.ts:258`.

Remediation: Decide the provider before compiling provider-specific policy, or compile a provider-agnostic policy plus per-attempt projection inside the registry after routing. Add an auto-routing test where the first registered provider differs from the selected provider and assert policy is projected for the selected provider.

### DOMAIN-005 - High - Adapter environment filtering can be bypassed by adapter config env overrides

Impact: The base CLI adapter filters sensitive `process.env` variables, then merges `config.env` afterward without re-filtering. A caller or policy layer that supplies `env` can pass secrets such as tokens, database URLs, or private keys into child agent CLIs despite the default sensitive-variable filter.

Evidence: `filterSensitiveEnvVars()` blocks secret-like environment keys at `packages/agent-adapters/src/base/base-cli-adapter.ts:23`. `BaseCliAdapter.buildEnv()` filters `process.env`, then applies `Object.assign(raw, this.config.env)` at `packages/agent-adapters/src/base/base-cli-adapter.ts:664` and `packages/agent-adapters/src/base/base-cli-adapter.ts:669`.

Remediation: Apply the same filter after merging config overrides, or require an explicit allowlist for config-supplied env vars. Add tests proving `DATABASE_URL`, `*_TOKEN`, and `*_SECRET` cannot be passed through `config.env` unless explicitly allowed.

### DOMAIN-006 - Medium - Canonical `deny_path` rules do not project consistently across providers

Impact: Adapter rules expose `deny_path` as a canonical effect, but most provider projectors either ignore it or have no enforcement bridge. Consumers can author one rule and get materially different safety behavior depending on provider selection.

Evidence: The compiler collects `deny_path` into `plan.deniedPaths` at `packages/adapter-rules/src/compiler.ts:111`, and `RuntimePlan` exposes that field at `packages/adapter-rules/src/types.ts:81`. Only the Gemini projector emits `tool_config.denied_paths` at `packages/adapter-rules/src/projectors/gemini.ts:33`; Claude, Codex, Qwen, Goose, and Crush projectors do not include `deniedPaths` in their patches at `packages/adapter-rules/src/projectors/claude.ts:11`, `packages/adapter-rules/src/projectors/codex.ts:11`, `packages/adapter-rules/src/projectors/qwen.ts:13`, `packages/adapter-rules/src/projectors/goose.ts:16`, and `packages/adapter-rules/src/projectors/crush.ts:13`.

Remediation: Add a provider capability table for each canonical rule effect. Fail compilation for unsupported hard-deny rules unless a framework guardrail enforces them outside the provider. Add projector conformance tests for every `RuleEffectKind` by provider.

### DOMAIN-007 - Medium - Provider config projection can place API keys into config patches without redaction policy

Impact: Rule projection accepts `apiKey` in `CompileContext` and emits it into provider-native config patches. Because projectors are pure and do not own persistence, this is not an immediate write, but any host that logs, persists, diffs, or exposes `providerConfigPatch` can leak credentials.

Evidence: `CompileContext` documents `apiKey` as projector input at `packages/adapter-rules/src/types.ts:91`. Gemini writes `gemini_api_key` at `packages/adapter-rules/src/projectors/gemini.ts:19`, Qwen writes `api_key` at `packages/adapter-rules/src/projectors/qwen.ts:19`, Goose writes `provider.api_key` at `packages/adapter-rules/src/projectors/goose.ts:26`, and Crush writes `api_key` at `packages/adapter-rules/src/projectors/crush.ts:22`.

Remediation: Split secret references from config patches. Project named secret handles or environment variable references by default, and provide a redaction helper for any diagnostic rendering of `RuntimePlan` or `providerConfigPatch`.

### DOMAIN-008 - Medium - Monitor projection is disconnected from runtime watcher startup

Impact: The rule compiler can produce watcher registrations, and the provider catalog advertises monitor introspection tiers, but the base adapter starts monitors from a separate hardcoded provider path list and only if a host manually injects a factory. Rule-driven watch paths and monitor subscriptions therefore may never reach runtime monitoring.

Evidence: `RuleCompiler.compile()` assigns `plan.watcherRegistrations = buildWatcherRegistrations(...)` at `packages/adapter-rules/src/compiler.ts:42`, and `buildWatcherRegistrations()` always includes `.dzupagent/` plus provider paths at `packages/adapter-rules/src/projectors/watchers.ts:67`. `BaseCliAdapter.execute()` ignores `RuntimePlan` registrations and starts from `PROVIDER_WATCH_SPECS` at `packages/agent-adapters/src/base/base-cli-adapter.ts:77` and `packages/agent-adapters/src/base/base-cli-adapter.ts:365`. Watcher startup is a no-op unless `setArtifactWatcherFactory()` was called at `packages/agent-adapters/src/base/base-cli-adapter.ts:623`.

Remediation: Carry `RuntimePlan.watcherRegistrations` into `AgentInput.options` or adapter run context and make watcher wiring explicit in orchestration. Emit a structured monitor-disabled event when a plan has watcher registrations but no watcher factory is configured.

### DOMAIN-009 - Medium - CLI process streams can be converted to empty successful completions

Impact: A CLI provider that exits successfully while emitting no mapped terminal event can produce an `adapter:completed` event with an empty result. This weakens conformance with the registry’s stricter terminal-event contract and can hide provider output-shape regressions.

Evidence: `spawnAndStreamJsonl()` silently skips non-JSON stdout lines at `packages/agent-adapters/src/utils/process-helpers.ts:233` and only throws on nonzero exit at `packages/agent-adapters/src/utils/process-helpers.ts:289`. `BaseCliAdapter.execute()` then yields a synthetic empty `adapter:completed` if no completed or failed event was mapped at `packages/agent-adapters/src/base/base-cli-adapter.ts:535`. By contrast, `ProviderAdapterRegistry.executeWithFallbackWithRaw()` treats a stream ending without `adapter:completed` as `MISSING_TERMINAL_COMPLETION` at `packages/agent-adapters/src/registry/adapter-registry.ts:303`.

Remediation: Move the missing-terminal failure invariant into `BaseCliAdapter`, or require each concrete adapter to explicitly opt into empty-success behavior. Capture skipped non-JSON stderr/stdout snippets in a redacted diagnostic field for failures.

### DOMAIN-010 - Medium - Approval and governance audit trails are best-effort and in-memory by default

Impact: Approval and governance events are useful for local observability, but the default audit path is volatile and recording failures are swallowed. Deployments that require durable review or compliance evidence can lose approval decisions and rule-violation history unless they explicitly inject a persistent store/listener.

Evidence: `AdapterApprovalGate` defaults to `new InMemoryApprovalAuditStore()` at `packages/agent-adapters/src/approval/adapter-approval.ts:127`, and that store is a bounded in-memory array at `packages/agent-adapters/src/approval/approval-audit.ts:49`. Audit recording catches and ignores store errors at `packages/agent-adapters/src/approval/adapter-approval.ts:437`. Governance events in `BaseCliAdapter` are listener-only side-channel events at `packages/agent-adapters/src/base/base-cli-adapter.ts:143` and listener errors are swallowed at `packages/agent-adapters/src/base/base-cli-adapter.ts:183`.

Remediation: Document the in-memory store as development-only for compliance use, provide a first-class persistent audit sink interface for approval plus governance events, and expose sink health in `doctor` or detailed health endpoints.

### DOMAIN-011 - Medium - Framework HTTP routing can expose core-only providers

Impact: The catalog separates product-integrated providers from core-only providers, but HTTP schemas accept providers based on `httpAdapterRouting`, which includes `goose` and `crush` despite `productIntegrated: false`. Product surfaces that use the generic HTTP handler can accidentally expose core-only providers.

Evidence: The productization comment marks Goose, Crush, and Gemini SDK as core-only and says they are excluded from product surfaces at `packages/agent-adapters/src/provider-catalog.ts:16`. However Goose and Crush have `productIntegrated: false` but `httpAdapterRouting: true` at `packages/agent-adapters/src/provider-catalog.ts:77` and `packages/agent-adapters/src/provider-catalog.ts:86`. HTTP request schemas build `AdapterProviderIdSchema` from `HTTP_ROUTABLE_PROVIDER_IDS` at `packages/agent-adapters/src/http/request-schemas.ts:10` and `packages/agent-adapters/src/http/request-schemas.ts:18`.

Remediation: Separate framework HTTP routing from product HTTP routing. Product handlers should use `getProductProviders()` or an explicit allowlist, while framework-only handlers can opt into core providers with a visible configuration flag.

### DOMAIN-012 - Medium - CLI status/config commands can print sensitive local state

Impact: CLI commands intended for diagnostics can print full config values and `.dzupagent/state.json` content. That is convenient locally but unsafe for copied support output, CI logs, or operator terminals where database URLs, tokens, memory state, or provider metadata may be present.

Evidence: `dzup config get` prints object values with `JSON.stringify(value, null, 2)` at `packages/server/src/cli/dzup.ts:171`, and `configShow()` returns parsed config objects without redaction at `packages/server/src/cli/config-command.ts:86`. `dzupagent status` reads and prints `.dzupagent/state.json` verbatim at `packages/server/src/cli/dzup.ts:375`.

Remediation: Add redaction for known secret keys and URL credentials before printing any config/state value. Provide `--show-secrets` as an explicit opt-in if raw output is needed, and default support diagnostics to redacted JSON.

## Finding Manifest

```json
{
  "domain": "agent patterns",
  "counts": { "critical": 0, "high": 5, "medium": 7, "low": 0, "info": 0 },
  "findings": [
    { "id": "DOMAIN-001", "severity": "high", "title": "Per-run policy overrides mutate shared adapter configuration", "file": "packages/agent-adapters/src/facade/orchestrator-facade.ts" },
    { "id": "DOMAIN-002", "severity": "high", "title": "Policy guardrail hints are compiled but not applied to the guardrail layer", "file": "packages/agent-adapters/src/facade/orchestrator-facade.ts" },
    { "id": "DOMAIN-003", "severity": "high", "title": "Unsupported policy controls continue after warning-only conformance", "file": "packages/agent-adapters/src/policy/policy-conformance.ts" },
    { "id": "DOMAIN-004", "severity": "high", "title": "Explicit policy can be compiled for a different provider than the one actually routed", "file": "packages/agent-adapters/src/facade/orchestrator-facade.ts" },
    { "id": "DOMAIN-005", "severity": "high", "title": "Adapter environment filtering can be bypassed by adapter config env overrides", "file": "packages/agent-adapters/src/base/base-cli-adapter.ts" },
    { "id": "DOMAIN-006", "severity": "medium", "title": "Canonical deny_path rules do not project consistently across providers", "file": "packages/adapter-rules/src/compiler.ts" },
    { "id": "DOMAIN-007", "severity": "medium", "title": "Provider config projection can place API keys into config patches without redaction policy", "file": "packages/adapter-rules/src/types.ts" },
    { "id": "DOMAIN-008", "severity": "medium", "title": "Monitor projection is disconnected from runtime watcher startup", "file": "packages/adapter-rules/src/compiler.ts" },
    { "id": "DOMAIN-009", "severity": "medium", "title": "CLI process streams can be converted to empty successful completions", "file": "packages/agent-adapters/src/base/base-cli-adapter.ts" },
    { "id": "DOMAIN-010", "severity": "medium", "title": "Approval and governance audit trails are best-effort and in-memory by default", "file": "packages/agent-adapters/src/approval/adapter-approval.ts" },
    { "id": "DOMAIN-011", "severity": "medium", "title": "Framework HTTP routing can expose core-only providers", "file": "packages/agent-adapters/src/provider-catalog.ts" },
    { "id": "DOMAIN-012", "severity": "medium", "title": "CLI status/config commands can print sensitive local state", "file": "packages/server/src/cli/dzup.ts" }
  ]
}
```

## Scope Reviewed

Reviewed current source code for the agent patterns domain, weighted toward adapter-rules, provider config projection, monitoring/observability, CLI behavior, and best-practice conformance. The review started from `context/repo-snapshot.md` in the prepared prompt pack, then selectively inspected current source under:

- `packages/adapter-rules/src`
- `packages/agent-adapters/src`
- `packages/agent/src/agent/tool-loop`
- `packages/server/src/cli`
- representative audit/approval/governance surfaces in `packages/agent-adapters/src/approval`, `packages/agent-adapters/src/base`, and `packages/agent-adapters/src/guardrails`

No generated files, dependency folders, or old audit artifacts were used as evidence. No runtime validation was run for this document.

## Strengths

- The provider catalog now encodes product integration, HTTP routing, monitor introspection, replay, policy projection, and skill projection as explicit provider capabilities.
- `ProviderAdapterRegistry` has a strong terminal-event invariant: provider streams must emit `adapter:completed` or they are treated as failed and fallback can continue.
- The adapter policy layer has a useful structural taxonomy: provider-specific compilers, guardrail hints, and conformance checks are separated instead of hardcoded into one adapter.
- Tool loop scheduling in `packages/agent/src/agent/tool-loop` keeps scheduling separate from execution policy, which is a good boundary for auditability.
- Guardrail, approval, and governance primitives exist and are testable; the main gap is default wiring and durability, not absence of primitives.

## Open Questions Or Assumptions

- I treated `packages/server` CLI findings as maintenance/compatibility concerns, not a request to productize new server features.
- I treated the local audit command taxonomy structurally: this document maps findings to current source and does not use prior audit files as evidence.
- I assumed product HTTP surfaces may reuse `AdapterHttpHandler`; if consuming apps wrap it with their own provider allowlists, DOMAIN-011 becomes a framework-footgun rather than an immediate product exposure.
- I did not verify provider-native config schemas against live CLIs; projection findings are based on DzupAgent’s current code contracts and internal consistency.

## Recommended Next Actions

1. Fix the policy execution boundary first: stop mutating shared adapter config for per-run policy and apply policy after final provider routing.
2. Wire compiled guardrail hints into an execution-scoped guardrail overlay, then make conformance warnings fail closed when no native or framework fallback exists.
3. Add a provider/rule conformance matrix for `AdapterRule` effects, starting with hard-deny effects such as `deny_path` and approval requirements.
4. Add secret-redaction helpers for `RuntimePlan`, `providerConfigPatch`, CLI config/status output, and adapter env override paths.
5. Connect rule-derived watcher registrations into runtime monitoring, with explicit disabled-monitor events when watcher factories are absent.
6. Add focused tests for the high findings before broad refactoring: policy isolation across runs, policy target provider selection, config-env redaction, and per-run blocked-tool enforcement.
