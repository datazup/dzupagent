# @dzupagent/connectors Architecture

This document describes the current implementation in `packages/connectors` as of April 3, 2026, including architecture, features, and practical usage.

## 1) What This Package Is

`@dzupagent/connectors` is the integration edge of DzupAgent:

- It converts external systems (GitHub, HTTP APIs, Slack, databases) into LangChain `DynamicStructuredTool` tools.
- It exposes two connector families:
1. Service/API connectors (`github`, `http`, `slack`, `database`)
2. Unified SQL connectors (`sql/*`) with 8 dialect adapters and shared schema-discovery + DDL tooling

Primary entrypoint: `src/index.ts`.

## 2) High-Level Architecture

The package is organized into three layers.

1. Core contract and exports:
- `src/index.ts`
- `src/connector-types.ts`
- `src/connector-contract.ts`

2. Service/API connectors:
- `src/github/*`
- `src/http/*`
- `src/slack/*`
- `src/database/*`

3. Unified SQL subsystem:
- `src/sql/types.ts`
- `src/sql/base-sql-connector.ts`
- `src/sql/factory.ts`
- `src/sql/sql-tools.ts`
- `src/sql/ddl-generator.ts`
- `src/sql/adapters/*`

Runtime flow:

1. Consumer calls a `create*Connector(...)` or `createSQLTools(...)` function.
2. Factory returns `DynamicStructuredTool[]`.
3. Optional filtering (`enabledTools` or `filterTools`) narrows exposure.
4. Agent invokes tools through LangChain-compatible interfaces.
5. Connector delegates to service SDK/API and returns string or JSON-string outputs.

## 3) Core Building Blocks

### 3.1 `connector-types.ts`

- Defines a generic `Connector` and `ConnectorConfig` interface.
- Provides `filterTools(tools, enabledTools)` utility to enforce least-privilege tool subsets.

### 3.2 `connector-contract.ts`

Defines a normalized contract for tool interoperability:

- `ConnectorTool` (canonical shape: `id`, `name`, `description`, `schema`, `invoke`, optional `toModelOutput`)
- `ConnectorToolLike` union:
  - LangChain `DynamicStructuredTool`
  - LangChain `StructuredToolInterface`
  - Native `ConnectorTool`
- Helpers:
  - `isConnectorTool(...)`
  - `normalizeConnectorTool(...)`
  - `normalizeConnectorTools(...)`

This enables consumer code to standardize tools from different sources.

## 4) Service/API Connectors

## 4.1 GitHub Connector (`src/github`)

Factory: `createGitHubConnector(config)`

Config:

- `token` (required)
- `enabledTools?`
- `baseUrl?` (supports GitHub Enterprise API URL)

Implementation details:

- Uses an internal typed client (`GitHubClient`) built on `fetch`.
- Auth headers:
  - `Authorization: Bearer <token>`
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
- Error normalization via `safe(...)` wrapper and `GitHubApiError`.

Available tools (17):

1. `github_get_file`
2. `github_list_issues`
3. `github_get_issue`
4. `github_create_issue`
5. `github_update_issue`
6. `github_add_comment`
7. `github_list_prs`
8. `github_get_pr`
9. `github_create_pr`
10. `github_merge_pr`
11. `github_list_pr_reviews`
12. `github_create_pr_review`
13. `github_get_repo`
14. `github_list_branches`
15. `github_get_commit`
16. `github_compare_commits`
17. `github_search_code`

Notable behavior:

- `github_get_file` decodes base64 file contents.
- Directory reads return compact `d path` or `f path` lines.
- Many responses are returned as pretty JSON strings.

## 4.2 HTTP Connector (`src/http`)

Factory: `createHTTPConnector(config)`

Config:

- `baseUrl` (required)
- `headers?`
- `allowedMethods?` (defaults to `GET|POST|PUT|PATCH|DELETE`)
- `timeoutMs?` (default `30000`)

Available tools:

1. `http_request`

Features:

- Method allowlist enforcement.
- SSRF origin-lock protection:
  - Rejects absolute/protocol-relative URLs escaping `baseUrl` origin.
