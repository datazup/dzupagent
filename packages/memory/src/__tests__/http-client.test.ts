import { describe, expect, it, vi } from 'vitest'
import type { MemoryRecord } from '@dzupagent/agent-types'
import { HttpMemoryClient, HttpMemoryResponseError, type HttpMemoryRequestResult } from '../http-client.js'

const scope = { tenantId: 'tenant-1' }
const record: MemoryRecord = {
  id: 'record-1', namespace: 'facts', scope, content: 'remember this',
  createdAt: 1, updatedAt: 2,
}

function clientFor(body: string | null, status = 200): HttpMemoryClient {
  return new HttpMemoryClient({
    baseUrl: 'https://memory.example',
    fetch: async () => new Response(body, { status }),
  })
}

describe('HttpMemoryClient response contract', () => {
  it.each([
    ['array', [record]],
    ['envelope', { records: [record] }],
    ['optional metadata and scopes', [{ ...record, metadata: { flag: true }, scope: { ...scope, projectId: 'project-1' } }]],
    ['empty array', []],
    ['empty envelope', { records: [] }],
  ])('GET preserves valid %s', async (_name, payload) => {
    const expected = Array.isArray(payload) ? payload : payload.records
    await expect(clientFor(JSON.stringify(payload)).get('facts', scope)).resolves.toEqual(expected)
  })

  it.each([
    ['missing body', ''],
    ['invalid JSON', '{'],
    ['null', 'null'],
    ['boolean', 'true'],
    ['number', '42'],
    ['string', '"records"'],
    ['missing records', '{}'],
    ['null records', '{"records":null}'],
    ['object records', '{"records":{}}'],
    ['string records', '{"records":"[]"}'],
  ])('GET rejects %s with a typed response error', async (_name, body) => {
    await expect(clientFor(body).get('facts', scope)).rejects.toMatchObject({
      name: 'HttpMemoryResponseError', operation: 'get', status: 200,
      errorCode: 'HTTP_MEMORY_INVALID_RESPONSE',
    })
  })

  const malformedRecords: Array<[string, unknown]> = [
    ['null', null], ['primitive', 'record'], ['array', []], ['missing fields', {}],
    ['invalid id', { ...record, id: 1 }],
    ['empty id', { ...record, id: '' }],
    ['wrong namespace', { ...record, namespace: 'other' }],
    ['invalid namespace', { ...record, namespace: 1 }],
    ['missing scope', { ...record, scope: undefined }],
    ['null scope', { ...record, scope: null }],
    ['invalid tenant', { ...record, scope: { tenantId: 1 } }],
    ['foreign tenant', { ...record, scope: { tenantId: 'other' } }],
    ['invalid optional scope', { ...record, scope: { ...scope, taskId: 3 } }],
    ['invalid content', { ...record, content: 1 }],
    ['missing createdAt', { ...record, createdAt: undefined }],
    ['invalid createdAt', { ...record, createdAt: '1' }],
    ['invalid updatedAt', { ...record, updatedAt: null }],
    ['invalid metadata', { ...record, metadata: [] }],
    ['null metadata', { ...record, metadata: null }],
  ]

  it.each(malformedRecords)('GET rejects %s records in either wire form', async (_name, invalid) => {
    for (const payload of [[record, invalid], { records: [record, invalid] }]) {
      await expect(clientFor(JSON.stringify(payload)).get('facts', scope)).rejects.toMatchObject({
        name: 'HttpMemoryResponseError', operation: 'get', status: 200,
        errorCode: 'HTTP_MEMORY_INVALID_RESPONSE',
      })
    }
  })

  it('GET rejects non-finite timestamps from otherwise valid JSON', async () => {
    const body = JSON.stringify([record]).replace('"createdAt":1', '"createdAt":1e400')
    await expect(clientFor(body).get('facts', scope)).rejects.toBeInstanceOf(HttpMemoryResponseError)
  })

  it.each([201, 202, 204, 205, 206])('GET rejects unexpected successful status %s', async (status) => {
    await expect(clientFor(status === 204 || status === 205 ? null : '[]', status).get('facts', scope))
      .rejects.toMatchObject({ name: 'HttpMemoryResponseError', operation: 'get', status })
  })

  it.each([200, 201, 204])('PUT accepts status %s', async (status) => {
    await expect(clientFor(null, status).put('facts', scope, record)).resolves.toBeUndefined()
  })

  it.each([202, 205, 206])('PUT rejects unexpected successful status %s', async (status) => {
    await expect(clientFor(null, status).put('facts', scope, record))
      .rejects.toMatchObject({ name: 'HttpMemoryResponseError', operation: 'put', status })
  })

  it.each([
    ['boolean true', true, true], ['boolean false', false, false],
    ['deleted true', { deleted: true }, true], ['deleted false', { deleted: false }, false],
    ['ok true', { ok: true }, true], ['ok false', { ok: false }, false],
  ])('DELETE preserves %s', async (_name, payload, expected) => {
    await expect(clientFor(JSON.stringify(payload)).delete('facts', scope, record.id)).resolves.toBe(expected)
  })

  it('DELETE preserves bodyless 204', async () => {
    await expect(clientFor(null, 204).delete('facts', scope, record.id)).resolves.toBe(true)
  })

  it.each(['', '{', 'null', '[]', '42', '{}', '{"deleted":"true"}', '{"ok":1}'])
    ('DELETE rejects malformed acknowledgement %s', async (body) => {
      await expect(clientFor(body).delete('facts', scope, record.id)).rejects.toMatchObject({
        name: 'HttpMemoryResponseError', operation: 'delete', status: 200,
        errorCode: 'HTTP_MEMORY_INVALID_RESPONSE',
      })
    })

  it.each([201, 202, 205, 206])('DELETE rejects unexpected successful status %s', async (status) => {
    await expect(clientFor(status === 205 ? null : 'true', status).delete('facts', scope, record.id))
      .rejects.toMatchObject({ name: 'HttpMemoryResponseError', operation: 'delete', status })
  })

  it.each([400, 404, 500, 503])('preserves HTTP error mapping for status %s', async (status) => {
    const client = clientFor('{"message":"backend error","code":"BACKEND_ERROR"}', status)
    // The error mapper decodes JSON when the transport declares its content type.
    await expect(client.get('facts', scope)).rejects.toMatchObject({
      name: 'HttpMemoryResponseError', operation: 'get', status,
    })
  })
})

