# @dzupagent/connectors Architecture

## Scope
This document covers the current implementation of `@dzupagent/connectors` in:

- `packages/connectors/src`
- `packages/connectors/package.json`
- `packages/connectors/README.md`
- `packages/connectors/scripts/esm-smoke.mjs`
- `packages/connectors/vitest.config.ts`

It describes what is implemented in code today, including public exports from `src/index.ts`, internal modules under `src/`, SQL dialect adapters, and test/packaging behavior.

## Responsibilities
`@dzupagent/connectors` provides integration-facing tool surfaces for DzupAgent by converting external capabilities into LangChain `DynamicStructuredTool` instances.

Primary responsibilities:

- Provide prebuilt connector factories for GitHub, HTTP, Slack, and PostgreSQL-oriented database operations.
- Provide a unified SQL subsystem (`src/sql/*`) for multi-dialect query execution, schema discovery, and DDL generation.
- Provide connector contract normalization utilities (`normalizeConnectorTool(s)`) on top of `@dzupagent/core` base connector types.
- Provide toolkit wrappers (`create*ConnectorToolkit`) that package connector tools with connector metadata.
- Provide async resolver implementations for Stage 3 semantic resolution (`MCPAsyncToolResolver`, `AgentRegistryAsyncToolResolver`) in package source.

## Structure
Top-level source layout:

- `src/index.ts`: public package barrel exports.
- `src/connector-types.ts`: legacy connector interfaces and `filterTools` helper.
- `src/connector-contract.ts`: `ConnectorToolkit`, `ConnectorFactory`, `ConnectorToolLike`, normalization helpers.
- `src/github/*`: GitHub REST client and connector toolkit/factory.
- `src/http/*`: generic HTTP connector.
- `src/slack/*`: Slack connector.
- `src/database/*`: PostgreSQL-focused connector + operations API.
- `src/sql/*`: unified SQL types, base class, tools, factory, DDL, adapters.
- `src/mcp-tool-resolver.ts`: async MCP-backed tool resolver.
- `src/agent-registry-resolver.ts`: async HTTP-backed agent resolver with TTL cache.

Public exports from `src/index.ts` include:

- Connector/toolkit contracts and normalization helpers.
- GitHub, HTTP, Slack, Database connectors and related types.
- Unified SQL APIs: `createSQLConnector`, `createSQLTools`, `BaseSQLConnector`, `generateDDL`, all 8 adapters, and SQL types.
- `dzupagent_CONNECTORS_VERSION` constant (currently `'0.2.0'`).

`src/index.ts` currently does not export:

- `MCPAsyncToolResolver`
- `AgentRegistryAsyncToolResolver`

## Runtime and Control Flow
### 1) Connector creation flow
1. Consumer calls `createGitHubConnector`, `createHTTPConnector`, `createSlackConnector`, `createDatabaseConnector`, or `createSQLTools`.
2. Factory creates one or more `DynamicStructuredTool` instances with `zod` schemas.
3. Optional `enabledTools` filtering is applied via `filterTools`.
4. Agent/runtime invokes tool `func`; tool delegates to external API/DB SDK and returns string/JSON-string results.

### 2) Toolkit flow
1. Consumer calls `create*ConnectorToolkit` variant.
2. Toolkit object returns `{ name, tools, enabledTools? }`.
3. Consumer can combine multiple toolkit outputs into final agent tool set.

### 3) GitHub connector flow
1. `createGitHubConnector` constructs `GitHubClient`.
2. `GitHubClient` executes REST calls with token auth (`Authorization`, `Accept`, `X-GitHub-Api-Version`).
3. Connector methods wrap client calls in `safe(...)`; `GitHubApiError` is converted to user-facing error strings.
4. Tool set currently includes 22 operations:
   - `github_get_file`, `github_list_issues`, `github_get_issue`, `github_create_issue`, `github_update_issue`, `github_add_comment`
   - `github_list_prs`, `github_get_pr`, `github_create_pr`, `github_merge_pr`, `github_list_pr_reviews`, `github_create_pr_review`, `github_get_pr_checks`
   - `github_get_repo`, `github_list_branches`, `github_get_commit`, `github_compare_commits`
   - `github_add_labels`, `github_remove_label`, `github_create_review_comment`, `github_get_workflow_runs`, `github_search_code`

