/**
 * @dzipagent/connectors — Pre-built integrations for DzipAgent.
 *
 * Each connector produces LangChain DynamicStructuredTools that can be
 * passed directly to DzipAgent's `tools` config.
 */

// --- Types ---
export type { Connector, ConnectorConfig } from './connector-types.js'
export { filterTools } from './connector-types.js'

// --- GitHub ---
export { createGitHubConnector } from './github/index.js'
export { GitHubClient, GitHubApiError } from './github/index.js'
export type {
  GitHubConnectorConfig,
  GitHubClientConfig,
  GitHubIssue,
  GitHubComment,
  GitHubPullRequest,
  GitHubReview,
  GitHubMergeResult,
  GitHubRepo,
  GitHubBranch,
  GitHubCommit,
  GitHubComparison,
  GitHubContent,
  ListIssuesOptions,
  UpdateIssueOptions,
  ListPRsOptions,
  MergePROptions,
} from './github/index.js'

// --- HTTP ---
export { createHTTPConnector } from './http/index.js'
export type { HTTPConnectorConfig } from './http/index.js'

// --- Slack ---
export { createSlackConnector } from './slack/index.js'
export type { SlackConnectorConfig } from './slack/index.js'

// --- Database ---
export { createDatabaseConnector, createDatabaseOperations } from './database/index.js'
export type {
  DatabaseConnectorConfig,
  DatabaseOperations,
  QueryResult,
  TableInfo,
  ColumnInfo,
} from './database/index.js'

// --- SQL (unified: query execution + schema discovery, 8 dialects) ---
export {
  createSQLConnector,
  createSQLTools,
  BaseSQLConnector,
  generateDDL,
  PostgreSQLConnector,
  MySQLConnector,
  ClickHouseConnector,
  SnowflakeConnector,
  BigQueryConnector,
  SQLiteConnector,
  SQLServerConnector,
  DuckDBConnector,
} from './sql/index.js'
export type {
  SQLDialect,
  DatabaseType,
  SQLConnectionConfig,
  QueryExecutionOptions,
  QueryResultData,
  ConnectionTestResult,
  ColumnInfo as SQLColumnInfo,
  ForeignKey as SQLForeignKey,
  TableSchema as SQLTableSchema,
  DatabaseSchema,
  SchemaDiscoveryOptions,
  SQLConnector,
  SQLToolsConfig,
} from './sql/index.js'

// --- Version ---
export const dzipagent_CONNECTORS_VERSION = '0.1.0'
