# 13. Data Model and Migrations

## Repository Overview
This review covers the `dzupagent` monorepo, with primary focus on persistence and migration behavior in `packages/server`, plus related durable data surfaces in `packages/memory`, `packages/agent-adapters`, and `packages/cache`.  
The repo has a real PostgreSQL schema layer (`drizzle-schema.ts`) and SQL migration files, but also relies on Redis-backed queue/cache components and filesystem-backed artifacts/checkpoints.  
Secondary artifacts under `out/` were reviewed for context, but code in the local repository was treated as source of truth where inconsistencies existed.

## Data Surface
Primary data surfaces and ownership boundaries:

- PostgreSQL schema defined in `packages/server/src/persistence/drizzle-schema.ts` with tables for runs (`forge_runs`, `forge_run_logs`), trace data (`run_traces`, `trace_steps`), mailbox/DLQ (`agent_mailbox`, `agent_mail_dlq`), A2A tasks (`a2a_tasks`, `a2a_task_messages`), vectors (`forge_vectors`), API keys (`api_keys`), catalog/cluster data, schedules/triggers, reflections, and deployment history.
- SQL migrations in `packages/server/drizzle/`: `0001_agent_mail_dlq.sql`, `0002_run_status_halted.sql`, `0003_run_artifacts_api_keys.sql`.
- Migration metadata exists but is not populated: `packages/server/drizzle/meta/_journal.json` contains `entries: []`.
- Server package scripts provide `db:generate` and `db:push`; there is no dedicated migration-apply script in `packages/server/package.json`.
- Queue durability is Redis/BullMQ in `packages/server/src/queue/bullmq-run-queue.ts`.
- Cache durability can be Redis or in-memory via `packages/cache/src/backends/redis.ts` and `packages/cache/src/backends/in-memory.ts`.
- Memory service can use LangGraph PostgresStore or in-memory (`packages/memory/src/store-factory.ts`), with Redis-based provenance tracking (`packages/memory/src/provenance/redis-reference-tracker.ts`).
- Filesystem durability exists for run events and checkpoints:
  - `.dzupagent/runs/<runId>/...` via `packages/agent-adapters/src/runs/run-event-store.ts`.
  - Checkpoint version files via `packages/agent-adapters/src/persistence/persistent-checkpoint-store.ts`.
- Several runtime surfaces remain in-memory only in this repo (for example prompt/persona/eval/benchmark stores), which affects restart durability and operational expectations.

## Strong Areas
- The schema is broad and explicit, with generally clear table naming and data domain separation.
- Important integrity rules are already present in several places:
  - FK + cascade on many child tables (for example `forge_run_logs.run_id`, `trace_steps.run_id`, `cluster_roles.cluster_id`, `a2a_task_messages.task_id`).
  - Uniqueness where needed (for example `forge_vectors(collection,key)`, `agent_catalog.slug`, `api_keys.key_hash`).
- Migrations are written to be additive/idempotent (`IF NOT EXISTS`), reducing accidental breakage during repeated apply attempts.
- API key storage is implemented with hash-only persistence and revocation/expiry fields, which is a sound security data model baseline.
- DLQ modeling is present for mailbox reliability, with retry/backoff semantics and dead-letter marking.
- In-memory stores include explicit retention caps and explicit-unbounded warnings in multiple modules, which is better than silent unbounded growth defaults.

## Findings
1. **High: Migration source-of-truth is incomplete and drift-prone**
Evidence: schema defines many operational tables in `drizzle-schema.ts`, but only three SQL migration files exist and `_journal.json` has no entries.  
Evidence: package scripts expose `db:push` and `db:generate` but no explicit migration-apply workflow.  
Risk: fresh/prod environments can diverge, rollback becomes unsafe, and it is difficult to prove deterministic schema state across deployments.

2. **High: Core relational integrity is inconsistent for run-adjacent data**
Evidence: `run_traces.run_id` and `run_reflections.run_id` are `varchar` keys with no FK to `forge_runs.id` (`uuid`).  
Evidence: `trigger_configs.agent_id` and some other ownership fields are stored as plain text without FK constraints.  
Risk: orphaned records, broken lifecycle cleanup, and analytics inconsistency when parent rows are removed or IDs change shape.

