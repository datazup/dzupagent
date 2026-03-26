/**
 * A2A JSON-RPC 2.0 types, error codes, and validation helpers.
 *
 * Implements the JSON-RPC 2.0 specification (https://www.jsonrpc.org/specification)
 * with A2A-specific error codes in the -32000 to -32099 server error range.
 */

// ---------------------------------------------------------------------------
// Standard JSON-RPC 2.0 error codes
// ---------------------------------------------------------------------------

/** Standard JSON-RPC 2.0 error codes. */
export const JSON_RPC_ERRORS = {
  /** Invalid JSON was received by the server. */
  PARSE_ERROR: -32700,
  /** The JSON sent is not a valid Request object. */
  INVALID_REQUEST: -32600,
  /** The method does not exist / is not available. */
  METHOD_NOT_FOUND: -32601,
  /** Invalid method parameter(s). */
  INVALID_PARAMS: -32602,
  /** Internal JSON-RPC error. */
  INTERNAL_ERROR: -32603,
} as const

// ---------------------------------------------------------------------------
// A2A-specific error codes (-32000 to -32099)
// ---------------------------------------------------------------------------

/** A2A protocol-specific error codes within the JSON-RPC server error range. */
export const A2A_ERRORS = {
  /** Referenced task does not exist. */
  TASK_NOT_FOUND: -32001,
  /** Task is in a terminal state and cannot be canceled. */
  TASK_NOT_CANCELABLE: -32002,
  /** Agent does not support push notifications. */
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  /** Requested operation is not supported by this agent. */
  UNSUPPORTED_OPERATION: -32004,
  /** Content type in the request is not supported. */
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  /** Agent card validation failed. */
  INVALID_AGENT_CARD: -32006,
} as const

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

/** JSON-RPC 2.0 success response. */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0'
  id: string | number
  result: unknown
}

/** Structured JSON-RPC 2.0 error object. */
export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

/** JSON-RPC 2.0 error response. */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: string | number | null
  error: JsonRpcErrorObject
}

/** JSON-RPC 2.0 response (success or error). */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

/**
 * Create a JSON-RPC 2.0 error response.
 *
 * @param id - Request ID (null if the request could not be parsed).
 * @param code - Numeric error code.
 * @param message - Human-readable error message.
 * @param data - Optional additional error data.
 */
export function createJsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const response: JsonRpcErrorResponse = {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }
  if (data !== undefined) {
    response.error.data = data
  }
  return response
}

/**
 * Create a JSON-RPC 2.0 success response.
 *
 * @param id - Request ID.
 * @param result - Result payload.
 */
export function createJsonRpcSuccess(
  id: string | number,
  result: unknown,
): JsonRpcSuccessResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Result of validating a JSON-RPC request. */
export type JsonRpcValidationResult =
  | { valid: true; request: JsonRpcRequest }
  | { valid: false; error: JsonRpcErrorResponse }

/**
 * Validate that an unknown value conforms to the JSON-RPC 2.0 request structure.
 *
 * Checks:
 * - Is an object (not null, not array)
 * - Has `jsonrpc: "2.0"`
 * - Has a string `method`
 * - Has a string or number `id`
 * - If `params` is present, it must be an object
 */
export function validateJsonRpcRequest(data: unknown): JsonRpcValidationResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return {
      valid: false,
      error: createJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Request must be a JSON object'),
    }
  }

  const obj = data as Record<string, unknown>

  if (obj['jsonrpc'] !== '2.0') {
    return {
      valid: false,
      error: createJsonRpcError(
        extractId(obj),
        JSON_RPC_ERRORS.INVALID_REQUEST,
        'Missing or invalid "jsonrpc" field — must be "2.0"',
      ),
    }
  }

  const id = obj['id']
  if (typeof id !== 'string' && typeof id !== 'number') {
    return {
      valid: false,
      error: createJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Missing or invalid "id" field — must be a string or number'),
    }
  }

  const method = obj['method']
  if (typeof method !== 'string' || method.length === 0) {
    return {
      valid: false,
      error: createJsonRpcError(id, JSON_RPC_ERRORS.INVALID_REQUEST, 'Missing or invalid "method" field — must be a non-empty string'),
    }
  }

  const params = obj['params']
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    return {
      valid: false,
      error: createJsonRpcError(id, JSON_RPC_ERRORS.INVALID_PARAMS, '"params" must be an object if provided'),
    }
  }

  return {
    valid: true,
    request: {
      jsonrpc: '2.0',
      id,
      method,
      params: params as Record<string, unknown> | undefined,
    },
  }
}

/** Result of validating a JSON-RPC batch request. */
export type JsonRpcBatchValidationResult =
  | { valid: true; requests: JsonRpcRequest[] }
  | { valid: false; error: JsonRpcErrorResponse }

/**
 * Validate a batch JSON-RPC 2.0 request (array of requests).
 *
 * Per spec, an empty array is invalid.
 * Each element is individually validated; the batch fails if any element
 * is not a valid JSON-RPC request.
 */
export function validateJsonRpcBatch(data: unknown): JsonRpcBatchValidationResult {
  if (!Array.isArray(data)) {
    return {
      valid: false,
      error: createJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Batch request must be a JSON array'),
    }
  }

  if (data.length === 0) {
    return {
      valid: false,
      error: createJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Batch request must not be empty'),
    }
  }

  const requests: JsonRpcRequest[] = []
  for (const item of data) {
    const result = validateJsonRpcRequest(item)
    if (!result.valid) {
      return { valid: false, error: result.error }
    }
    requests.push(result.request)
  }

  return { valid: true, requests }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract an id from an object if it looks like a valid JSON-RPC id.
 * Used for error responses when the full request is invalid.
 */
function extractId(obj: Record<string, unknown>): string | number | null {
  const id = obj['id']
  if (typeof id === 'string' || typeof id === 'number') {
    return id
  }
  return null
}