- Query param support.
- Timeout via `AbortController`.
- Response body truncation to 5000 chars.

Output format:

- String: `<status> <statusText>\n\n<body>`
- Errors returned as string starting with `Error: ...`

## 4.3 Slack Connector (`src/slack`)

Factory: `createSlackConnector(config)`

Config:

- `token` (required)
- `enabledTools?`

Available tools:

1. `slack_send_message`
2. `slack_list_channels`
3. `slack_search_messages`

Implementation details:

- Uses Slack Web API endpoints under `https://slack.com/api`.
- Uses bearer token auth for every request.
- Returns string success/error outputs and compact line-formatted listings.

## 4.4 Database Connector (`src/database`)

Factory: `createDatabaseConnector(config)`

Config highlights:

- Connection fields for PostgreSQL (`connectionString`, host/port/database/user/password, ssl)
- Operational guards (`readOnly`, `maxRows`, `queryTimeout`)
- Tool filtering (`enabledTools`)
- `query?` callback override for custom drivers/testing

Available tools:

1. `db-query`
2. `db-list-tables`
3. `db-describe-table`

Related programmatic API:

- `createDatabaseOperations(executor, config)` returns:
  - `query`
  - `listTables`
  - `describeTable`
  - `getTableInfo`
  - `healthCheck`
  - `close`

Implementation details:

- Lazy `pg` import when `query` callback is not provided.
- Read-only mode (default `true`) blocks write-leading SQL keywords.
- Select-like statements without explicit `LIMIT` are wrapped to enforce `maxRows`.
- OID mapping produces friendly PostgreSQL type names in query metadata.

## 5) Unified SQL Subsystem (`src/sql`)

The SQL subsystem is the most extensive part of this package and is designed for:

1. Safe read-oriented SQL query execution
2. Schema discovery for agent context
3. DDL generation from discovered metadata

### 5.1 Core Types (`sql/types.ts`)

Key types:

- `SQLDialect`: `postgresql | mysql | clickhouse | snowflake | bigquery | sqlite | sqlserver | duckdb | generic`
- `DatabaseType`: all except `generic`
- `SQLConnectionConfig`
- `QueryExecutionOptions`
- `QueryResultData`
- `ConnectionTestResult`
- `DatabaseSchema`, `TableSchema`, `ColumnInfo`, `ForeignKey`
- `SchemaDiscoveryOptions`
- `SQLConnector` interface

### 5.2 Shared Base Class (`base-sql-connector.ts`)

`BaseSQLConnector` provides:

- Shared `discoverSchema(...)` orchestration:
  - discover tables
  - apply include/exclude filtering
  - enrich each table with columns, foreign keys, row counts, sample values
- Shared DDL generation delegation (`generateDDL`)
- Shared `wrapWithLimit(sql, maxRows)` helper:
  - strips trailing semicolon
  - appends `LIMIT maxRows+1` unless already present
  - uses `+1` to detect truncation

Dialect adapters implement database-specific methods for discovery + execution.

### 5.3 Factory (`sql/factory.ts`)

`createSQLConnector(databaseType, config)` maps to adapter classes:

1. `postgresql` -> `PostgreSQLConnector`
2. `mysql` -> `MySQLConnector`
3. `clickhouse` -> `ClickHouseConnector`
4. `snowflake` -> `SnowflakeConnector`
5. `bigquery` -> `BigQueryConnector`
6. `sqlite` -> `SQLiteConnector`
7. `sqlserver` -> `SQLServerConnector`
8. `duckdb` -> `DuckDBConnector`

### 5.4 Tool Wrapper (`sql/sql-tools.ts`)

`createSQLTools({ connector, maxRows?, queryTimeout?, enabledTools? })` exposes 6 tools:

1. `sql-query`
2. `sql-list-tables`
3. `sql-describe-table`
4. `sql-discover-schema`
5. `sql-generate-ddl`
6. `sql-test-connection`

Safety behavior:

- `sql-query` enforces read-only by allowing only SQL starting with `SELECT` or `WITH` (after stripping leading SQL comments).

Output behavior:

- Returns JSON strings for normal and error paths.

### 5.5 DDL Generator (`sql/ddl-generator.ts`)

