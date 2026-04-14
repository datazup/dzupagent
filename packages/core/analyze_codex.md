# @dzupagent/core - Implementation Analysis and Gap Assessment

Date: 2026-04-03
Reviewer: Codex
Scope: `packages/core`

## Executive Summary
`@dzupagent/core` is feature-rich and already covers a wide surface area: LLM routing/invocation, protocol adapters, MCP integration, security/policy primitives, vector adapters, skills, orchestration utilities, and facade entry points. The package shows strong test investment and good modular decomposition by directory.

The biggest current risk is not missing functionality; it is consistency and production-hardening gaps across a very large API surface.

Top priorities are:
1. Fix correctness/reliability gaps in critical paths (`CircuitBreaker`, LLM timeout behavior, protocol streaming timeout handling).
2. Align exposed APIs with actual behavior (middleware lifecycle, tool governance options, event bus semantics, config validation).
3. Reduce operational risk from API sprawl and in-memory-only defaults for runtime-critical concerns.

## Review Method
- Static code review of `packages/core/src`, `packages/core/docs`, and `packages/core/README.md`.
- Focused inspection of high-impact modules: `llm`, `protocol`, `mcp`, `security`, `skills`, `persistence`, `registry`, `config`, `facades`.
- Test baseline run: `yarn workspace @dzupagent/core test`.

## Current Implementation Snapshot

### Size and Surface
- TypeScript files under `src`: 261
- Test files: 72
- Non-test LOC: 26,682
- Test LOC: 20,066
- Root entrypoint size: `src/index.ts` is 862 lines
- Export statement count:
  - `src/index.ts`: 183
  - `src/facades/memory.ts`: 65
  - `src/facades/orchestration.ts`: 58

### Module Distribution (non-test files)
- Largest areas: `security` (24 files), `vectordb` (20), `protocol` (13), `identity` (13), `mcp` (12), `skills` (11)

### Test Baseline
- Command: `yarn workspace @dzupagent/core test`
- Result: 71/72 test files passed, 1589/1595 tests passed
- One failing suite: `src/__tests__/facades.test.ts` due hook timeout in `facades/quick-start` (`Hook timed out in 10000ms`)

Interpretation: coverage is broad and generally healthy, but there is at least one stability/performance-sensitive test path around facade loading.

## Strengths
1. Modular architecture is clear and discoverable by domain.
2. Strong unit test footprint across most critical areas (LLM, protocol, identity, security, vector adapters, registries).
3. Good use of type-first contracts for cross-module boundaries (events, protocol messages, policy types, MCP types).
4. Helpful facade strategy exists (`quick-start`, `memory`, `orchestration`, `security`, `stable`, `advanced`) for progressive adoption.
5. Optional dependency handling for memory IPC is thoughtful and explicit (`src/memory-ipc.ts`).
6. Good boundary enforcement tests (`src/__tests__/boundary.test.ts`) to avoid accidental cross-package coupling.

## Gap Analysis (Prioritized)

