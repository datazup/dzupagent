import { describe, it, expect } from 'vitest'
import {
  JSON_RPC_ERRORS,
  A2A_ERRORS,
  createJsonRpcError,
  createJsonRpcSuccess,
  validateJsonRpcRequest,
  validateJsonRpcBatch,
} from '../a2a-json-rpc.js'

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

describe('JSON_RPC_ERRORS', () => {
  it('has standard error codes', () => {
    expect(JSON_RPC_ERRORS.PARSE_ERROR).toBe(-32700)
    expect(JSON_RPC_ERRORS.INVALID_REQUEST).toBe(-32600)
    expect(JSON_RPC_ERRORS.METHOD_NOT_FOUND).toBe(-32601)
    expect(JSON_RPC_ERRORS.INVALID_PARAMS).toBe(-32602)
    expect(JSON_RPC_ERRORS.INTERNAL_ERROR).toBe(-32603)
  })
})

describe('A2A_ERRORS', () => {
  it('has A2A-specific error codes in the server range', () => {
    expect(A2A_ERRORS.TASK_NOT_FOUND).toBe(-32001)
    expect(A2A_ERRORS.TASK_NOT_CANCELABLE).toBe(-32002)
    expect(A2A_ERRORS.PUSH_NOTIFICATION_NOT_SUPPORTED).toBe(-32003)
    expect(A2A_ERRORS.UNSUPPORTED_OPERATION).toBe(-32004)
    expect(A2A_ERRORS.CONTENT_TYPE_NOT_SUPPORTED).toBe(-32005)
    expect(A2A_ERRORS.INVALID_AGENT_CARD).toBe(-32006)
  })

  it('all codes are in the -32000 to -32099 range', () => {
    for (const code of Object.values(A2A_ERRORS)) {
      expect(code).toBeGreaterThanOrEqual(-32099)
      expect(code).toBeLessThanOrEqual(-32000)
    }
  })
})

// ---------------------------------------------------------------------------
// createJsonRpcError
// ---------------------------------------------------------------------------

describe('createJsonRpcError', () => {
  it('creates error response with all fields', () => {
    const resp = createJsonRpcError('req-1', -32600, 'Invalid request', { detail: 'test' })
    expect(resp).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      error: {
        code: -32600,
        message: 'Invalid request',
        data: { detail: 'test' },
      },
    })
  })

  it('creates error response without data', () => {
    const resp = createJsonRpcError(42, -32700, 'Parse error')
    expect(resp).toEqual({
      jsonrpc: '2.0',
      id: 42,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    })
    expect(resp.error).not.toHaveProperty('data')
  })

  it('supports null id for parse errors', () => {
    const resp = createJsonRpcError(null, -32700, 'Parse error')
    expect(resp.id).toBeNull()
    expect(resp.jsonrpc).toBe('2.0')
  })
})

// ---------------------------------------------------------------------------
// createJsonRpcSuccess
// ---------------------------------------------------------------------------

describe('createJsonRpcSuccess', () => {
  it('creates success response with object result', () => {
    const resp = createJsonRpcSuccess('req-1', { status: 'ok' })
    expect(resp).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { status: 'ok' },
    })
  })

  it('creates success response with numeric id', () => {
    const resp = createJsonRpcSuccess(5, 'hello')
    expect(resp.id).toBe(5)
    expect(resp.result).toBe('hello')
  })

  it('creates success response with null result', () => {
    const resp = createJsonRpcSuccess('req-2', null)
    expect(resp.result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateJsonRpcRequest
// ---------------------------------------------------------------------------

describe('validateJsonRpcRequest', () => {
  it('accepts a valid request', () => {
    const result = validateJsonRpcRequest({
      jsonrpc: '2.0',
      id: 'abc',
      method: 'tasks/send',
      params: { id: 'task-1' },
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.request.method).toBe('tasks/send')
      expect(result.request.params).toEqual({ id: 'task-1' })
    }
  })

  it('accepts request without params', () => {
    const result = validateJsonRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/get',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.request.params).toBeUndefined()
    }
  })

  it('rejects non-object', () => {
    const result = validateJsonRpcRequest('not an object')
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST)
    }
  })

  it('rejects null', () => {
    const result = validateJsonRpcRequest(null)
    expect(result.valid).toBe(false)
  })

  it('rejects array', () => {
    const result = validateJsonRpcRequest([])
    expect(result.valid).toBe(false)
  })

  it('rejects missing jsonrpc field', () => {
    const result = validateJsonRpcRequest({ id: 1, method: 'test' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST)
      expect(result.error.error.message).toContain('jsonrpc')
    }
  })

  it('rejects wrong jsonrpc version', () => {
    const result = validateJsonRpcRequest({ jsonrpc: '1.0', id: 1, method: 'test' })
    expect(result.valid).toBe(false)
  })

  it('rejects missing id', () => {
    const result = validateJsonRpcRequest({ jsonrpc: '2.0', method: 'test' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error.id).toBeNull()
    }
  })

  it('rejects boolean id', () => {
    const result = validateJsonRpcRequest({ jsonrpc: '2.0', id: true, method: 'test' })
    expect(result.valid).toBe(false)
  })

  it('rejects missing method', () => {
    const result = validateJsonRpcRequest({ jsonrpc: '2.0', id: 1 })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error.error.message).toContain('method')
    }
  })

  it('rejects empty method string', () => {
    const result = validateJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: '' })
    expect(result.valid).toBe(false)
  })

  it('rejects numeric method', () => {
    const result = validateJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 42 })
    expect(result.valid).toBe(false)
  })

  it('rejects array params', () => {
    const result = validateJsonRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'test',
      params: [1, 2, 3],
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS)
    }
  })

  it('rejects null params', () => {
    const result = validateJsonRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'test',
      params: null,
    })
    expect(result.valid).toBe(false)
  })

  it('preserves numeric id in error when jsonrpc is wrong', () => {
    const result = validateJsonRpcRequest({ jsonrpc: '1.0', id: 99, method: 'test' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error.id).toBe(99)
    }
  })
})

// ---------------------------------------------------------------------------
// validateJsonRpcBatch
// ---------------------------------------------------------------------------

describe('validateJsonRpcBatch', () => {
  it('accepts a valid batch', () => {
    const result = validateJsonRpcBatch([
      { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'task-1' } },
      { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'task-2' } },
    ])
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.requests).toHaveLength(2)
    }
  })

  it('rejects non-array', () => {
    const result = validateJsonRpcBatch({ jsonrpc: '2.0', id: 1, method: 'test' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST)
      expect(result.error.error.message).toContain('array')
    }
  })

  it('rejects empty array', () => {
    const result = validateJsonRpcBatch([])
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error.error.message).toContain('empty')
    }
  })

  it('rejects batch with invalid element', () => {
    const result = validateJsonRpcBatch([
      { jsonrpc: '2.0', id: 1, method: 'tasks/get' },
      { jsonrpc: '1.0', id: 2, method: 'bad' },
    ])
    expect(result.valid).toBe(false)
  })

  it('rejects batch with non-object element', () => {
    const result = validateJsonRpcBatch([
      { jsonrpc: '2.0', id: 1, method: 'tasks/get' },
      'not an object',
    ])
    expect(result.valid).toBe(false)
  })
})
