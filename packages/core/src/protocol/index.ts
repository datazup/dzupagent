/**
 * Protocol module — barrel exports.
 */

// --- Types ---
export type {
  ForgeMessageId,
  ForgeMessageType,
  ForgeProtocol,
  MessagePriority,
  MessageBudget,
  ForgeMessageMetadata,
  ForgePayload,
  ForgeMessage,
} from './message-types.js'

// --- Schemas ---
export {
  ForgeMessageUriSchema,
  ForgeMessageMetadataSchema,
  ForgePayloadSchema,
  ForgeMessageSchema,
} from './message-schemas.js'

// --- Factory ---
export {
  createMessageId,
  createForgeMessage,
  createResponse,
  createErrorResponse,
  isMessageAlive,
  validateForgeMessage,
} from './message-factory.js'
export type {
  CreateMessageParams,
  ValidationResult,
} from './message-factory.js'

// --- Adapter ---
export type {
  AdapterState,
  AdapterHealthStatus,
  SendOptions,
  MessageHandler,
  Subscription,
  ProtocolAdapter,
} from './adapter.js'

// --- Internal Adapter ---
export { InternalAdapter, extractAgentId } from './internal-adapter.js'
export type { InternalAdapterConfig } from './internal-adapter.js'

// --- Protocol Router ---
export { ProtocolRouter } from './protocol-router.js'
export type { ProtocolRouterConfig } from './protocol-router.js'

// --- A2A Client Adapter ---
export { A2AClientAdapter } from './a2a-client-adapter.js'
export type { A2AClientConfig } from './a2a-client-adapter.js'

// --- A2A SSE Streaming ---
export { streamA2ATask, parseSSEEvents } from './a2a-sse-stream.js'
export type { A2ASSEConfig, SSEEvent } from './a2a-sse-stream.js'

// --- Serialization ---
export { JSONSerializer, defaultSerializer } from './serialization.js'
export type { MessageSerializer } from './serialization.js'

// --- Protocol Bridge ---
export { ProtocolBridge } from './protocol-bridge.js'
export type { ProtocolBridgeConfig, BridgeDirection } from './protocol-bridge.js'

// --- A2A JSON-RPC 2.0 ---
export {
  JSON_RPC_ERRORS,
  A2A_ERRORS,
  createJsonRpcError,
  createJsonRpcSuccess,
  validateJsonRpcRequest,
  validateJsonRpcBatch,
} from './a2a-json-rpc.js'
export type {
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcValidationResult,
  JsonRpcBatchValidationResult,
} from './a2a-json-rpc.js'

// --- A2A Push Notifications ---
export { PushNotificationService } from './a2a-push-notification.js'
export type {
  PushNotificationEvent,
  PushNotificationConfig,
  PushNotification,
  PushNotificationResult,
  PushNotificationServiceConfig,
} from './a2a-push-notification.js'