### 4) HTTP connector flow
1. `http_request` builds `new URL(path, baseUrl)`.
2. Origin lock rejects requests escaping configured base origin.
3. Allowed method set is enforced.
4. `AbortController` timeout is applied (default `30_000ms`).
5. Output is returned as text status + truncated body (max 5000 chars).

### 5) Slack connector flow
1. Tools call Slack Web API endpoints via `fetch` to `https://slack.com/api/*`.
2. Bearer token auth and JSON payload are used.
3. Tool outputs are formatted as success/error strings.
4. Exposed tools: `slack_send_message`, `slack_list_channels`, `slack_search_messages`.

### 6) PostgreSQL-oriented database connector flow (`src/database`)
1. Connector lazily creates operations on first call.
2. If `config.query` is supplied, custom executor is used; otherwise `pg` pool is created lazily via dynamic import.
3. `createDatabaseOperations` enforces optional read-only mode via leading-keyword guard and wraps SELECT-like statements with limit if no `LIMIT` exists.
4. Exposed tools:
   - `db-query`
   - `db-list-tables`
   - `db-describe-table`
5. Programmatic API `createDatabaseOperations` also exposes `query`, `listTables`, `describeTable`, `getTableInfo`, `healthCheck`, `close`.

### 7) Unified SQL subsystem flow (`src/sql`)
1. `createSQLConnector(databaseType, config)` instantiates one of 8 adapters:
   - `PostgreSQLConnector`, `MySQLConnector`, `ClickHouseConnector`, `SnowflakeConnector`, `BigQueryConnector`, `SQLiteConnector`, `SQLServerConnector`, `DuckDBConnector`.
2. All adapters implement `SQLConnector` via `BaseSQLConnector`.
3. Shared base discovery flow:
   - discover table list
   - apply include/exclude filters
   - enrich each table with columns, foreign keys, row count estimate, sample values
4. `createSQLTools` wraps a `SQLConnector` into 6 tools:
   - `sql-query` (AST-based read-only check via `node-sql-parser`)
   - `sql-list-tables`
   - `sql-describe-table`
   - `sql-discover-schema`
   - `sql-generate-ddl`
   - `sql-test-connection`
5. DDL generation routes by dialect with specific quoting/PK/FK behavior in `ddl-generator.ts`.

### 8) Async resolver control flow
`MCPAsyncToolResolver`:

1. Caches tool refs from `MCPClient.getEagerTools()` and `getDeferredToolNames()`.
2. Refreshes cache on TTL expiry (default `60_000ms`) or explicit `refreshCatalogue()`.
3. `resolve(ref)` parses `server/tool` refs, resolves via `findTool`, and invokes via `client.invokeTool`.
4. Returns `null` for unknown refs and throws for infra failures.

`AgentRegistryAsyncToolResolver`:

1. Loads and caches remote agent catalogue from HTTP endpoint (`/agents`) with TTL.
2. Falls back to point lookup (`/agents/{id}`) when cache misses.
3. Builds `AgentHandle` invoking `/agents/{id}/invoke`.
4. Preserves contract: unknown refs map to `null`; infra failures throw.

## Key APIs and Types
Core package-level exports:

- `filterTools(tools, enabledTools?)`
- `isConnectorTool`, `normalizeConnectorTool`, `normalizeConnectorTools`
- `createGitHubConnector`, `createGitHubConnectorToolkit`, `GitHubClient`, `GitHubApiError`
- `createHTTPConnector`, `createHttpConnectorToolkit`
- `createSlackConnector`, `createSlackConnectorToolkit`
- `createDatabaseConnector`, `createDatabaseOperations`, `createDatabaseConnectorToolkit`
- `createSQLConnector`, `createSQLTools`, `BaseSQLConnector`, `generateDDL`
- SQL adapter classes for all supported dialects

