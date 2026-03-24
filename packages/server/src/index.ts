/**
 * @forgeagent/server — Optional HTTP/WS runtime for ForgeAgent.
 *
 * Provides: Hono REST API, run/agent persistence (Postgres + Drizzle),
 * approval management, SSE streaming, WebSocket event bridge,
 * and API key authentication.
 */

// --- App ---
export { createForgeApp } from './app.js'
export type { ForgeServerConfig } from './app.js'

// --- Routes ---
export { createRunRoutes } from './routes/runs.js'
export { createAgentRoutes } from './routes/agents.js'
export { createApprovalRoutes } from './routes/approval.js'
export { createHealthRoutes } from './routes/health.js'

// --- Persistence ---
export { PostgresRunStore, PostgresAgentStore } from './persistence/postgres-stores.js'
export { forgeAgents, forgeRuns, forgeRunLogs } from './persistence/drizzle-schema.js'

// --- Middleware ---
export { authMiddleware } from './middleware/auth.js'
export type { AuthConfig } from './middleware/auth.js'

// --- WebSocket ---
export { EventBridge } from './ws/event-bridge.js'
export type { WSClient, ClientFilter } from './ws/event-bridge.js'

// --- Version ---
export const FORGEAGENT_SERVER_VERSION = '0.1.0'
