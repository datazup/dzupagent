# @dzupagent/connectors - Implementation Analysis and Gap Report

Date: 2026-04-03  
Scope: `packages/connectors` in the current repository state

## 1. Executive Summary

`@dzupagent/connectors` has evolved into two distinct layers:

1. Service/API connectors (`github`, `http`, `slack`, `database`) that expose LangChain `DynamicStructuredTool` tools.
2. A significantly larger unified SQL subsystem (`sql/*`) with eight dialect adapters and schema-discovery orchestration.

The package is functionally rich and well-tested at the unit level (188 tests passing), but there are important safety and consistency gaps:

1. Read-only protections are inconsistent across database paths and can be bypassed in some flows.
2. The package exposes two parallel DB abstractions (`database` and `sql`) with overlapping capability and divergent behavior.
3. Schema discovery correctness varies by adapter (schema argument ignored in several adapters during sample-value retrieval).
4. Runtime behavior is stronger than package docs, but docs are stale and partially inaccurate.

## 2. Method and Inputs

Analysis was based on:

1. Source review of all `packages/connectors/src/**` modules.
2. Test suite review across `src/__tests__` and `src/sql/__tests__`.
3. Build/runtime config review (`package.json`, `tsup.config.ts`, `vitest.config.ts`).
4. Validation run:
   `yarn workspace @dzupagent/connectors test` -> 12 test files, 188 tests passed.

## 3. Current Implementation Snapshot

### 3.1 Package Shape

- Source files: 42 TypeScript files under `src/`.
- Non-test source LOC (approx): 5,303 lines.
- Test files: 12.

### 3.2 Connector Inventory

| Area | Main Entry | Surface | Notes |
|---|---|---|---|
| GitHub | `src/github/github-connector.ts` | 17 tools | Strong issue/PR/repo coverage, string-first outputs |
| HTTP | `src/http/http-connector.ts` | 1 tool (`http_request`) | Includes origin lock SSRF protection and timeout |
| Slack | `src/slack/slack-connector.ts` | 3 tools | Basic messaging/channel/search operations |
| Database (legacy-ish) | `src/database/db-connector.ts` | 3 tools | PostgreSQL-oriented API with lazy `pg` loading |
| SQL unified | `src/sql/*` | 6 tool wrappers + 8 dialect adapters | Most complex subsystem (query + schema discovery + DDL) |

### 3.3 Architecture Highlights

1. `src/connector-contract.ts` introduces a normalized connector tool contract (`normalizeConnectorTool(s)`), enabling abstraction over LangChain tool objects.
2. SQL layer uses `BaseSQLConnector` for orchestration and per-dialect subclasses for execution/discovery.
3. Several heavy DB drivers are kept external in `tsup` to avoid ESM/CJS bundling runtime issues.
4. Lazy-loading boundaries are explicitly tested in SQL adapter tests.

### 3.4 Strengths

1. Broad capability coverage for SQL databases (PostgreSQL, MySQL, ClickHouse, Snowflake, BigQuery, SQLite, SQL Server, DuckDB).
2. Good test breadth for factories, contracts, SQL orchestration, DDL generation, and connector API behavior.
3. Defensive implementation patterns in many places:
   - HTTP origin restriction for SSRF reduction.
   - Dialect-specific identifier escaping for schema discovery queries.
   - Read-only intent in multiple DB paths.
4. ESM packaging considerations are pragmatic and tested (`scripts/esm-smoke.mjs`).

## 4. Gap Analysis (Risk-Ranked)

## 4.1 High Priority Gaps

### Gap H1: Read-only policy is not uniformly enforceable

Impact:
Potential mutation risk in flows expected to be read-only.

Evidence:

1. `database` connector read-only gate is keyword-regex based (`WRITE_KEYWORDS`) and checks only statement start (`src/database/db-connector.ts:80`, `:236`).
2. SQL tools allow any query beginning with `SELECT` or `WITH` (`src/sql/sql-tools.ts:52`, `:83`), which can allow writable CTE forms in some dialects.
3. SQL Server path sets `READ UNCOMMITTED`, which is an isolation level, not a write prohibition (`src/sql/adapters/sqlserver.ts:114`).
4. BigQuery has explicit `assertReadOnly` (`src/sql/adapters/bigquery.ts:137`, `:346`), but other adapters rely on caller behavior or DB/session settings.

