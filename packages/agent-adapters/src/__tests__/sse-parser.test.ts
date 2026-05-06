import { describe, expect, it } from 'vitest'
import { parseSSEStream } from '../utils/sse-parser.js'

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