`generateDDL(table, dialect)` produces dialect-aware `CREATE TABLE` SQL:

- PostgreSQL
- MySQL
- ClickHouse (`ENGINE = MergeTree`, `ORDER BY`)
- Snowflake
- BigQuery
- Generic path (used by sqlite/sqlserver/generic)
- DuckDB uses PostgreSQL-style generation path

Supports:

- PK handling (single and composite)
- FK constraint emission
- Identifier quoting per dialect
- Optional inline comments from column descriptions

## 6) SQL Adapter Matrix

Dialect adapter overview:

1. PostgreSQL:
- Driver: `pg`
- Uses pool
- Sets `default_transaction_read_only = ON` for new connections
- Uses `statement_timeout` per query

2. MySQL:
- Driver: `mysql2/promise`
- Lazy runtime require
- Sets `SET SESSION TRANSACTION READ ONLY`
- Uses driver timeout and optional optimizer hint `MAX_EXECUTION_TIME(...)` on `SELECT`

3. ClickHouse:
- Driver: `@clickhouse/client`
- HTTP-based client
- Uses `max_execution_time` clickhouse setting
- No FK discovery (returns `[]`)

4. Snowflake:
- Driver: `snowflake-sdk`
- Lazy single connection
- Sets session timeout via `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS`
- Wraps queries in subquery for limit safety

5. BigQuery:
- Driver: `@google-cloud/bigquery`
- Job-based execution
- Explicit read-only blocker (`assertReadOnly`)
- `maximumBytesBilled` cost guard set to 1 GB

6. SQLite:
- Driver: `better-sqlite3`
- Opened readonly
- Sync API wrapped behind async connector interface

7. SQL Server:
- Driver: `mssql`
- Connection pool
- Overrides limit handling to `SELECT TOP N`
- Sets isolation level `READ UNCOMMITTED`

8. DuckDB:
- Driver: `duckdb`
- Supports `:memory:` or file DB
- File mode sets `access_mode = 'read_only'`
- No driver-level timeout support

## 7) Build and Packaging

- ESM-only output via `tsup`.
- Entry: `src/index.ts`.
- DB/native drivers are marked `external` in `tsup.config.ts` to avoid ESM/CJS bundling runtime issues.
- Package exports a single root module (`"."`) from `dist/index.js`.

## 8) Test Coverage and Current Status

Test suite location:

- `src/__tests__/*` for service connectors and contracts
- `src/sql/__tests__/*` for SQL subsystem

Validation run in this repository state:

1. Command: `yarn workspace @dzupagent/connectors test`
2. Result: 12 test files passed, 188 tests passed

Coverage thresholds (package-level config):

- statements: 40
- branches: 30
- functions: 30
- lines: 40

### 8.1 Feature-to-Test Coverage Map

This section maps implemented features to the tests that currently cover them.

#### A) Cross-Cutting Contract and Composition

1. Tool filtering (`filterTools`)
- Coverage:
  - `src/__tests__/connectors.test.ts` (`describe('filterTools')`)
- What is validated:
  - No-filter behavior returns all tools.
  - Name-based filtering works.
  - Non-matching filters return empty list.

2. Connector contract normalization (`normalizeConnectorTool(s)`, `isConnectorTool`)
- Coverage:
  - `src/__tests__/connector-contract.test.ts`
- What is validated:
  - Normalization of custom/forge-style descriptors.
  - Normalization of real `DynamicStructuredTool` outputs.
  - Optional `toModelOutput` support.

3. Public API integration usage
- Coverage:
  - `src/__tests__/connectors.integration.test.ts`
- What is validated:
  - End-to-end usage through package exports for HTTP/GitHub/Database tool factories.
  - Tool invocation contracts and output formatting through public entrypoint.

#### B) GitHub Connector Features

Coverage files:

- `src/__tests__/connectors.test.ts`
- `src/__tests__/github-connector.test.ts`
- `src/__tests__/connectors.integration.test.ts`

Feature coverage:

1. Tool inventory and filtering
- Validates 17 default tools and `enabledTools` behavior.

2. File content and directory handling
- Base64 decode for file content.
- Directory listing formatting.
- `ref` query parameter support.

