import { describe, it, expect } from 'vitest'
import {
  extractEndpoints,
  extractAPICalls,
  validateContracts,
} from '../quality/contract-validator.js'

// ---------------------------------------------------------------------------
// extractEndpoints
// ---------------------------------------------------------------------------

describe('extractEndpoints', () => {
  it('extracts router.get endpoints', () => {
    const files = { 'routes.ts': "router.get('/users', handler)" }
    const eps = extractEndpoints(files)
    expect(eps).toHaveLength(1)
    expect(eps[0]!.method).toBe('GET')
    expect(eps[0]!.path).toBe('/users')
  })

  it('extracts app.post endpoints', () => {
    const files = { 'routes.ts': "app.post('/items', handler)" }
    const eps = extractEndpoints(files)
    expect(eps[0]!.method).toBe('POST')
  })

  it('extracts multiple endpoints from one file', () => {
    const files = {
      'routes.ts': [
        "router.get('/a', h1)",
        "router.put('/b', h2)",
        "router.delete('/c', h3)",
      ].join('\n'),
    }
    const eps = extractEndpoints(files)
    expect(eps).toHaveLength(3)
  })

  it('returns empty for files with no endpoints', () => {
    expect(extractEndpoints({ 'util.ts': 'const x = 1' })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// extractAPICalls
// ---------------------------------------------------------------------------

describe('extractAPICalls', () => {
  it('extracts axios calls', () => {
    const files = { 'api.ts': "axios.get('/api/users')" }
    const calls = extractAPICalls(files)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.path).toBe('/api/users')
  })

  it('extracts api.post calls', () => {
    const files = { 'api.ts': "api.post('/api/items', data)" }
    const calls = extractAPICalls(files)
    expect(calls[0]!.method).toBe('POST')
  })

  it('extracts fetch calls with default GET', () => {
    const files = { 'client.ts': "fetch('/api/users')" }
    const calls = extractAPICalls(files)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('GET')
  })

  it('extracts fetch calls with explicit method', () => {
    const files = {
      'client.ts': `fetch('/api/users', {
        method: 'POST',
        body: JSON.stringify(data)
      })`,
    }
    const calls = extractAPICalls(files)
    expect(calls[0]!.method).toBe('POST')
  })

  it('extracts http/client method calls', () => {
    const files = { 'api.ts': "http.put('/api/items/1', data)" }
    const calls = extractAPICalls(files)
    expect(calls[0]!.method).toBe('PUT')
  })
})

// ---------------------------------------------------------------------------
// validateContracts
// ---------------------------------------------------------------------------

describe('validateContracts', () => {
  it('reports valid when all calls have matching endpoints', () => {
    const backend = { 'routes.ts': "router.get('/users', handler)" }
    const frontend = { 'api.ts': "axios.get('/users')" }
    const result = validateContracts(backend, frontend)
    expect(result.valid).toBe(true)
    expect(result.issues.filter(i => i.type === 'unmatched-call')).toHaveLength(0)
  })

  it('reports unmatched-call when frontend calls non-existent endpoint', () => {
    const backend = { 'routes.ts': "router.get('/users', handler)" }
    const frontend = { 'api.ts': "axios.get('/orders')" }
    const result = validateContracts(backend, frontend)
    expect(result.valid).toBe(false)
    expect(result.issues.some(i => i.type === 'unmatched-call')).toBe(true)
  })

  it('reports method-mismatch when method differs', () => {
    const backend = { 'routes.ts': "router.get('/users', handler)" }
    const frontend = { 'api.ts': "axios.post('/users')" }
    const result = validateContracts(backend, frontend)
    expect(result.valid).toBe(false)
    expect(result.issues.some(i => i.type === 'method-mismatch')).toBe(true)
  })

  it('reports unmatched-endpoint for endpoints with no frontend calls', () => {
    const backend = {
      'routes.ts': "router.get('/users', handler)\nrouter.get('/orders', handler)",
    }
    const frontend = { 'api.ts': "axios.get('/users')" }
    const result = validateContracts(backend, frontend)
    // Unmatched endpoints are informational, don't make result invalid
    expect(result.issues.some(i => i.type === 'unmatched-endpoint')).toBe(true)
  })

  it('returns valid for empty files', () => {
    const result = validateContracts({}, {})
    expect(result.valid).toBe(true)
    expect(result.endpoints).toHaveLength(0)
    expect(result.calls).toHaveLength(0)
  })
})