// DZM-P4: every scope field the request supplies must match the record, not only tenantId.
describe('HttpMemoryClient workspace/project scope enforcement', () => {
  const narrow = { tenantId: 'tenant-1', workspaceId: 'ws-1', projectId: 'project-1', taskId: 'task-1' }
  const own: MemoryRecord = { ...record, scope: narrow }
  const foreign: Array<[string, MemoryRecord['scope']]> = [
    ['foreign workspace', { ...narrow, workspaceId: 'ws-2' }],
    ['foreign project', { ...narrow, projectId: 'project-2' }],
    ['foreign task', { ...narrow, taskId: 'task-2' }],
    ['missing workspace', { tenantId: 'tenant-1', projectId: 'project-1', taskId: 'task-1' }],
  ]

  it.each(foreign)('GET rejects a %s record', async (_name, recordScope) => {
    const body = JSON.stringify([own, { ...own, id: 'record-2', scope: recordScope }])
    await expect(clientFor(body).get('facts', narrow)).rejects.toMatchObject({
      name: 'HttpMemoryResponseError', operation: 'get', errorCode: 'HTTP_MEMORY_INVALID_RESPONSE',
    })
  })

  it.each(foreign)('PUT refuses a %s record before any request', async (_name, recordScope) => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    const client = new HttpMemoryClient({ baseUrl: 'https://memory.example', fetch })
    await expect(client.put('facts', narrow, { ...own, scope: recordScope })).rejects.toThrow(/scope/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts records matching every supplied field and leaves omitted fields unconstrained', async () => {
    await expect(clientFor(JSON.stringify([own])).get('facts', narrow)).resolves.toEqual([own])
    const wsScope = { tenantId: 'tenant-1', workspaceId: 'ws-1' }
    await expect(clientFor(JSON.stringify([own])).get('facts', wsScope)).resolves.toEqual([own])
    await expect(clientFor(null, 204).put('facts', wsScope, own)).resolves.toBeUndefined()
  })
})