3. Issues and comments
- List/get/create/update issue flows.
- Label/assignee/state filters and payload correctness.
- Add comment flow.

4. Pull request operations
- List/get/create/merge PR.
- Merge success/failure formatting.
- Review list/create behavior and payload shape.

5. Repository operations
- Get repo metadata.
- List branches with protection marker.
- Get commit and compare commits.

6. Search and low-level client behavior
- Code search result formatting.
- Header correctness, base URL handling, HTTP verb/path correctness in client.
- Error handling (`GitHubApiError`) and 204 handling.

#### C) HTTP Connector Features

Coverage files:

- `src/__tests__/connectors.test.ts`
- `src/__tests__/http-connector.test.ts`
- `src/__tests__/connectors.integration.test.ts`

Feature coverage:

1. Request construction
- Method, URL path joining, query parameter appending, body passthrough.

2. Header behavior
- Merges `Content-Type` with user-provided headers.

3. Guardrails and safety
- Method allowlist enforcement.
- SSRF origin lock against absolute/protocol-relative URL origin escape.
- Relative-path same-origin allowance.

4. Resilience and output controls
- Fetch error handling.
- Timeout/abort behavior.
- Response body truncation to 5000 chars.

#### D) Slack Connector Features

Coverage files:

- `src/__tests__/connectors.test.ts`

Feature coverage:

1. Tool inventory and filtering
- Confirms 3 tools are created and `enabledTools` filtering works.

Note:
- There is currently no dedicated `slack-connector.test.ts` validating request payload details or Slack API error-path nuances.

#### E) Database Connector (`src/database`) Features

Coverage files:

- `src/__tests__/connectors.test.ts`
- `src/__tests__/database-connector.test.ts`
- `src/__tests__/connectors.integration.test.ts`

Feature coverage:

1. Tool inventory and metadata
- Confirms 3 tool names, default/custom database naming in descriptions, and filtering behavior.

2. Read-only enforcement
- Blocks broad write-keyword set by default.
- Allows SELECT/CTE queries.
- Allows writes when `readOnly: false`.

3. Query behavior and formatting
- Parameter passthrough.
- Auto LIMIT wrapping behavior and default max rows.
- Table-like output formatting including NULL and duration.
- Friendly error messaging on thrown errors.

4. Schema introspection tools
- `db-list-tables`: default/custom schema, empty results, and error path.
- `db-describe-table`: column/type/constraint/default formatting, row estimate, not-found handling, error path.

5. Programmatic operations API
- `createDatabaseOperations` health check success/failure.
- `listTables` structure.
- read-only guard behavior.
- close lifecycle behavior.

#### F) Unified SQL Subsystem Features

Coverage files:

- `src/sql/__tests__/factory.test.ts`
- `src/sql/__tests__/sql-tools.test.ts`
- `src/sql/__tests__/base-sql-connector.test.ts`
- `src/sql/__tests__/sql-adapters.test.ts`
- `src/sql/__tests__/ddl-generator.test.ts`
- `src/sql/__tests__/lazy-loading.test.ts`

Feature coverage:

1. Factory mapping
- `createSQLConnector` maps each `DatabaseType` to the expected adapter.
- Unsupported dialect throws.

2. SQL tool wrappers (`createSQLTools`)
- `sql-query` read-only guard (SELECT/WITH only).
- Leading comment stripping and classifier behavior.
- Propagation of `maxRows`/`queryTimeout`.

3. Base connector orchestration
- Shared `wrapWithLimit` behavior.
- Schema discovery flow (include/exclude filtering, enrichment steps).
- Sample-value fetch behavior including graceful degradation on failures.
- `discoveredAt` and dialect metadata in output.

4. DDL generation
- Dialect-specific output expectations across PostgreSQL/MySQL/ClickHouse/Snowflake/BigQuery/sqlite/sqlserver/generic/duckdb.
- PK/FK/default/comment/identifier escaping behaviors.

5. Lazy-loading boundaries
- SQL barrel import does not instantiate adapters eagerly.
- Driver loading deferred until connector construction (explicitly validated for MySQL path).

