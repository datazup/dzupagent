import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ForgeError } from '../../errors/forge-error.js'
import { createOpenAIImagesProvider } from '../image-generation.js'
import { createUnixSocketFetch } from '../unix-socket-fetch.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9])
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function serve(handler: http.RequestListener): Promise<{ socketPath: string; requests: () => number }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'dzup-usf-'))
  const socketPath = path.join(dir, 's.sock')
  let count = 0
  const server = http.createServer((req, res) => {
    count += 1
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { socketPath, requests: () => count }
}

const readAll = (req: http.IncomingMessage) => new Promise<string>((resolve) => {
  let body = ''
  req.setEncoding('utf8').on('data', (c: string) => { body += c }).on('end', () => resolve(body))
})

describe('createUnixSocketFetch', () => {
  it('refuses a socket path that is not absolute', () => {
    for (const socketPath of ['', 'rel/s.sock', '/x\0y', undefined]) {
      expect(() => createUnixSocketFetch({ socketPath } as never)).toThrow(ForgeError)
    }
  })

  it('sends method, path, headers and body over the socket and streams the reply', async () => {
    const { socketPath } = await serve(async (req, res) => {
      const body = await readAll(req)
      res.writeHead(201, { 'content-type': 'application/json', 'x-echo': 'yes' })
      res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization, len: req.headers['content-length'], body }))
    })
    const f = createUnixSocketFetch({ socketPath })
    const res = await f('http://meter/openai/v1/images/generations?x=1', {
      method: 'post', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: '{"a":"é"}',
    })
    expect(res.status).toBe(201)
    expect(res.headers.get('x-echo')).toBe('yes')
    expect(await res.json()).toEqual({ method: 'POST', url: '/openai/v1/images/generations?x=1', host: 'meter', auth: 'Bearer t', len: '10', body: '{"a":"é"}' })
  })

  it('returns a null body for 204 and accepts URL and Request inputs', async () => {
    const { socketPath } = await serve((_req, res) => { res.writeHead(204); res.end() })
    const f = createUnixSocketFetch({ socketPath })
    expect((await f(new URL('http://m/a'))).body).toBeNull()
    expect((await f(new Request('http://m/b'))).status).toBe(204)
  })

  it('inherits method, headers and signal from a Request, and lets init override them', async () => {
    const { socketPath, requests } = await serve(async (req, res) => {
      res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, body: await readAll(req) }))
    })
    const f = createUnixSocketFetch({ socketPath })
    const req = new Request('http://m/x', { method: 'DELETE', headers: { authorization: 'Bearer r' } })
    expect(await (await f(req)).json()).toEqual({ method: 'DELETE', auth: 'Bearer r', body: '' })
    const posted = new Request('http://m/x', { method: 'POST', headers: { authorization: 'Bearer r' }, body: 'payload' })
    expect(await (await f(posted, { body: 'over' })).json()).toEqual({ method: 'POST', auth: 'Bearer r', body: 'over' })
    expect(await (await f(req, { method: 'PUT', headers: { authorization: 'Bearer i' } })).json()).toEqual({ method: 'PUT', auth: 'Bearer i', body: '' })
    const before = requests()
    await expect(f(posted)).rejects.toBeInstanceOf(TypeError)
    const controller = new AbortController()
    controller.abort(new Error('request signal'))
    await expect(f(new Request('http://m/x', { signal: controller.signal }))).rejects.toThrow('request signal')
    expect(requests()).toBe(before)
  })

  it('refuses non-http URLs and unsupported bodies without connecting', async () => {
    const { socketPath, requests } = await serve((_req, res) => res.end())
    const f = createUnixSocketFetch({ socketPath })
    await expect(f('https://meter/x')).rejects.toBeInstanceOf(TypeError)
    await expect(f('http://meter/x', { method: 'POST', body: new Blob(['x']) })).rejects.toBeInstanceOf(TypeError)
    expect(requests()).toBe(0)
  })

  it('rejects a pre-aborted signal without connecting', async () => {
    const { socketPath, requests } = await serve((_req, res) => res.end())
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(createUnixSocketFetch({ socketPath })('http://m/x', { signal: controller.signal })).rejects.toThrow('stop')
    expect(requests()).toBe(0)
  })

  it('aborts a request in flight and a body being read', async () => {
    let arrived!: () => void
    const seen = new Promise<void>((resolve) => { arrived = resolve })
    const { socketPath } = await serve((req, res) => {
      if (req.url === '/hang') { arrived(); return }
      res.writeHead(200)
      res.write('partial')
    })
    const f = createUnixSocketFetch({ socketPath })
    const c1 = new AbortController()
    const pending = f('http://m/hang', { signal: c1.signal })
    await seen
    c1.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const c2 = new AbortController()
    const res = await f('http://m/body', { signal: c2.signal })
    const reader = res.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    c2.abort()
    await expect(reader.read()).rejects.toBeDefined()
  })

  it('rejects with a TypeError when nothing listens on the socket', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dzup-usf-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    await expect(createUnixSocketFetch({ socketPath: path.join(dir, 'none.sock') })('http://m/x')).rejects.toBeInstanceOf(TypeError)
  })

  it('carries the OpenAI images provider to a metering proxy on the socket', async () => {
    let seen: { url?: string; auth?: string; body?: unknown } = {}
    const { socketPath } = await serve(async (req, res) => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(await readAll(req)) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }], usage: { input_tokens: 20, output_tokens: 100 } }))
    })
    const provider = createOpenAIImagesProvider({
      resolveCredential: () => 'meter-client-token',
      baseUrl: 'http://meter/openai/v1',
      fetchImpl: createUnixSocketFetch({ socketPath }),
    })
    const result = await provider.generate({ model: 'gpt-image-2.6-flare', prompt: 'a form', size: '1024x1024', quality: 'low', complexity: 'low' })
    expect(Array.from(result.bytes)).toEqual(Array.from(PNG))
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 100 })
    expect(seen.url).toBe('/openai/v1/images/generations')
    expect(seen.auth).toBe('Bearer meter-client-token')
    expect(seen.body).toEqual({ model: 'gpt-image-2.6-flare', prompt: 'a form', size: '1024x1024', quality: 'low', output_format: 'png', n: 1, complexity: 'low' })
  })
})