3. **High: Multi-step persistence paths are non-transactional in correctness-sensitive flows**
Evidence: `DrizzleRunTraceStore.addStep` performs read current step count, insert step, then update header in separate operations.  
Evidence: `DrizzleRunTraceStore.startTrace` performs delete/delete/insert sequence without transaction boundaries.  
Evidence: DLQ redelivery paths move data across tables with separate statements and caller-managed atomicity.  
Risk: partial writes and race conditions can corrupt ordering/counters or produce duplicate/lost transitions under concurrency or intermittent failure.

4. **Medium-High: Query patterns and indexes are misaligned on hot tables**
Evidence: `PostgresRunStore.getLogs` filters by `run_id` and orders by `timestamp`, but schema has no composite index on `(run_id, timestamp)`.  
Evidence: run listing/count frequently filters by `agent_id` and sorts by `started_at`, but schema indexing for these patterns is limited (`status` index was added in migration 0002).  
Evidence: A2A list/filter paths sort/filter by `created_at`/`state`/`agent_name` with limited indexing.  
Risk: high-latency scans, unstable p95/p99 behavior as row counts grow, and increased lock pressure during migrations/backfills.

5. **Medium-High: Vector persistence is modeled, but production index/extension safety is under-specified**
Evidence: vector columns are used (`vector(1536)`), and code explicitly notes pgvector extension requirement in `vector-column.ts`.  
Evidence: no migration in `packages/server/drizzle` creates `CREATE EXTENSION IF NOT EXISTS vector`; tests do this manually.  
Evidence: schema comments mention ANN acceleration intent, but no explicit ANN index migration is present for `forge_vectors.embedding`.  
Risk: runtime failures in environments missing extension, and expensive nearest-neighbor queries at scale.

6. **Medium: Retention and cleanup policy is fragmented**
Evidence: mailbox TTL cleanup exists (`deleteExpired`) but no production caller is visible in `packages/server/src` outside tests/definition.  
Evidence: run-event and checkpoint files are persisted on disk without centralized retention/sweeper policy.  
Evidence: many long-lived tables (runs/logs/traces/history) have no repo-level retention enforcement strategy.  
Risk: unbounded storage growth, slower backups/restores, and unclear legal/compliance retention posture.

7. **Medium: Persistence failure handling often degrades silently**
Evidence: `RunEventStore` catches disk write errors and only logs warnings; it never throws to caller.  
Evidence: `MemoryService` intentionally swallows write/read/search errors and returns empty/fallback behavior.  
Risk: data loss and observability blind spots, especially for audit/replay use cases where silent drops are materially harmful.

8. **Low-Medium: Schema/model ownership drift is visible**
Evidence: `run_artifacts` table and migration exist, but no active read/write usage was found under `packages/server/src` beyond schema definition comments.  
Risk: dead schema surface increases maintenance burden and can mislead operators about what is truly persisted.

## Data Lifecycle Review
Creation and mutation:
- Runs and logs are created via `PostgresRunStore`; trace headers/steps are managed separately in trace stores.
- A2A tasks/messages and mailbox/DLQ have dedicated stores with clear write APIs.
- Vectors are upserted row-by-row in `DrizzleVectorStore`, with collection/key uniqueness for idempotent overwrite behavior.
- API keys are created with one-time raw secret exposure and hash-at-rest model.

Retention and cleanup:
- TTL is explicit for mailbox rows but cleanup execution is not centrally scheduled in this repo.
- DLQ records progress through retry/dead states, but dead-entry purge policy is not centrally defined.
- Filesystem artifacts and checkpoints persist indefinitely unless external cleanup is applied.
- Memory namespaces include `ttlMs` metadata in types, but store-level TTL enforcement is explicitly not guaranteed.

Auditability and replay:
- The system has multiple audit-like sources (run logs, run traces, JSONL run events), which is a strength.
- Non-transactional write paths and silent error swallowing weaken forensic guarantees.
- Mixed time representations (`timestamp` vs epoch-ms integers) increase operational complexity for cross-surface audits.

