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
export type { GitHubConnectorConfig } from './github/index.js'

// --- HTTP ---
export { createHTTPConnector } from './http/index.js'
export type { HTTPConnectorConfig } from './http/index.js'

// --- Slack ---
export { createSlackConnector } from './slack/index.js'
export type { SlackConnectorConfig } from './slack/index.js'

// --- Database ---
export { createDatabaseConnector } from './database/index.js'
export type { DatabaseConnectorConfig } from './database/index.js'

// --- Version ---
export const FORGEAGENT_CONNECTORS_VERSION = '0.1.0'
