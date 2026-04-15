# @dzupagent/memory Implementation Analysis and Gap Assessment

Date: 2026-04-03
Reviewer: Codex (GPT-5)
Scope: `packages/memory`

## 1. Method and Validation

- Code review scope:
  - `packages/memory/src/**` (core modules + retrieval + sharing + sync + encryption + temporal)
  - `packages/memory/docs/ARCHITECTURE.md`
  - `packages/memory/README.md`
  - `packages/memory/package.json`
- Validation executed:
  - `yarn workspace @dzupagent/memory test`
  - Result: 45/45 test files passed, 1095/1095 tests passed.
- Scale snapshot:
  - ~91 non-test TypeScript source files in `src/`
  - 45 test files
  - ~32,649 TS lines across `src/*.ts` and `src/*/*.ts`

## 2. Current Implementation Summary

The package is broad and ambitious. It combines:

- Base memory CRUD/search via `MemoryService`
- Working memory (`WorkingMemory`, `VersionedWorkingMemory`)
- Security controls (sanitizer, write-policy, encryption)
- Retrieval stack (vector/FTS/graph, weighted fusion, adaptive intent routing)
- Knowledge graph and relationships
- Temporal, provenance, CRDT, sync, and shared-space collaboration features
- MCP tool adapter (`MCPMemoryHandler`)

Architecture breadth is strong and test coverage is substantial. The main risks are not missing functionality, but consistency and operational reliability across layers.

## 3. Strengths

1. Strong modular decomposition across domains (retrieval, sync, sharing, temporal, encryption), with clear export surface in `src/index.ts`.
2. Large and fast-running test suite (1095 tests) gives good regression safety for many modules.
3. Good backward-compatibility posture in several places (`TemporalMemoryService` treats missing `_temporal` as active; tombstone fallbacks when delete is unsupported).
4. Retrieval design is pragmatic:
   - Multiple providers
   - Weighted fusion
   - Runtime provider-failure handling and warnings (`adaptive-retriever.ts`).
5. Useful extension points are already present:
   - Policy composition
   - Store capability detection
   - Key providers for encryption
   - Event hooks in sharing/retrieval.

## 4. Gap Analysis (Severity-Ranked)

## Critical

### C1. Packaging risk: runtime import of Postgres store without runtime dependency contract

- Evidence:
  - Static import at module top: `src/store-factory.ts:8`
  - `@langchain/langgraph-checkpoint-postgres` is only in `devDependencies`: `package.json:32-39`
  - Not listed in `dependencies` or `peerDependencies`: `package.json:21-31`
- Impact:
  - Consumers using only in-memory mode can still fail to load the package at runtime if postgres package is not installed.
- Gap:
  - Store backend dependency boundary is not safe for published consumption.
- Recommended fix:
  - Use dynamic import inside the `postgres` branch in `createStore`.
  - Declare backend package explicitly as runtime `dependency` or optional peer with clear install guidance.

### C2. Missing stable key contract on read paths causes downstream key fabrication

- Evidence:
  - `MemoryService.get()` and `search()` return only values, not keys: `src/memory-service.ts:152-166`, `205-247`
  - Downstream fallback key synthesis:
    - `memory-aware-extractor.ts:196-200`
    - `provenance-writer.ts:103-107`
    - `mcp-memory-server.ts:383-388`
    - `memory-space-manager.ts:736-739`
- Impact:
  - Any operation that needs exact keys (retention, compaction, dedup reporting, rotation, health diagnostics) can target incorrect records.
  - Hidden correctness drift in lifecycle operations.
- Gap:
  - No typed record envelope (`key + value + namespace + timestamps`) in service API.
- Recommended fix:
  - Add `getRecords()` / `searchRecords()` APIs returning `{ key, namespace?, value, metadata? }`.
  - Keep current value-only methods for compatibility, but migrate internal modules to key-preserving APIs.

### C3. Temporal history API does not actually filter by `keyPrefix`