### 8.2 Test Gaps and Residual Risk

Current implementation is heavily unit-tested, but these gaps remain:

1. Slack depth gap
- No dedicated Slack connector test file for payload and error semantics.

2. Adapter runtime integration gap
- SQL adapter tests primarily validate orchestration/factory/behavioral contracts with mocks, not live-database integration for all 8 dialects in this package.

3. Package-level coverage thresholds are intentionally low
- Thresholds are set to 40/30/30/40 and do not guarantee high branch/path coverage for all edge cases.

## 9) How to Use This Package

## 9.1 Basic Install

```bash
yarn add @dzupagent/connectors
```

Peer dependencies expected by consumers:

- `@langchain/core`
- `zod`

## 9.2 Compose Connectors for an Agent

```ts
import { DzupAgent } from '@dzupagent/agent'
import {
  createGitHubConnector,
  createHTTPConnector,
  createSlackConnector,
  filterTools,
} from '@dzupagent/connectors'

const githubTools = createGitHubConnector({
  token: process.env.GITHUB_TOKEN!,
  enabledTools: ['github_get_file', 'github_list_issues'],
})

const httpTools = createHTTPConnector({
  baseUrl: 'https://api.example.com',
  allowedMethods: ['GET', 'POST'],
  timeoutMs: 15_000,
})

const slackTools = createSlackConnector({
  token: process.env.SLACK_BOT_TOKEN!,
})

const tools = [
  ...githubTools,
  ...filterTools(httpTools, ['http_request']),
  ...slackTools,
]

const agent = new DzupAgent({ tools })
```

## 9.3 Use the PostgreSQL-Oriented Database Connector

```ts
import { createDatabaseConnector } from '@dzupagent/connectors'

const dbTools = createDatabaseConnector({
  connectionString: process.env.DATABASE_URL!,
  readOnly: true,
  maxRows: 500,
  enabledTools: ['db-query', 'db-list-tables', 'db-describe-table'],
})
```

You can also inject a custom query function:

```ts
import { createDatabaseConnector } from '@dzupagent/connectors'

const dbTools = createDatabaseConnector({
  readOnly: true,
  query: async (sql, params) => {
    // bridge to your own DB runtime
    const rows = await runYourDriver(sql, params)
    return { rows, rowCount: rows.length }
  },
})
```

## 9.4 Use the Unified SQL Subsystem (Recommended for Multi-Dialect)

```ts
import {
  createSQLConnector,
  createSQLTools,
} from '@dzupagent/connectors'

const connector = createSQLConnector('postgresql', {
  host: '127.0.0.1',
  port: 5432,
  database: 'analytics',
  username: 'app',
  password: process.env.DB_PASSWORD!,
  ssl: false,
  schema: 'public',
})

const sqlTools = createSQLTools({
  connector,
  maxRows: 500,
  queryTimeout: 30_000,
  enabledTools: [
    'sql-query',
    'sql-list-tables',
    'sql-describe-table',
    'sql-test-connection',
  ],
})
```

Call `await connector.destroy()` during shutdown to release resources for adapters that maintain pools/connections.

## 9.5 Normalize Mixed Tool Sources

```ts
import {
  createHTTPConnector,
  normalizeConnectorTools,
} from '@dzupagent/connectors'

const langchainTools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
const canonicalTools = normalizeConnectorTools(langchainTools)
```

This is useful when your orchestration layer expects a single internal tool contract.

## 10) Extension Guidance

To add a new connector in this package:

1. Create a dedicated folder under `src/<connector-name>/`.
2. Expose a `create<ConnectorName>Connector(config)` factory returning `DynamicStructuredTool[]`.
3. Define strict `zod` schemas for tool inputs.
4. Add `enabledTools` support and pass through `filterTools(...)`.
5. Export from `src/index.ts` and add tests under `src/__tests__`.

To add a new SQL dialect adapter:

1. Implement a class extending `BaseSQLConnector`.
2. Implement all abstract methods for execution and schema discovery.
3. Add adapter export in `src/sql/adapters/index.ts`.
4. Add mapping in `src/sql/factory.ts`.
5. Add unit tests for factory mapping and dialect behavior.
