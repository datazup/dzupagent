# @dzupagent/connectors Architecture

## Scope
This document reflects the current implementation under `packages/connectors`:

- `src/` (connector factories, SQL subsystem, resolver modules, and local type shims)
- `package.json` (published API entrypoint, scripts, dependency shape)
- `README.md` (consumer-facing examples and package metadata block)
- `tsup.config.ts` (build output and externalization strategy)
- `vitest.config.ts` and `coverage/coverage-summary.json` (test/coverage configuration and latest local summary artifact)
- `scripts/esm-smoke.mjs` (post-build ESM runtime smoke check)

It describes the package as implemented, not planned.

## Responsibilities
`@dzupagent/connectors` is a connector/tooling package that turns integration capabilities into LangChain `DynamicStructuredTool` arrays and companion toolkit objects.

Current responsibilities:

- Provide service connectors:
- GitHub (`createGitHubConnector`, 22 tools)
- HTTP (`createHTTPConnector`, 1 tool)
- Slack (`createSlackConnector`, 3 tools)
- PostgreSQL-oriented database tools (`createDatabaseConnector`, 3 tools)
- Provide a unified SQL subsystem (`src/sql/*`) for:
- connector instantiation across 8 dialects
- query execution and schema discovery through a shared `SQLConnector` interface
- dialect-aware DDL generation
- LangChain tool wrappers (`createSQLTools`, 6 tools)
- Provide connector contract normalization helpers on top of `@dzupagent/core/tools`:
- `isConnectorTool`
- `normalizeConnectorTool`
- `normalizeConnectorTools`
- Provide toolkit wrappers that return `{ name, tools, enabledTools? }`.
- Include asynchronous resolver implementations in source for Stage 3 flow-ast resolution:
- `MCPAsyncToolResolver`
- `AgentRegistryAsyncToolResolver`

## Structure
Package layout:

- `src/index.ts`
- public package barrel
- exports connector factories, SQL surface, contract helpers, and version constant
- does not export resolver classes
- `src/connector-types.ts`
- `ConnectorConfig`, `Connector`, and `filterTools`
- `src/connector-contract.ts`
- `ConnectorToolkit`, `ConnectorFactory`, tool alias types, normalization bridge to `@dzupagent/core/tools`
- `src/github/`
- `github-client.ts`: typed GitHub REST wrapper with outbound URL policy support
- `github-connector.ts`: 22 `DynamicStructuredTool` definitions
- `src/http/`
- `http-connector.ts`: single generic `http_request` tool with base-origin and allowlist controls
- `src/slack/`
- `slack-connector.ts`: Slack API tool trio
- `src/database/`
- `db-connector.ts`: PostgreSQL-focused operations layer + tool wrappers
- `src/sql/`
- `types.ts`: dialect and schema/query type contracts
- `base-sql-connector.ts`: shared discovery orchestration
- `factory.ts`: dialect-to-adapter mapping
- `sql-tools.ts`: LangChain tool wrappers and SQL read-only guard
- `ddl-generator.ts`: dialect-specific DDL generation
- `adapters/`: `PostgreSQLConnector`, `MySQLConnector`, `ClickHouseConnector`, `SnowflakeConnector`, `BigQueryConnector`, `SQLiteConnector`, `SQLServerConnector`, `DuckDBConnector`
- `src/mcp-tool-resolver.ts`
- async MCP-backed resolver with TTL-based catalogue refresh
- `src/agent-registry-resolver.ts`
- async HTTP registry-backed resolver with TTL cache and point lookups
- `src/types/*.d.ts` and `src/pg.d.ts`
- minimal ambient declarations for driver typing compatibility

