/**
 * @forgeagent/connectors — Pre-built integrations for ForgeAgent.
 *
 * Each connector produces LangChain DynamicStructuredTools that can be
 * passed directly to ForgeAgent's `tools` config.
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

// --- Version ---
export const FORGEAGENT_CONNECTORS_VERSION = '0.1.0'
