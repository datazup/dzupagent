import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '@dzupagent/agent-types'
import { HttpMemoryClient, HttpMemoryError, NotImplementedError } from '../http-client.js'

// DZM-P2c: HttpMemoryClient is a live wire client. NotImplementedError is
// deprecated and must stay unreachable from every client outcome path.

const scope = { tenantId: 'tenant-1' }
const record: MemoryRecord = {
  id: 'record-1', namespace: 'facts', scope, content: 'remember this',
  createdAt: 1, updatedAt: 2,
}

type FetchImpl = typeof fetch

function clientWith(fetchImpl: FetchImpl, timeoutMs = 1000): HttpMemoryClient {
  return new HttpMemoryClient({ baseUrl: 'https://memory.example', fetch: fetchImpl, timeoutMs })
}

const respond = (body: string | null, status = 200): FetchImpl =>
  async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })

// Like real fetch: rejects at once on an already-aborted signal, else waits for abort.
const hang: FetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
  const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
  if (init?.signal?.aborted) abort()
  else init?.signal?.addEventListener('abort', abort)
})

function operate(op: 'get' | 'put' | 'delete', client: HttpMemoryClient, signal?: AbortSignal): Promise<unknown> {
  switch (op) {
    case 'get': return client.get('facts', scope, undefined, signal ? { signal } : undefined)
    case 'put': return client.put('facts', scope, record, signal ? { signal } : undefined)
    case 'delete': return client.delete('facts', scope, 'record-1')
  }
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (err) {
    return err
  }
}

describe('HttpMemoryClient liveness (NotImplementedError is unreachable)', () => {
  it.each([
    ['get', respond(JSON.stringify([record]))],
    ['put', respond(null, 204)],
    ['delete', respond(null, 204)],
  ] as const)('%s succeeds over mocked fetch', async (op, fetchImpl) => {
    expect(await settle(operate(op, clientWith(fetchImpl)))).toBeUndefined()
  })

  const failures: Array<[string, FetchImpl]> = [
    ['HTTP 500', respond('{"message":"down"}', 500)],
    ['HTTP 404', respond('{"message":"missing"}', 404)],
    ['network error', async () => { throw new TypeError('fetch failed') }],
    ['invalid body', respond('{', 200)],
  ]

  for (const op of ['get', 'put', 'delete'] as const) {
    it.each(failures)(`${op} maps %s to HttpMemoryError, never NotImplementedError`, async (_name, fetchImpl) => {
      const err = await settle(operate(op, clientWith(fetchImpl)))
      if (op === 'put' && _name === 'invalid body') {
        // PUT has no response-body contract; a 200 with any body is success.
        expect(err).toBeUndefined()
        return
      }
      expect(err).toBeInstanceOf(HttpMemoryError)
      expect(err).not.toBeInstanceOf(NotImplementedError)
    })

    it(`${op} maps a timeout to HttpMemoryError, never NotImplementedError`, async () => {
      const err = await settle(operate(op, clientWith(hang, 5)))
      expect(err).toBeInstanceOf(HttpMemoryError)
      expect(err).not.toBeInstanceOf(NotImplementedError)
    })
  }

  it.each(['get', 'put'] as const)('%s maps caller abort to HttpMemoryError, never NotImplementedError', async (op) => {
    const controller = new AbortController()
    controller.abort()
    const err = await settle(operate(op, clientWith(hang), controller.signal))
    expect(err).toBeInstanceOf(HttpMemoryError)
    expect(err).not.toBeInstanceOf(NotImplementedError)
  })

  it('input validation rejects with a plain Error before any fetch', async () => {
    let calls = 0
    const client = clientWith(async () => { calls++; return new Response(null, { status: 204 }) })
    for (const attempt of [
      client.get('', scope),
      client.put('facts', { tenantId: '' }, record),
      client.delete('facts', scope, ' '),
    ]) {
      const err = await settle(attempt)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(NotImplementedError)
    }
    expect(calls).toBe(0)
  })

  it('no source file in @dzupagent/memory constructs NotImplementedError', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url))
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__') walk(path)
        } else if (name.endsWith('.ts') && /\bnew\s+[\w.]*NotImplementedError\b/.test(readFileSync(path, 'utf8'))) {
          offenders.push(path)
        }
      }
    }
    walk(srcRoot)
    expect(offenders).toEqual([])
  })
})
