/**
 * Exhaustive error codes for DzipAgent.
 * Each code maps to a specific failure mode with known recovery strategies.
 */
export type ForgeErrorCode =
  // --- Provider errors ---
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'ALL_PROVIDERS_EXHAUSTED'
  // --- Budget errors ---
  | 'BUDGET_EXCEEDED'
  | 'TOKEN_LIMIT_EXCEEDED'
  | 'COST_LIMIT_EXCEEDED'
  | 'ITERATION_LIMIT_EXCEEDED'
  // --- Pipeline errors ---
  | 'PIPELINE_PHASE_FAILED'
  | 'VALIDATION_FAILED'
  | 'TEST_FAILED'
  | 'FIX_ESCALATION_EXHAUSTED'
  // --- Tool errors ---
  | 'TOOL_NOT_FOUND'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_TIMEOUT'
  // --- MCP errors ---
  | 'MCP_CONNECTION_FAILED'
  | 'MCP_TOOL_NOT_FOUND'
  | 'MCP_INVOCATION_FAILED'
  // --- Memory errors ---
  | 'MEMORY_WRITE_FAILED'
  | 'MEMORY_SEARCH_FAILED'
  | 'MEMORY_INJECTION_DETECTED'
  // --- Approval errors ---
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_TIMEOUT'
  // --- Config errors ---
  | 'INVALID_CONFIG'
  | 'MISSING_DEPENDENCY'
  // --- Agent errors ---
  | 'AGENT_STUCK'
  | 'AGENT_ABORTED'
  // --- Identity errors ---
  | 'IDENTITY_NOT_FOUND'
  | 'IDENTITY_INVALID'
  | 'IDENTITY_RESOLUTION_FAILED'
  // --- Delegation errors ---
  | 'DELEGATION_EXPIRED'
  | 'DELEGATION_REVOKED'
  | 'DELEGATION_DEPTH_EXCEEDED'
  | 'DELEGATION_SCOPE_VIOLATION'
  | 'DELEGATION_INVALID_SIGNATURE'
  // --- Capability errors ---
  | 'CAPABILITY_DENIED'
  | 'CAPABILITY_NOT_FOUND'
  // --- Protocol errors ---
  | 'PROTOCOL_UNSUPPORTED'
  | 'PROTOCOL_CONNECTION_FAILED'
  | 'PROTOCOL_SEND_FAILED'
  | 'PROTOCOL_TIMEOUT'
  | 'MESSAGE_VALIDATION_FAILED'
  | 'MESSAGE_EXPIRED'
  | 'MESSAGE_ROUTING_FAILED'
  | 'SERIALIZATION_FAILED'
  // --- Registry errors ---
  | 'REGISTRY_AGENT_NOT_FOUND'
  | 'REGISTRY_AGENT_EXISTS'
  | 'REGISTRY_INVALID_INPUT'
  | 'REGISTRY_CARD_FETCH_FAILED'
  | 'REGISTRY_CARD_INVALID'
  // --- Policy errors ---
  | 'POLICY_DENIED'
  | 'POLICY_INVALID'
  // --- VectorStore errors ---
  | 'VECTOR_COLLECTION_NOT_FOUND'
  | 'VECTOR_COLLECTION_EXISTS'
  | 'VECTOR_DIMENSION_MISMATCH'
  | 'VECTOR_STORE_UNAVAILABLE'
  // --- Adapter errors ---
  | 'ADAPTER_SDK_NOT_INSTALLED'
  | 'ADAPTER_EXECUTION_FAILED'
  | 'ADAPTER_SESSION_NOT_FOUND'
  | 'ADAPTER_TIMEOUT'
  | 'ALL_ADAPTERS_EXHAUSTED'
  // --- Output parsing errors ---
  | 'OUTPUT_PARSE_FAILED'
  // --- General ---
  | 'INTERNAL_ERROR'
