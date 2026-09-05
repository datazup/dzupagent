import { PassThrough, Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { DzupAgentMCPServer, serveMCPOverStdio } from '../index.js'

function server(handler = vi.fn(async () => 'ok')) {
  return new DzupAgentMCPServer({
    name: 'bounded-fixture', version: '1',
    tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} }, handler }],
  })
}

function capture(output: PassThrough): unknown[] {
  const frames: unknown[] = []
  output.on('data', (chunk: Buffer) => frames.push(JSON.parse(chunk.toString('utf8')) as unknown))
  return frames
}

const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })

describe('bounded MCP byte framing', () => {
  it('does not copy an entire oversized string chunk while encoding input', async () => {
    const original = Buffer.from
    let largestEncoding = 0
    const encoding = vi.spyOn(Buffer, 'from').mockImplementation(((...args: Parameters<typeof Buffer.from>) => {
      if (typeof args[0] === 'string') largestEncoding = Math.max(largestEncoding, Buffer.byteLength(args[0]))
      return Reflect.apply(original, Buffer, args) as Buffer
    }) as typeof Buffer.from)
    const output = new PassThrough()
    const frames = capture(output)
    try {
      await serveMCPOverStdio(server(), { input: Readable.from(['x'.repeat(2 * 1024 * 1024) + '\n']), output, error: new PassThrough(), maxFrameBytes: 64 })
    } finally {
      encoding.mockRestore()
    }
    expect(largestEncoding).toBeLessThanOrEqual(4096)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toHaveProperty('error.message', 'MCP input frame too large')
  })

  it('does not repeatedly search the whole suffix of a coalesced notification burst', async () => {
    const burst = Buffer.from((JSON.stringify({ jsonrpc: '2.0', method: 'ping' }) + '\n').repeat(2000))
    const original = Buffer.prototype.indexOf
    let searchedBytes = 0
    const search = vi.spyOn(Buffer.prototype, 'indexOf').mockImplementation(function (this: Buffer, ...args: Parameters<Buffer['indexOf']>) {
      const result = Reflect.apply(original, this, args) as number
      const offset = typeof args[1] === 'number' ? args[1] : 0
      searchedBytes += (result < 0 ? this.length : result + 1) - offset
      return result
    })
    const output = new PassThrough()
    const frames = capture(output)
    try {
      expect(await serveMCPOverStdio(server(), { input: Readable.from([burst]), output, error: new PassThrough() }))
        .toEqual({ framesRead: 2000, responsesWritten: 0, exitReason: 'eof' })
    } finally {
      search.mockRestore()
    }
    expect(searchedBytes).toBeLessThanOrEqual(burst.length * 3)
    expect(frames).toHaveLength(0)
  })

  it('preserves a surrogate pair spanning an internal text encoding slice', async () => {
    const handler = vi.fn(async () => 'ok')
    const prefix = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"'
    const text = 'x'.repeat(1023 - prefix.length) + '😀'
    const frame = prefix + text + '"}}}'
    const output = new PassThrough()
    output.resume()
    await serveMCPOverStdio(server(handler), { input: Readable.from([frame]), output, error: new PassThrough() })
    expect(handler).toHaveBeenCalledExactlyOnceWith({ text })
  })

  it('rejects an oversized unterminated line before waiting for a delimiter', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const frames = capture(output)
    const serving = serveMCPOverStdio(server(), { input, output, error: new PassThrough(), maxFrameBytes: 64 })
    try {
      input.write('x'.repeat(65))
      await setImmediate()
      expect(frames).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP input frame too large' } }])
    } finally {
      input.end()
      await serving
    }
  })

  it('emits only one error for a fragmented oversized line and resumes at the next frame', async () => {
    const output = new PassThrough()
    const frames = capture(output)
    const input = Readable.from(['x'.repeat(65), 'y'.repeat(1000), '\r', '\n', ping, '\n'])
    expect(await serveMCPOverStdio(server(), { input, output, error: new PassThrough(), maxFrameBytes: 64 }))
      .toEqual({ framesRead: 2, responsesWritten: 2, exitReason: 'eof' })
    expect(frames).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP input frame too large' } },
      { jsonrpc: '2.0', id: 1, result: {} },
    ])
  })

  it.each(['\n', '\r\n', '\r', ''])('accepts a UTF-8 frame at the exact byte ceiling with delimiter %j', async (delimiter) => {
    const handler = vi.fn(async () => 'ok')
    const text = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'ž😀' } } })
    const bytes = Buffer.from(text + delimiter)
    const input = Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])))
    const output = new PassThrough()
    const frames = capture(output)
    expect(await serveMCPOverStdio(server(handler), { input, output, error: new PassThrough(), maxFrameBytes: Buffer.byteLength(text) }))
      .toEqual({ framesRead: 1, responsesWritten: 1, exitReason: 'eof' })
    expect(handler).toHaveBeenCalledExactlyOnceWith({ text: 'ž😀' })
    expect(frames[0]).toHaveProperty('result')
  })

  it('measures UTF-8 bytes instead of character count', async () => {
    const handler = vi.fn(async () => 'ok')
    const text = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: '😀😀' } } })
    const output = new PassThrough()
    const frames = capture(output)
    await serveMCPOverStdio(server(handler), { input: Readable.from([text + '\n']), output, error: new PassThrough(), maxFrameBytes: text.length })
    expect(frames[0]).toHaveProperty('error.message', 'MCP input frame too large')
    expect(handler).not.toHaveBeenCalled()
  })

  it('processes multiple coalesced frames and does not invent an empty EOF frame', async () => {
    const output = new PassThrough()
    const frames = capture(output)
    expect(await serveMCPOverStdio(server(), { input: Readable.from([ping + '\r\n' + ping + '\n' + ping]), output, error: new PassThrough() }))
      .toEqual({ framesRead: 3, responsesWritten: 3, exitReason: 'eof' })
    expect(frames).toHaveLength(3)
  })

  it('does not eagerly drain future frames while a handler is blocked', async () => {
    let produced = 0
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const firstStarted = new Promise<void>((resolve) => { started = resolve })
    const handler = vi.fn(async () => { started(); await gate; return 'ok' })
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }) + '\n'
    const input = Readable.from((function* () {
      for (let index = 0; index < 100; index += 1) { produced += 1; yield Buffer.from(frame) }
    })(), { highWaterMark: 1 })
    const output = new PassThrough()
    output.resume()
    const serving = serveMCPOverStdio(server(handler), { input, output, error: new PassThrough() })
    try {
      await firstStarted
      await setImmediate()
      expect(produced).toBeLessThanOrEqual(3)
    } finally {
      release()
      await serving
    }
    expect(handler).toHaveBeenCalledTimes(100)
  })
})