// DZUPAGENT-GAP4-06-20261003-R1: diagnostics describe the validated result.
describe('HttpMemoryClient terminal diagnostics', () => {
  it.each([
    ['get', '{'], ['get', '{}'], ['get', '[null]'],
    ['get', JSON.stringify([{ ...record, namespace: 'foreign' }])],
    ['delete', '{'], ['delete', '{}'], ['delete', '{"deleted":"true"}'],
  ] as const)('%s rejects %s with exactly one failed diagnostic', async (operation, body) => {
    const results: HttpMemoryRequestResult[] = []
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.example', fetch: async () => new Response(body),
      onRequestResult: (result) => { results.push(result) },
    })
    await expect(operation === 'get' ? client.get('facts', scope) : client.delete('facts', scope, record.id))
      .rejects.toMatchObject({ name: 'HttpMemoryResponseError', errorCode: 'HTTP_MEMORY_INVALID_RESPONSE' })
    expect(results).toEqual([{
      signal: 'http_memory_client_request_result', operation, namespace: 'facts',
      status: 200, outcome: 'response_error', errorCode: 'HTTP_MEMORY_INVALID_RESPONSE',
    }])
  })

  it.each([
    ['get', JSON.stringify([record]), 200], ['get', JSON.stringify({ records: [record] }), 200],
    ['put', null, 200], ['put', null, 201], ['put', null, 204],
    ['delete', 'true', 200], ['delete', 'false', 200],
    ['delete', '{"deleted":false}', 200], ['delete', '{"ok":true}', 200],
    ['delete', null, 204],
  ] as const)('%s valid body/status %s/%s emits exactly one success', async (operation, body, status) => {
    const results: HttpMemoryRequestResult[] = []
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.example', fetch: async () => new Response(body, { status }),
      onRequestResult: (result) => { results.push(result) },
    })
    if (operation === 'get') await client.get('facts', scope)
    else if (operation === 'put') await client.put('facts', scope, record)
    else await client.delete('facts', scope, record.id)
    expect(results).toEqual([{
      signal: 'http_memory_client_request_result', operation, namespace: 'facts', status, outcome: 'success',
    }])
  })

  it('does not report success before a delayed body has been read and validated', async () => {
    const results: HttpMemoryRequestResult[] = []
    let entered!: () => void
    let release!: (body: string) => void
    const enteredBody = new Promise<void>((resolve) => { entered = resolve })
    const body = new Promise<string>((resolve) => { release = resolve })
    const response = new Response()
    vi.spyOn(response, 'text').mockImplementation(() => { entered(); return body })
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.example', fetch: async () => response,
      onRequestResult: (result) => { results.push(result) },
    })
    const pending = client.get('facts', scope)
    await enteredBody
    expect(results).toEqual([])
    release(JSON.stringify([record]))
    await expect(pending).resolves.toEqual([record])
    expect(results).toHaveLength(1)
    expect(results[0]?.outcome).toBe('success')
  })

  it.each([400, 404, 500, 503])('keeps one HTTP error diagnostic and mapping for %s', async (status) => {
    const results: HttpMemoryRequestResult[] = []
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.example',
      fetch: async () => new Response('{"message":"backend error","code":"BACKEND_ERROR"}', {
        status, headers: { 'Content-Type': 'application/json' },
      }),
      onRequestResult: (result) => { results.push(result) },
    })
    await expect(client.get('facts', scope)).rejects.toMatchObject({
      name: 'HttpMemoryResponseError', status, errorCode: 'BACKEND_ERROR',
    })
    expect(results).toEqual([{
      signal: 'http_memory_client_request_result', operation: 'get', namespace: 'facts',
      status, outcome: 'http_error', errorCode: 'BACKEND_ERROR',
    }])
  })

  it.each(['valid', 'invalid', 'http-error'] as const)('isolates a throwing diagnostics callback for %s', async (kind) => {
    const onRequestResult = vi.fn(() => { throw new Error('diagnostic listener failed') })
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.example',
      fetch: async () => new Response(kind === 'valid' ? JSON.stringify([record]) : '{}', {
        status: kind === 'http-error' ? 503 : 200,
      }), onRequestResult,
    })
    if (kind === 'valid') await expect(client.get('facts', scope)).resolves.toEqual([record])
    else await expect(client.get('facts', scope)).rejects.toBeInstanceOf(HttpMemoryResponseError)
    expect(onRequestResult).toHaveBeenCalledOnce()
  })
})