## Runtime and Control Flow
1. Connector/toolkit creation:
- Consumer calls a `create*Connector` function to get `DynamicStructuredTool[]`, or a `create*Toolkit` function to get `{ name, tools, enabledTools? }`.
- `filterTools` applies optional allowlists by tool name.
2. GitHub connector:
- `createGitHubConnector` builds `GitHubClient` with token, optional base URL, and optional outbound URL policy.
- `GitHubClient.request` uses `fetchWithOutboundUrlPolicy`.
- Tool functions wrap calls with `safe(...)` and return either formatted success payloads or user-readable error text.
3. HTTP connector:
- Validates `baseUrl` protocol/host.
- Builds a policy + custom fetch that enforces base origin with optional explicit host allowlist.
- `http_request` supports `GET|POST|PUT|PATCH|DELETE`, request timeout, and response truncation to 5000 chars.
4. Slack connector:
- Calls `https://slack.com/api/*` via `fetchWithOutboundUrlPolicy`.
- Exposes `slack_send_message`, `slack_list_channels`, `slack_search_messages`.
5. Database connector (`src/database/db-connector.ts`):
- Lazily initializes operations.
- Uses custom `query` executor when provided; otherwise lazily imports `pg` and creates a pool.
- Read-only behavior is regex-based (`WRITE_KEYWORDS`) and SELECT-like queries without `LIMIT` are wrapped to enforce max rows.
- Exposes tools: `db-query`, `db-list-tables`, `db-describe-table`.
- Programmatic operations surface: `query`, `listTables`, `describeTable`, `getTableInfo`, `healthCheck`, `close`.
6. Unified SQL subsystem:
- `createSQLConnector(databaseType, config)` instantiates one dialect adapter.
- Each adapter implements `SQLConnector` (query/test/schema/destroy) and extends `BaseSQLConnector`.
- `BaseSQLConnector.discoverSchema` orchestrates table discovery, include/exclude filtering, per-table enrichment (columns, FKs, row estimate, sample values), and timestamps.
- `createSQLTools` wraps a `SQLConnector` into:
- `sql-query`
- `sql-list-tables`
- `sql-describe-table`
- `sql-discover-schema`
- `sql-generate-ddl`
- `sql-test-connection`
- `sql-query` enforces read-only by parsing SQL AST with `node-sql-parser` and requiring `select` statements.
7. Resolver modules in source:
- `MCPAsyncToolResolver` caches `server/tool` refs from `MCPClient`, refreshes by TTL, returns `null` for unknown refs, and throws infra errors.
- `AgentRegistryAsyncToolResolver` fetches `/agents`, caches refs/descriptors, falls back to `/agents/{id}`, and creates `AgentHandle` that invokes `/agents/{id}/invoke`.
8. Build/runtime packaging:
- `tsup` emits ESM (`dist/index.js`, d.ts, sourcemaps), target `node20`.
- DB drivers and internal packages are externalized in bundle config.
- `scripts/esm-smoke.mjs` validates dist export presence and basic connector construction paths (`mysql`, `postgresql`, `clickhouse`).

## Key APIs and Types
Public root exports (via `src/index.ts`):

- Connector contracts and helpers:
- `filterTools`
- `isConnectorTool`
- `normalizeConnectorTool`
- `normalizeConnectorTools`
- types: `Connector`, `ConnectorConfig`, `ConnectorToolkit`, `ConnectorFactory`, `ConnectorTool`, `ConnectorToolLike`
- GitHub:
- `createGitHubConnector`, `createGitHubConnectorToolkit`
- `GitHubClient`, `GitHubApiError`
- GitHub request/response/config types
- HTTP:
- `createHTTPConnector`, `createHttpConnectorToolkit`
- `HTTPConnectorConfig`
- Slack:
- `createSlackConnector`, `createSlackConnectorToolkit`
- `SlackConnectorConfig`
- Database:
- `createDatabaseConnector`, `createDatabaseOperations`, `createDatabaseConnectorToolkit`
- `DatabaseConnectorConfig`, `DatabaseOperations`, `QueryResult`, `TableInfo`, `ColumnInfo`
- SQL:
- `createSQLConnector`, `createSQLTools`, `BaseSQLConnector`, `generateDDL`
- adapter classes for all 8 dialects
- core SQL types (`SQLDialect`, `DatabaseType`, `SQLConnectionConfig`, `QueryExecutionOptions`, `QueryResultData`, `ConnectionTestResult`, `DatabaseSchema`, `TableSchema`, `SchemaDiscoveryOptions`, `SQLConnector`, `SQLToolsConfig`)
- Version:
- `dzupagent_CONNECTORS_VERSION = '0.2.0'`

