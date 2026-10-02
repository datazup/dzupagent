import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '@dzupagent/agent-types'
import { HttpMemoryClient, HttpMemoryResponseError } from '../http-client.js'

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