- Evidence:
  - Method contract says key-prefix filtering: `src/temporal.ts:244-249`
  - Implementation merges all namespace records + search results, no key filter logic: `src/temporal.ts:256-285`
- Impact:
  - `getHistory(namespace, scope, keyPrefix)` can return unrelated records.
  - Incorrect historical answers and potential cross-record leakage inside namespace.
- Gap:
  - Contract/implementation mismatch in a core temporal method.
- Recommended fix:
  - Persist canonical key metadata (`_key`) on write path and filter strictly by that key prefix.
  - Add targeted tests that include mixed keys and assert exclusion behavior.

## High

### H1. Encryption rotates records with synthetic keys because original key is not reliably persisted

- Evidence:
  - Rotation expects `_key` due value-only reads: `src/encryption/encrypted-memory-service.ts:242-249`
  - `put()` does not inject `_key` into stored value: `src/encryption/encrypted-memory-service.ts:133-170`
- Impact:
  - Rotation can create new records (`rotated_0`, `rotated_1`, ...) rather than replacing originals.
  - Data duplication and stale encrypted copies possible.
- Gap:
  - Key-rotation correctness depends on optional caller payload conventions.
- Recommended fix:
  - Persist immutable key metadata in every encrypted record.
  - Use key-preserving record API for rotation and add idempotence tests.

### H2. Encryption is fail-open when active key is missing

- Evidence:
  - Plaintext fallback: `src/encryption/encrypted-memory-service.ts:143-147`
- Impact:
  - Misconfiguration can silently store sensitive data unencrypted.
  - High operational security risk.
- Gap:
  - No strict mode for production posture.
- Recommended fix:
  - Add `encryptionMode: "strict" | "best-effort"` (default strict for production).
  - Emit explicit security events/metrics on fallback.

### H3. In-memory store semantics diverge from production store semantics

- Evidence:
  - `InMemoryBaseStore.search()` ignores query/filter/limit options and only uses namespace prefix: `src/store-factory.ts:68-79`
  - Prefix matching via `startsWith`: `src/store-factory.ts:72`
- Impact:
  - Behavior under tests/dev can differ from Postgres behavior.
  - Bugs in search filtering and pagination can be missed pre-production.
- Gap:
  - Local backend is not parity-safe.
- Recommended fix:
  - Support `query`, `limit`, and `filter` in in-memory search path.
  - Use segment-aware prefix matching (tuple semantics), not raw string prefix.

### H4. Working memory updates are not concurrency-safe across writers

- Evidence:
  - Blind read-modify-write update:
    - `working-memory.ts:90-113`
    - `versioned-working-memory.ts:173-241`
  - No CAS/ETag/version precondition on store writes.
- Impact:
  - Concurrent updates can overwrite each other (lost updates).
- Gap:
  - Single-writer assumption is implicit and undocumented.
- Recommended fix:
  - Add optimistic concurrency control (expected version on put) or CRDT-backed state merge strategy.

## Medium

### M1. Heavy non-fatal error swallowing limits observability

- Evidence:
  - Many explicit non-fatal paths and empty catches across core flows (example: `memory-service.ts:140-142`, `247-249`; similar pattern is widespread).
- Impact:
  - Failures become difficult to diagnose in production.
- Gap:
  - Reliability and SLO management lack first-class telemetry.
- Recommended fix:
  - Add optional telemetry hooks (`onError`, event bus, counters) at service boundaries.
  - Preserve non-fatal behavior but expose structured error signals.

### M2. Shared-space retention/compaction key targeting is brittle

- Evidence:
  - Prune/compact uses synthesized key fallback:
    - `memory-space-manager.ts:422-429`
    - `memory-space-manager.ts:488-489`
    - fallback function `keyFromValue`: `memory-space-manager.ts:736-739`
- Impact:
  - Compaction and pruning can miss intended records if `_key` is absent.
- Gap:
  - Lifecycle correctness relies on implicit payload shape.
- Recommended fix:
  - Make `_key` required for stored records in shared space, or migrate to key-preserving service API.

### M3. Sync conflict stats are declared but never updated