| Priority | Gap | Evidence | Impact | Recommendation |
|---|---|---|---|---|
| P0 | `CircuitBreaker` half-open attempt cap is not enforced | `src/llm/circuit-breaker.ts` tracks `halfOpenAttempts` but never increments it; only compared in `canExecute()` | Can allow unlimited half-open probes under failure conditions | Increment `halfOpenAttempts` when half-open execution is admitted; add regression test for `halfOpenMaxAttempts > 1` and hard cap behavior |
| P0 | LLM timeout does not cancel underlying call | `src/llm/invoke.ts` uses `Promise.race` with `setTimeout`, but does not abort `model.invoke` | Timed-out calls may still run and consume tokens/cost in background | Introduce cancellation-aware invoke path (`AbortSignal` propagation where supported); add timeout cancellation tests |
| P1 | Event bus behavior docs mismatch runtime semantics | `src/events/event-bus.ts` docs say handlers run asynchronously/microtask; implementation executes handlers immediately in `emit()` | Misleading operational expectations; subtle reentrancy behavior | Either update docs to synchronous fire-and-forget or implement microtask dispatch (`queueMicrotask`) explicitly |
| P1 | Model registry middleware API is currently passive (registration only) | `src/llm/model-registry.ts` stores middlewares via `use/get/remove`; no invocation pipeline consumes `beforeInvoke/afterInvoke` | Exposed extension point appears functional but is not wired into runtime path | Add `invokeWithRegistry` execution pipeline that calls middleware hooks around model invocation |
| P1 | Plugin lifecycle is one-way (register only), no deterministic unload | `src/plugin/plugin-registry.ts` subscribes handlers and stores plugins, but no unregister/dispose lifecycle and no retained unsubscriber handles | Long-running processes can leak handlers/state; hot-reload scenarios are fragile | Add `unregister(name)` and `dispose()`; track and call unsubscribers per plugin |
| P1 | Config resolution does not re-validate merged result | `src/config/config-loader.ts` validates file config only, but `resolveConfig()` returns merged config without final `validateConfig()` pass | Invalid env/runtime overrides can flow into runtime undetected | Validate merged config before return; fail-fast with structured error details |
| P1 | MCP client transport layer is minimal and expensive for stdio | `src/mcp/mcp-client.ts` spawns process per stdio interaction (`spawnWithStdin`), SSE path is aliased to HTTP request pattern, no session handshake/state machine | Throughput and reliability limits in production MCP-heavy workloads | Add persistent per-server sessions, proper initialize/list/call lifecycle, retries/backoff, and connection pooling |
| P1 | Internal protocol streaming timeout allocates timer per wait without cleanup | `src/protocol/internal-adapter.ts` stream loop creates `setTimeout` in each wait cycle without clear timeout handle | Timer accumulation under long streams; avoidable memory/event-loop pressure | Track timeout handle per wait and clear on resolve/reject; add stress test for long streams |
| P2 | Skill discovery path uses sync I/O and sync git command in runtime utilities | `src/skills/skill-directory-loader.ts` uses `readFileSync/readdirSync/statSync`; `src/skills/hierarchical-walker.ts` uses `execSync` | Blocks event loop during scans, noticeable in large repos/interactive runtimes | Add async loader variants and cached indexing; keep sync path only for CLI-only contexts |
| P2 | Audit store integrity mechanism is not cryptographic by default | `src/security/audit/in-memory-audit-store.ts` header mentions SHA-256 chain, implementation uses simple djb2-style hash | Gives weaker tamper-evidence than expected if reused beyond test/dev | Clarify docs and add crypto-backed store implementation as recommended default for production |
| P2 | Error model is inconsistent across modules | Static count: `throw new Error(...)` appears much more than `throw new ForgeError(...)` in `src` | Reduced observability/recoverability metadata consistency | Standardize on `ForgeError` for domain/runtime failures; keep plain `Error` for local programmer errors |
| P2 | Persistence naming collision increases cognitive load | Two classes named `InMemoryRunStore`: `src/persistence/in-memory-store.ts` and `src/persistence/in-memory-run-store.ts` | Confusing imports, accidental wrong type usage, alias complexity in exports | Rename one class (for example `InMemoryExecutionRunStore` vs `InMemoryRunRecordStore`) and keep compatibility alias |
| P2 | Tool governance config includes unimplemented timeout control | `maxExecutionMs` exists in `ToolGovernanceConfig` but is not enforced in `ToolGovernance` logic | Users may assume execution-time guardrails that do not exist | Either implement timeout enforcement helper wrapper or remove field until implemented |
| P2 | API surface breadth is very high for a single package boundary | `src/index.ts` and facade exports are large; package README advertises very broad exports | Semver stability pressure and onboarding difficulty | Introduce explicit API tiers + deprecation policy + automated export audit in CI |

## Additional Observations
- Facade tests indicate occasional import-time performance sensitivity in `quick-start` facade path.
- Multiple important runtime components are in-memory by default (expected for dev), but production migration paths are uneven across subsystems.
- Security scanners are regex-centric (fast and useful), but likely to need precision upgrades for enterprise-grade false-positive control.

## Recommended New Features

### 1) Unified Invocation Controller
Problem: Timeouts, retries, circuit-breakers, middleware, and usage tracking are currently split across separate constructs.