Export/import:
- Memory AgentFile import/export exists, with versioned format (`1.0.0`) and optional signature verification.
- Import supports skip/overwrite/merge strategies, but no explicit transactional batch boundary is enforced for multi-record imports.
- Export/import portability is good, but consistency guarantees are best-effort.

## Schema Evolution Risk
Backwards compatibility:
- `forge_runs.status` is intentionally free-form (`varchar(30)`), and migration 0002 notes no DB check constraint. This improves short-term flexibility but weakens contract safety for rolling upgrades and cross-service readers.
- JSONB-heavy metadata fields are flexible but require disciplined versioning to avoid schema-by-convention drift.

Rollout safety:
- Migration history does not currently represent full schema evolution in-repo, making safe rollout/rollback validation harder.
- Direct `db:push` workflows increase risk of environment-specific drift compared with immutable migration application.

Indexing and performance evolution:
- Some essential indexes are present, but notable hot-path gaps remain.
- Vector search evolution risk is high without explicit extension bootstrap and ANN indexing plan.

Nullability/type consistency:
- Mixed ID and time encodings across related surfaces (`uuid` vs `varchar`, `timestamp` vs integer epoch-ms) complicate joins, constraints, and backfills.
- Lack of FK constraints on several ownership links increases orphan risk during deletes or ID evolution.

Operational hazards:
- Non-transactional multi-step writes in trace and message-retry flows are vulnerable during partial failures and concurrent updates.
- Data lifecycle controls are not uniformly enforced, increasing long-term operational debt.

## Recommended Improvements
1. Establish a single migration contract for production.
   - Create and commit a baseline migration representing current full schema.
   - Populate/maintain Drizzle migration metadata consistently.
   - Treat `db:push` as dev-only and add explicit migration apply/check scripts for CI/CD.

2. Add missing relational constraints for core ownership links.
   - Align ID types where possible (`uuid` for run-linked tables).
   - Add FKs from `run_traces`/`run_reflections` to `forge_runs` where lifecycle coupling is intended.
   - Add FK/constraint strategy for trigger/schedule ownership fields where domain semantics are stable.

3. Make critical multi-statement writes transactional.
   - Wrap `startTrace`, `addStep`, and similar read-modify-write patterns in DB transactions.
   - Apply transactional move semantics for DLQ redelivery and mailbox handoff.

4. Close index gaps based on actual query patterns.
   - Add composite index for run logs retrieval (`run_id`, `timestamp`).
   - Add run-listing indexes for (`agent_id`, `started_at`) and any dominant dashboard filters.
   - Add A2A/task list indexes aligned with `state`, `agent_name`, `created_at`.
   - Add reflection listing index on `completed_at`.

5. Harden vector migration and search readiness.
   - Add migration step for `CREATE EXTENSION IF NOT EXISTS vector`.
   - Add explicit ANN index migration strategy for `forge_vectors.embedding` (metric-aligned HNSW/IVFFlat).

6. Define and enforce retention classes.
   - Introduce scheduled cleanup for mailbox TTL and dead DLQ entries.
   - Define retention windows for runs/logs/traces/deployment history and filesystem artifacts/checkpoints.
   - Add metrics for cleanup lag and deletion outcomes.

7. Improve persistence observability and failure semantics.
   - Emit structured degraded-operation events when writes are dropped.
   - Reserve silent-swallow behavior for explicitly non-critical paths only.
   - Document which stores are authoritative vs best-effort.

8. Resolve schema ownership drift.
   - Either implement real `run_artifacts` read/write paths or remove/deprecate that table.
   - Keep comments/endpoints synchronized with actual persistence code paths.

## Overall Assessment
The repository has a substantial and useful persistence foundation, but migration governance and structural integrity controls are not yet at a fully production-safe maturity level.  
Data-model health is currently **moderate**: good breadth and intent, but elevated risk around schema evolution reproducibility, referential consistency, transactional correctness, and long-term lifecycle management.