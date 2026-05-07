import { describe, expect, it } from 'vitest'
import { isSseDone, parseSSEStream, parseSseChunk, parseSseLine } from '../utils/sse-parser.js'

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i]!))
      i++
    },
  })
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of gen) out.push(v)
  return out
}

describe('parseSSEStream (AGENT-119)', () => {
  it('parses a simple sequence of JSON SSE events', async () => {
    const body = streamFromChunks([
      'data: {"i":1}\n',
      'data: {"i":2}\n',
      'data: [DONE]\n',
    ])
    const out = await collect(
      parseSSEStream<{ i: number }>(
        body,
        (line) => JSON.parse(line),
        new AbortController().signal,
      ),
    )
    expect(out).toEqual([{ i: 1 }, { i: 2 }])
  })

  it('skips lines whose deserializer returns null', async () => {
    const body = streamFromChunks([
      'data: {bad json\n',
      'data: {"ok":true}\n',
      'data: [DONE]\n',
    ])
    const out = await collect(
      parseSSEStream<{ ok: boolean }>(
        body,
        (line) => {
          try { return JSON.parse(line) } catch { return null }
        },
        new AbortController().signal,
      ),
    )
    expect(out).toEqual([{ ok: true }])
  })

  it('reassembles events split across read boundaries', async () => {
    const body = streamFromChunks([
      'data: {"i":',
      '1}\ndata: {"i":2}\n',
      'data: [DONE]\n',
    ])
    const out = await collect(
      parseSSEStream<{ i: number }>(
        body,
        (line) => JSON.parse(line),
        new AbortController().signal,
      ),
    )
    expect(out).toEqual([{ i: 1 }, { i: 2 }])
  })

  it('honours abort signal and stops reading', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const body = streamFromChunks(['data: {"i":1}\n'])
    const out = await collect(
      parseSSEStream<{ i: number }>(
        body,
        (line) => JSON.parse(line),
        ctrl.signal,
      ),
    )
    expect(out).toEqual([])
  })
})

describe('parseSseLine (M-09)', () => {
  it('parses a normal data: <json> line', () => {
    expect(parseSseLine('data: {"hello":"world"}')).toEqual({
      done: false,
      json: { hello: 'world' },
    })
  })

  it('parses a line with trailing whitespace', () => {
    expect(parseSseLine('data: {"i":1}\r')).toEqual({
      done: false,
      json: { i: 1 },
    })
  })

  it('returns { done: true } for the [DONE] terminator', () => {
    expect(parseSseLine('data: [DONE]')).toEqual({ done: true })
  })

  it('returns null for malformed JSON', () => {
    expect(parseSseLine('data: {not json')).toBeNull()
  })

  it('returns null for empty lines', () => {
    expect(parseSseLine('')).toBeNull()
    expect(parseSseLine('   ')).toBeNull()
  })

  it('returns null for non-data: lines', () => {
    expect(parseSseLine(': heartbeat')).toBeNull()
    expect(parseSseLine('event: ping')).toBeNull()
  })
})

describe('isSseDone', () => {
  it('returns true for the canonical data: [DONE] form', () => {
    expect(isSseDone('data: [DONE]')).toBe(true)
  })

  it('returns true for the bare [DONE] sentinel (already-stripped data)', () => {
    expect(isSseDone('[DONE]')).toBe(true)
  })

  it('returns true when the line has surrounding whitespace', () => {
    expect(isSseDone('  data: [DONE]  ')).toBe(true)
    expect(isSseDone('  [DONE]  ')).toBe(true)
  })

  it('returns false for a normal JSON data line', () => {
    expect(isSseDone('data: {"i":1}')).toBe(false)
  })

  it('returns false for an empty line', () => {
    expect(isSseDone('')).toBe(false)
  })

  it('returns false for a comment / heartbeat line', () => {
    expect(isSseDone(': ping')).toBe(false)
  })

  it('returns false for a partial DONE token', () => {
    expect(isSseDone('data: [DON]')).toBe(false)
    expect(isSseDone('[done]')).toBe(false)
  })

  it('returns false for an event: line that coincidentally mentions DONE', () => {
    expect(isSseDone('event: [DONE]')).toBe(false)
  })
})

describe('parseSseChunk (M-09)', () => {
  it('parses a multi-line chunk into ordered results', () => {
    const chunk = 'data: {"i":1}\ndata: {"i":2}\ndata: {"i":3}\n'
    expect(parseSseChunk(chunk)).toEqual([
      { done: false, json: { i: 1 } },
      { done: false, json: { i: 2 } },
      { done: false, json: { i: 3 } },
    ])
  })

  it('skips malformed and empty lines', () => {
    const chunk = '\ndata: {bad\ndata: {"ok":true}\n: comment\n'
    expect(parseSseChunk(chunk)).toEqual([
      { done: false, json: { ok: true } },
    ])
  })

  it('terminates at [DONE] and ignores subsequent lines', () => {
    const chunk = 'data: {"i":1}\ndata: [DONE]\ndata: {"i":2}\n'
    expect(parseSseChunk(chunk)).toEqual([
      { done: false, json: { i: 1 } },
      { done: true },
    ])
  })

  it('returns an empty array for an empty chunk', () => {
    expect(parseSseChunk('')).toEqual([])
  })

  it('handles a chunk with only a [DONE] marker', () => {
    expect(parseSseChunk('data: [DONE]\n')).toEqual([{ done: true }])
  })
})
