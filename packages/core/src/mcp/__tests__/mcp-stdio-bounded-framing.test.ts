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