Important types:

- `ConnectorToolkit`, `ConnectorFactory`, `ConnectorToolLike`
- `DatabaseConnectorConfig`, `DatabaseOperations`, `QueryResult` (database path)
- `SQLDialect`, `DatabaseType`, `SQLConnectionConfig`, `QueryExecutionOptions`, `QueryResultData`, `DatabaseSchema`, `TableSchema`, `SchemaDiscoveryOptions`, `SQLConnector`

Internal-only (present in source, not exported in package root barrel):

- `MCPAsyncToolResolver`
- `AgentRegistryAsyncToolResolver`

## Dependencies
Direct runtime dependencies in `package.json`:

- `@dzupagent/core`
- `node-sql-parser`
- SQL/DB drivers: `pg`, `mysql2`, `@clickhouse/client`, `snowflake-sdk`, `@google-cloud/bigquery`, `better-sqlite3`, `mssql`, `duckdb`

Peer dependencies:

- `@langchain/core` (tool interfaces)
- `zod` (schemas)

Build/runtime packaging behavior:

- ESM output via `tsup` (`target: node20`).
- Heavy DB drivers are marked external to avoid CJS-in-ESM runtime failures.
- `scripts/esm-smoke.mjs` validates dist imports and key connector construction paths (mysql/postgresql/clickhouse).

## Integration Points
Internal package integrations:

- `@dzupagent/core`: base connector tool normalization and MCP types.
- `@dzupagent/flow-ast`: `AsyncToolResolver` / `ResolvedTool` contracts for resolver classes.

External system integrations:

- GitHub REST API (`https://api.github.com` by default; configurable base URL).
- Slack Web API (`https://slack.com/api`).
- Arbitrary HTTP APIs constrained by connector base origin.
- Databases via adapter-specific drivers:
  - PostgreSQL (`pg`)
  - MySQL (`mysql2/promise`)
  - ClickHouse (`@clickhouse/client`)
  - Snowflake (`snowflake-sdk`)
  - BigQuery (`@google-cloud/bigquery`)
  - SQLite (`better-sqlite3`)
  - SQL Server (`mssql`)
  - DuckDB (`duckdb`)

## Testing and Observability
Test surface (Vitest):

- Connector and contract tests under `src/__tests__`.
- SQL subsystem tests under `src/sql/__tests__`.
- Resolver tests for MCP and Agent Registry async resolvers.
- Extended/branch-focused suites for GitHub, HTTP, Slack, SQL tools, and DB connector behavior.

Current test config (`vitest.config.ts`):

- Node environment, timeout `30_000ms`.
- Coverage provider `v8` with low thresholds:
  - statements `40`
  - branches `30`
  - functions `30`
  - lines `40`

Observability in implementation:

- No centralized telemetry/metrics integration in this package.
- Most connector failures are returned as user-facing error strings (or JSON-string error objects in SQL tools).
- SQL tool/query results include truncation and row metadata where applicable.

## Risks and TODOs
- Version constant is aligned: `src/index.ts` exports `dzupagent_CONNECTORS_VERSION = '0.2.0'`, matching package version `0.2.0`.
- Export-surface ambiguity: resolver modules are implemented and tested but not exported via package root barrel.
- Read-only policy inconsistency across DB paths: enforcement differs between `src/database` and SQL adapters/tools.
- Mixed output contracts: connector tools return a mix of plain text and JSON strings, complicating uniform downstream parsing.
- Driver packaging trade-off: many heavy DB drivers are direct dependencies even though several adapter loaders treat them as optional/lazy.
- README drift: generated package stats and some examples do not fully reflect current source surface.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
