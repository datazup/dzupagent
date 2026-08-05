export type {
  SSEEvent,
  SSEHandlerConfig,
  AgentResult,
  ChatRequestBody,
  AgentRouterConfig,
  MCPAuthFailurePayload,
  MCPRequestHandler,
  MCPRequestContextAssigner,
  MCPRequestContextAuthConfig,
  MCPRequestContextFailureHandler,
  MCPRequestContextResolver,
  MCPRequestHandlerResolver,
  MCPRouterConfig,
} from "./types.js";
export { SSEHandler, SSEWriter } from "./sse-handler.js";
// Retain the established root API while offering the narrower
// `@dzupagent/express/route-error` subpath to new consumers.
export {
  ClientSafeError,
  GENERIC_ERROR_CODE,
  GENERIC_ERROR_MESSAGE,
  isClientSafeError,
  routeError,
  sanitizeError,
  toError,
} from "./route-error.js";
export type { RouteErrorContext, SanitizedError } from "./route-error.js";
export { SSEProjectionRouter, withProjection } from "./sse-projections.js";
export type {
  SSENamespace,
  ProjectionContext,
  SubagentLifecycleEvent,
  AgentMessageEvent,
  ToolInvocationEvent,
  ToolResultEvent,
} from "./sse-projections.js";
export { createAgentRouter } from "./agent-router.js";
export {
  createMcpRequestContextAuth,
  extractMcpCredential,
  getMcpRequestContext,
  requireMcpRequestContext,
  setMcpRequestContext,
} from "./mcp-context.js";
export { createMcpRouter } from "./mcp-router.js";