Implemented but not exported from root barrel:

- `MCPAsyncToolResolver`
- `AgentRegistryAsyncToolResolver`

## Dependencies
Runtime dependencies (declared in `package.json`):

- Internal:
- `@dzupagent/core`
- `@dzupagent/flow-ast`
- SQL parser:
- `node-sql-parser`
- Database drivers:
- `pg`
- `mysql2`
- `@clickhouse/client`
- `snowflake-sdk`
- `@google-cloud/bigquery`
- `better-sqlite3`
- `mssql`
- `duckdb`

Peer dependencies:

- `@langchain/core` (tool types/runtime interfaces)
- `zod` (schemas)

Build details:

- ESM-only package output (`type: module`, `exports["."].import = ./dist/index.js`)
- `tsup` external list keeps heavy/cjs-sensitive drivers unbundled
- `build:verified` script runs `yarn build && yarn test:esm-smoke`

## Integration Points
Internal integration points:

- `@dzupagent/core/tools` for canonical connector-tool normalization contracts
- `@dzupagent/core/security` for outbound URL policy-aware fetch behavior
- `@dzupagent/core/pipeline` for MCP and agent handle types used by resolver modules
- `@dzupagent/flow-ast` for `AsyncToolResolver` / `ResolvedTool` interfaces

External integration points:

- GitHub REST API (`https://api.github.com` default; configurable base URL)
- Slack Web API (`https://slack.com/api`)
- Generic HTTP endpoints behind connector base URL policy
- Dialect driver integrations:
- PostgreSQL (`pg`)
- MySQL (`mysql2/promise`)
- ClickHouse (`@clickhouse/client`)
- Snowflake (`snowflake-sdk`)
- BigQuery (`@google-cloud/bigquery`)
- SQLite (`better-sqlite3`)
- SQL Server (`mssql`)
- DuckDB (`duckdb`)
- Remote Agent Registry API (`/agents`, `/agents/{id}`, `/agents/{id}/invoke`) for async registry resolution

## Testing and Observability
Test setup:

- Runner: Vitest (`environment: node`, `testTimeout: 30_000`)
- Include: `src/**/*.test.ts`, `src/**/*.spec.ts`
- Coverage provider: `v8`
- Coverage thresholds configured at:
- statements: 40
- branches: 30
- functions: 30
- lines: 40

Current test surface in source:

- Connector behavior and contracts (`src/__tests__/connectors*.test.ts`, `connector-contract*.test.ts`, `connector-toolkit.test.ts`)
- GitHub/HTTP/Slack/database tool behavior and error branches
- SQL subsystem tests (`src/sql/__tests__/*`) covering adapters, factory, lazy loading, DDL generation, and tool wrappers
- Resolver tests:
- `src/__tests__/mcp-tool-resolver.test.ts`
- `src/__tests__/agent-registry-resolver.test.ts`

Latest local coverage summary file (`coverage/coverage-summary.json`) reports high achieved coverage (about 99% lines/statements, about 97% branches), while configured thresholds remain intentionally low.

Observability characteristics:

- No package-level telemetry, tracing, or metrics emitters.
- Tool outputs are primarily plain strings or JSON strings, including error reporting.
- Resolver modules surface infra errors via thrown exceptions and unknown refs via `null` as contract behavior.

## Risks and TODOs
- Resolver export gap:
- `MCPAsyncToolResolver` and `AgentRegistryAsyncToolResolver` are implemented and tested but not exported from `src/index.ts`.
- Dual database surfaces:
- `src/database/*` and `src/sql/*` overlap functionally and enforce safety differently.
- Read-only enforcement variance:
- SQL tools use AST-based `select` gating; database connector uses leading-keyword regex; adapter-level write protection differs by dialect.
- Output contract inconsistency:
- return values mix plain text and JSON strings across connectors, which complicates strict downstream parsing.
- Dependency weight:
- many heavy drivers are installed as direct dependencies even though adapters use lazy loading/optional runtime guards.
- Documentation drift risk:
- `README.md` generated metrics/examples can diverge from current implementation shape.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

