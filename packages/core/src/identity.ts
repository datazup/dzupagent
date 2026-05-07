/**
 * @dzupagent/core/identity — Forge identity, signing keys, resolvers,
 * delegation, capability checks, trust scoring, and protocol message envelope.
 *
 * @example
 * ```ts
 * import {
 *   createKeyManager,
 *   DelegationManager,
 *   ProtocolRouter,
 * } from '@dzupagent/core/identity'
 * ```
 */

// ---------------------------------------------------------------------------
// Identity refs and schemas
// ---------------------------------------------------------------------------
export { toIdentityRef } from './identity/index.js'
export type {
  ForgeIdentity,
  ForgeCredential,
  ForgeCapability,
  ForgeIdentityRef,
  CredentialType,
} from './identity/index.js'
export {
  ForgeIdentitySchema,
  ForgeCapabilitySchema,
  ForgeCredentialSchema,
  ForgeIdentityRefSchema,
} from './identity/index.js'

// ---------------------------------------------------------------------------
// URI parser
// ---------------------------------------------------------------------------
export {
  parseForgeUri,
  buildForgeUri,
  isForgeUri,
  toAgentUri,
  fromAgentUri,
  createUriResolver,
  ForgeUriSchema,
} from './identity/index.js'
export type {
  ParsedForgeUri,
  UriResolver,
  UriResolverStrategy,
  UriResolverConfig,
} from './identity/index.js'

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------
export { createKeyManager, InMemoryKeyStore } from './identity/index.js'
export type {
  SigningKeyPair,
  SigningKeyStatus,
  SignedDocument,
  SignedAgentCard,
  KeyStore,
  KeyManagerConfig,
  KeyManager,
} from './identity/index.js'

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
export { CompositeIdentityResolver } from './identity/index.js'
export type {
  IdentityResolutionContext,
  IdentityResolver,
} from './identity/index.js'
export { createAPIKeyResolver, hashAPIKey } from './identity/index.js'
export type {
  APIKeyRecord,
  APIKeyResolverConfig,
  APIKeyIdentityResolver,
} from './identity/index.js'

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------
export { InMemoryDelegationTokenStore, DelegationManager } from './identity/index.js'
export type {
  DelegationToken,
  DelegationConstraint,
  DelegationChain,
  DelegationTokenStore,
  DelegationManagerConfig,
  IssueDelegationParams,
} from './identity/index.js'

// ---------------------------------------------------------------------------
// Capability checking
// ---------------------------------------------------------------------------
export { createCapabilityChecker } from './identity/index.js'
export type {
  CapabilityCheckResult,
  CapabilityCheckerConfig,
  CapabilityCheckParams,
  CapabilityChecker,
} from './identity/index.js'

// ---------------------------------------------------------------------------
// Trust scoring
// ---------------------------------------------------------------------------
export { createTrustScorer, InMemoryTrustScoreStore } from './identity/index.js'
export type {
  TrustSignals,
  TrustScoreBreakdown,
  TrustScorerConfig,
  TrustScoreStore,
  TrustScorer,
} from './identity/index.js'

// ---------------------------------------------------------------------------
// Protocol (message envelope, JSON-RPC, A2A, push notifications)
// ---------------------------------------------------------------------------
export {
  ForgeMessageUriSchema,
  ForgeMessageMetadataSchema,
  ForgePayloadSchema,
  ForgeMessageSchema,
  createMessageId,
  createForgeMessage,
  createResponse,
  createErrorResponse,
  isMessageAlive,
  validateForgeMessage,
  InternalAdapter,
  extractAgentId,
  ProtocolRouter,
  A2AClientAdapter,
  streamA2ATask,
  parseSSEEvents,
  JSONSerializer,
  defaultSerializer,
  ProtocolBridge,
  JSON_RPC_ERRORS,
  A2A_ERRORS,
  createJsonRpcError,
  createJsonRpcSuccess,
  validateJsonRpcRequest,
  validateJsonRpcBatch,
  PushNotificationService,
} from './protocol/index.js'
export type {
  ForgeMessageId,
  ForgeMessageType,
  ForgeProtocol,
  MessagePriority,
  MessageBudget,
  ForgeMessageMetadata,
  ForgePayload,
  ForgeMessage,
  CreateMessageParams,
  ValidationResult,
  AdapterState,
  AdapterHealthStatus,
  SendOptions,
  MessageHandler,
  Subscription,
  ProtocolAdapter,
  InternalAdapterConfig,
  ProtocolRouterConfig,
  A2AClientConfig,
  A2ASSEConfig,
  SSEEvent,
  MessageSerializer,
  ProtocolBridgeConfig,
  BridgeDirection,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcValidationResult,
  JsonRpcBatchValidationResult,
  PushNotificationEvent,
  PushNotificationConfig,
  PushNotification,
  PushNotificationResult,
  PushNotificationServiceConfig,
} from './protocol/index.js'