Why this matters:
A connector may be called directly (outside `createSQLTools`), bypassing tool-layer checks. Enforcement should be adapter-level and explicit.

### Gap H2: Schema-scoped discovery is inconsistent across adapters

Impact:
Incorrect sample values for non-default schema/dataset and degraded reliability in multi-schema environments.

Evidence:

1. Several adapters ignore `_schemaName` in `discoverSampleValues` (and in some cases related methods):
   - `src/sql/adapters/bigquery.ts:319`
   - `src/sql/adapters/snowflake.ts:293`
   - `src/sql/adapters/sqlserver.ts:293`
   - `src/sql/adapters/duckdb.ts:248`
2. BigQuery sample queries use connector-level `dataset` fallback rather than the function-provided schema argument.

Why this matters:
The API contract offers schema selection (`SchemaDiscoveryOptions.schemaName`), but behavior is adapter-dependent.

### Gap H3: Dual DB stacks create fragmentation and policy drift

Impact:
Higher maintenance cost, duplicated logic, and inconsistent behavior between `database/*` and `sql/*` surfaces.

Evidence:

1. Legacy DB connector (`db-query`, `db-list-tables`, `db-describe-table`) overlaps materially with SQL tools (`sql-query`, `sql-list-tables`, `sql-describe-table`, plus more).
2. Different read-only logic and result formatting semantics exist across the two paths.

Why this matters:
Security fixes and feature additions must be duplicated or can diverge unintentionally.

## 4.2 Medium Priority Gaps

### Gap M1: Output contracts are inconsistent and mostly string-based

Impact:
Harder downstream parsing, difficult machine policy enforcement, and reduced composability.

Evidence:

1. Many tool funcs return formatted strings while others return JSON strings.
2. Error handling returns plain text in most connectors; no consistent envelope (`ok`, `error`, `data`, `meta`).

### Gap M2: Adapter-level integration tests are limited

Impact:
Runtime regressions may escape despite strong unit test totals.

Evidence:

1. Existing tests are mostly mocked/unit-level; no containerized adapter integration matrix in this package.
2. Coverage thresholds are low (`statements: 40`, `branches: 30`, `functions: 30`, `lines: 40`) in `vitest.config.ts:20-23`.

### Gap M3: Package dependency strategy is heavy for consumers

Impact:
Install size and native-driver friction for users who need only a subset of connectors.

Evidence:

1. Multiple heavy drivers are in direct `dependencies` (`package.json:23+`): `@google-cloud/bigquery`, `snowflake-sdk`, `duckdb`, `better-sqlite3`, `mssql`, `pg`, etc.
2. Code comments often describe optional/lazy semantics, but dependency classification is not optional at install time.

### Gap M4: No centralized resilience controls

Impact:
Rate-limit bursts, transient failures, and upstream instability are handled ad hoc.

Evidence:

1. HTTP connector has timeout support, but GitHub/Slack lack unified retry/backoff/circuit-breaker behavior.
2. No connector-wide telemetry hooks (latency, retries, failures, rate-limit counters).

## 4.3 Low Priority Gaps

### Gap L1: Documentation drift

Impact:
User confusion and incorrect adoption assumptions.

Evidence:

1. README metadata block reports old file counts (`Source Files 10`) while implementation is much larger (`README.md:10`).
2. GitHub quick-start shows `owner/repo` defaults in config (`README.md:62-63`), but `GitHubConnectorConfig` currently only has `token`, `enabledTools`, `baseUrl` (`src/github/github-connector.ts:19`).
3. README emphasizes the older database connector and underrepresents unified SQL subsystem depth.

### Gap L2: API version constant is manually maintained

Impact:
Potential drift between runtime constant and package version metadata.

Evidence:

1. `dzupagent_CONNECTORS_VERSION = '0.2.0'` is hardcoded in `src/index.ts`.

## 5. Suggested Features (Prioritized)

## 5.1 Immediate (0-2 sprints)

### Feature F1: Unified Connector Policy Engine

Goal:
Centralize safety rules for query mutability, domain allowlists, timeout defaults, and output limits.

Minimum scope:

1. Introduce shared policy primitives (read-only SQL validator per dialect, max-rows cap, timeout floor/ceiling).
2. Enforce in both `database/*` and `sql/*` paths.
3. Add strict mode that rejects ambiguous `WITH` statements unless dialect parser confirms read-only.

### Feature F2: Standardized Tool Result Envelope

Goal:
Return consistent structured payloads for all tools.

Proposed shape:

```ts
{
  ok: boolean,
  data?: unknown,
  error?: { code: string; message: string; details?: unknown },
  meta?: { connector: string; tool: string; latencyMs?: number; truncated?: boolean }
}
```

Benefits:
Machine readability, easier observability, and safer downstream automation.

### Feature F3: Schema Consistency Fix Across Adapters

Goal:
Honor `schemaName`/dataset arguments consistently in all schema-discovery methods.

Minimum scope:

1. Fix `discoverSampleValues` (and related discovery calls) where `_schemaName` is ignored.
2. Add adapter-specific tests for non-default schema behavior.

### Feature F4: SQL Server True Read-Only Enforcement

Goal:
Replace isolation-level-only behavior with hard write blocking.

Minimum scope:

1. Add statement classifier at adapter level.
2. Optionally use server-side role/session restrictions where available.

## 5.2 Near Term (1-2 months)

### Feature F5: Real Adapter Integration Test Matrix

Goal:
Add containerized or emulator-backed integration tests per adapter family.

Minimum scope:

1. PostgreSQL/MySQL/SQLServer/ClickHouse/DuckDB local CI matrix.
2. BigQuery/Snowflake smoke tests behind optional credentials gate.
3. Raise coverage thresholds incrementally after integration baseline.

### Feature F6: Connector Resilience Middleware

Goal:
Shared retry/backoff/jitter/rate-limit handling for HTTP-based connectors and API clients.

Minimum scope:

1. Configurable retry policies by status code/error type.
2. Rate-limit awareness for GitHub and Slack (e.g., `429`, API-specific headers).
3. Circuit breaker with short cool-off and fallback error envelope.

### Feature F7: Dependency Footprint Modes

Goal:
Allow lightweight installs when only selected connectors are needed.

Options:

1. Move DB drivers to `optionalDependencies` + runtime guards.
2. Split SQL adapters into subpackages (e.g., `@dzupagent/connectors-sql-postgres`).

## 5.3 Strategic (quarter)

### Feature F8: Connector Capability Registry

Goal:
Expose machine-readable capability metadata for agents and policy systems.

Examples:

1. Mutability (`read`, `write`, `admin`).
2. Data sensitivity class (`public`, `internal`, `restricted`).
3. Cost profile (`cheap`, `expensive`) and expected latency.

### Feature F9: PII-Safe Schema Discovery Controls

Goal:
Avoid accidental sensitive data leakage from sample-value discovery.

Minimum scope:

1. Column-level sampling allow/deny patterns.
2. Masking hooks for email/token/id-like columns.
3. Global sample budget and concurrency caps.

### Feature F10: First-class Observability Hooks

Goal:
Emit unified lifecycle events from all connectors.

Event model:

1. `beforeRequest`
2. `afterResponse`
3. `onError`

With consistent metadata for latency, retries, token/row counts, and truncation.

## 6. Proposed Execution Plan

1. Stabilize safety and correctness first.
   Deliver F1 + F3 + F4 together.
2. Standardize contracts and operations.
   Deliver F2 + F6 to make behavior predictable and observable.
3. Reduce operational and adoption friction.
   Deliver F5 + F7, then F8/F9/F10.

## 7. Practical Refactor Path

1. Mark `database/*` as compatibility layer.
2. Re-implement `db-*` tools as wrappers over unified SQL interfaces.
3. Keep legacy tool names for backward compatibility while sharing one enforcement and telemetry core.
4. Remove duplicate logic after one deprecation cycle.

## 8. Verification Status

Command executed:

```bash
yarn workspace @dzupagent/connectors test
```

Result:

1. 12 test files passed.
2. 188 tests passed.
3. No failing tests at analysis time.

## 9. Bottom Line

The package has strong breadth and a solid foundation, especially in the unified SQL layer, but it now needs a focused hardening phase:

1. Make safety guarantees explicit and adapter-enforced.
2. Unify duplicate database paths.
3. Standardize tool output contracts and resilience behavior.
4. Align docs and dependency strategy with real implementation scale.