Feature:
- Add a single `invokeWithPolicy()`/`InvocationController` that orchestrates:
  - cancellation-aware timeouts
  - retry policy
  - breaker open/close updates
  - middleware hooks (`beforeInvoke` and `afterInvoke`)
  - token/cost attribution callbacks

Value: Simplifies integration and closes multiple P0/P1 gaps together.

### 2) Plugin Lifecycle Manager (register/unregister/reload)
Problem: Plugin registration is append-only.

Feature:
- `register`, `unregister`, `reload`, `dispose`
- deterministic tracking of event subscriptions and resource cleanup
- lifecycle hooks: `onRegister`, `onUnregister`

Value: Enables safe long-running servers and dynamic plugin workflows.

### 3) MCP Session Engine
Problem: Current MCP client is request-oriented and partly transport-simplified.

Feature:
- Persistent sessions per server (stdio child process reuse, reconnect policy)
- robust handshake and health model
- standardized retry/backoff and per-tool circuit breaker integration
- transport metrics and failure taxonomy

Value: Major reliability/performance gain for MCP-heavy deployments.

### 4) Async Skill Index and Watcher
Problem: Skill discovery uses blocking scan patterns.

Feature:
- async skill indexer with TTL cache and optional filesystem watcher
- incremental invalidation on file changes
- lazy content loading with metadata-first discovery

Value: Better UX and scalability in large repos/monorepos.

### 5) Durable Runtime Persistence Adapters
Problem: Some orchestration/runtime stores remain in-memory only in `core`.

Feature:
- pluggable adapters for run/event/audit persistence (Postgres/SQLite first)
- common retention interfaces
- migration-safe schemas

Value: Stronger production posture and consistent story with checkpointer persistence.

### 6) Policy Guardrails Compiler
Problem: Rich policy conditions can become expensive or unsafe (for example unbounded regex complexity).

Feature:
- compile policy sets into validated executable form
- regex safety checks and bounded evaluation policies
- optional decision tracing/audit explanation tree

Value: Safer, more predictable zero-trust enforcement under untrusted policy inputs.

### 7) Observability Exporters
Problem: Metrics collector is intentionally lightweight but not exporter-native.

Feature:
- built-in Prometheus text exporter
- optional OpenTelemetry metric bridge
- label cardinality guardrails and histogram buckets

Value: Better production observability without custom glue code.

### 8) API Governance Tooling
Problem: High export count increases accidental breaking-change risk.

Feature:
- CI export diff reports by entrypoint
- stability labels per export (`stable`, `beta`, `internal`)
- deprecation metadata and generated migration notes

Value: Better release discipline and consumer confidence.

## Suggested Delivery Plan

### Phase 0 (stability hotfixes)
- Fix circuit-breaker half-open counter behavior.
- Implement real timeout cancellation path for LLM invocations.
- Fix protocol stream timeout timer cleanup.
- Add failing-regression tests for all three.

### Phase 1 (runtime correctness and API alignment)
- Wire model registry middleware into execution path.
- Add plugin unregister/dispose lifecycle.
- Add final merged-config validation.
- Implement or remove `maxExecutionMs` in `ToolGovernance`.

### Phase 2 (production readiness)
- Introduce MCP session engine.
- Add async skill indexing and caching.
- Add first durable runtime persistence adapter(s).

### Phase 3 (governance and scale)
- Add API governance tooling and stability tiers.
- Add observability exporters and performance benchmark suite.

## Practical Quick Wins (Low Effort, High Return)
1. Add one test that fails if `halfOpenMaxAttempts` is not honored.
2. Add one test that verifies timeout actually aborts model call (or skips if provider cannot abort).
3. Rename one of the two `InMemoryRunStore` classes and keep a compatibility export alias.
4. Update event bus docs to match actual synchronous semantics (or implement microtask dispatch).
5. Raise `facades/quick-start` suite timeout or reduce import-time work to remove flaky CI behavior.

## Final Assessment
`packages/core` already has strong breadth and meaningful test depth. The next step is less about adding raw capability and more about turning the current broad platform into a more predictable production substrate: tighter runtime semantics, clearer lifecycle management, and explicit API governance.
