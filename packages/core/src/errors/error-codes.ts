/**
 * Exhaustive error codes for ForgeAgent.
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
  // --- General ---
  | 'INTERNAL_ERROR'