- Evidence:
  - Field exists: `sync-session.ts:31`
  - Returned in stats: `sync-session.ts:139`
  - Conflict event currently hardcoded as `0`: `sync-session.ts:227`
- Impact:
  - Reported sync stats underrepresent conflict behavior.
- Gap:
  - Operational metrics incomplete.
- Recommended fix:
  - Propagate conflict counts from merge reports into `_conflicts` and emitted events.

### M4. MCP adapter uses static default scope for all requests and lacks per-request principal model

- Evidence:
  - All handlers use `this.services.defaultScope`: `mcp-memory-server.ts:313-315`, `334`, `344`, `353`, `361`, `375`, etc.
- Impact:
  - Fine-grained authz is left entirely to outer layers; high integration risk if miswired.
- Gap:
  - No built-in principal-aware policy hook at adapter layer.
- Recommended fix:
  - Add optional `authorize(tool, principal, namespace, scope)` callback in handler config.
  - Allow contextual scope resolution per request.

## 5. Testing Posture and Gaps

What is strong:
- Broad unit tests across most major modules.
- Retrieval, sharing, temporal, encryption, and MCP paths are all exercised.

What is missing / under-specified:
1. No direct coverage for `store-factory` packaging/runtime dependency behavior.
2. Temporal history tests currently validate merged-history behavior but not strict `keyPrefix` filtering contract.
3. Lifecycle correctness tests depend on value-embedded key conventions; they do not enforce a package-wide canonical key model.

## 6. Suggested Feature Roadmap

## Near-Term (High ROI, 1-2 sprints)

1. **Record Envelope API v2**
   - Add key-preserving read/search APIs.
   - Migrate internal modules (temporal, provenance, sharing, encryption rotation, MCP health) to these APIs.

2. **Strict Encryption Modes**
   - Introduce fail-closed option and telemetry for key-provider failures.
   - Add rotation idempotence and duplicate-prevention guarantees.

3. **Temporal Correctness Upgrade**
   - Implement true key-prefix filtering with deterministic key metadata.
   - Add explicit tests for mixed-key namespaces.

4. **InMemory Store Parity**
   - Implement option-aware search (`query`, `limit`, `filter`) and tuple-safe prefixing.

## Mid-Term (Platform Maturity, 2-4 sprints)

5. **Optimistic Concurrency for Working Memory**
   - Add `expectedVersion` precondition writes or merge conflict callbacks.
   - Surface deterministic conflict responses.

6. **Observability Layer**
   - Unified event model for non-fatal failures, write rejections, retention actions, compaction stats, and sync health.
   - Optional OpenTelemetry span/counter integration.

7. **Policy Engine v2**
   - Support contextual policies (namespace, tenant, principal, sensitivity class).
   - Structured reject reasons for downstream workflows.

8. **MCP Principal-Aware Guardrails**
   - Request-context identity input + built-in policy hook for tool-level authorization.

## Longer-Term (Differentiating Features)

9. **Tiered Memory Lifecycle**
   - Hot/warm/cold tiers, archival snapshots, replayable restore.

10. **Retrieval Quality Control Loop**
   - Built-in offline eval harness for intent routing and fusion quality.
   - Automated weight adaptation with guardrails by namespace/domain.

11. **Background Maintenance Scheduler**
   - Unified scheduling for consolidation, staleness pruning, tombstone compaction, key rotation, and temporal cleanup.

## 7. Prioritized Action Plan

1. Fix key-model inconsistency first (`C2`) because it cascades into temporal, encryption, provenance, and sharing correctness.
2. Resolve temporal history contract mismatch (`C3`) to prevent incorrect recall behavior.
3. Harden encryption behavior (`H1`, `H2`) for secure production defaults.
4. Address packaging/runtime dependency safety (`C1`) before wider external adoption.
5. Add in-memory parity and observability to reduce hidden production surprises (`H3`, `M1`).

---

Overall assessment: **functionally rich and well-tested**, but **needs a consistent key/record model and stricter operational safeguards** to be production-robust at scale.
