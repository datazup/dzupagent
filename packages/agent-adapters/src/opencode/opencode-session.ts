import { isIP } from 'node:net'
import { isAbsolute, normalize } from 'node:path'
import type { OpenCodeEvent } from './opencode-sdk-types.js'

export function attachedEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !/^http:\/\//.test(value)) throw new Error('Explicit HTTP loopback baseUrl required')
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = (isIP(host) === 4 && host.split('.')[0] === '127') || host === '::1'
  // Reject alternate numeric spellings normalized by URL (e.g. 2130706433).
  const authority = value.slice(7).split(/[/?#]/)[0] ?? ''
  const literal = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.replace(/:\d+$/, '')
  const literalIp = literal.replace(/^\[|\]$/g, '')
  if (!loopback || isIP(literalIp) === 0 || url.username || url.password || value.includes('?') || value.includes('#') || url.pathname !== '/') {
    throw new Error('baseUrl must be a numeric loopback HTTP origin without credentials, path, query or fragment')
  }
  return url.origin
}

export function explicitDirectory(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('Explicit absolute cwd required')
  return normalize(value)
}

/** Race without leaving an abort listener or unhandled late rejection. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new Error('OpenCode operation cancelled'))
    }
    if (signal.aborted) { work.catch(() => undefined); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) abort(); else resolve(value)
    }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

export function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('Invalid OpenCode bound')
  return result
}

/** One active turn per owned session, with a bounded, cancellable wait queue. */
export class OpenCodeSessions {
  private readonly owned = new Map<string, { endpoint: string; cwd: string; tail: Promise<void>; pending: number; usable: boolean }>()

  add(id: string, endpoint: string, cwd: string): void {
    if (!id || this.owned.has(id) || this.owned.size >= 128) throw new Error('OpenCode session ownership limit or duplicate')
    this.owned.set(id, { endpoint, cwd, tail: Promise.resolve(), pending: 0, usable: true })
  }

  has(id: string): boolean { return this.owned.has(id) }
  retire(id: string): void { const entry = this.owned.get(id); if (entry) entry.usable = false }
  assertCapacity(): void { if (this.owned.size >= 128) throw new Error('OpenCode session ownership limit') }

  assert(id: string, endpoint: string, cwd: string): void {
    const entry = this.owned.get(id)
    if (!entry || !entry.usable || entry.endpoint !== endpoint || entry.cwd !== cwd) throw new Error('OpenCode resume requires an owned session at the same endpoint and cwd')
  }

  async lock(id: string, endpoint: string, cwd: string, signal: AbortSignal): Promise<() => void> {
    this.assert(id, endpoint, cwd)
    const entry = this.owned.get(id)!
    if (entry.pending >= 16) throw new Error('OpenCode session queue full')
    entry.pending++
    const prior = entry.tail
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    entry.tail = prior.then(() => gate)
    try { await abortable(prior, signal); this.assert(id, endpoint, cwd) } catch (error) {
      // A cancelled waiter still occupies a link in the tail until the prior
      // turn settles. Charge that slot so repeated cancellations cannot grow
      // an unbounded chain behind a hung turn.
      release(); void prior.then(() => { entry.pending-- }); throw error
    }
    let released = false
    return () => { if (!released) { released = true; entry.pending--; release() } }
  }
}

/** Bounded event queue; overflow fails the turn rather than dropping permissions. */
export class OpenCodeQueue<T> {
  private readonly values: T[] = []
  private wake: (() => void) | undefined
  private error: Error | undefined
  private closed = false
  constructor(private readonly limit: number, private readonly onFailure?: (error: Error) => void) {}
  push(value: T): void {
    if (this.closed) return
    if (this.values.length >= this.limit) { this.fail(new Error('OpenCode event queue overflow')); return }
    this.values.push(value); this.wake?.(); this.wake = undefined
  }
  fail(error: Error): void {
    if (this.closed) return
    this.error = error; this.closed = true; this.wake?.(); this.wake = undefined
    this.onFailure?.(error)
  }
  end(): void { this.closed = true; this.wake?.(); this.wake = undefined }
  async next(signal: AbortSignal): Promise<T | undefined> {
    while (!this.values.length && !this.closed) {
      try { await abortable(new Promise<void>(resolve => { this.wake = resolve }), signal) }
      finally { this.wake = undefined }
    }
    if (signal.aborted) throw new Error('OpenCode operation cancelled')
    if (this.error) throw this.error
    return this.values.shift()
  }
}

/** The v1 SSE helper has no fetch injection in its declared options. Keep the
 * event transport on the same bounded fetch as the SDK's ordinary requests.
 * One connection, no reconnect or replay; directory scoped, session filtered
 * by the caller before any event is acted on.
 */
export async function* subscribeEvents(fetcher: typeof globalThis.fetch, endpoint: string, cwd: string, signal: AbortSignal, maxBytes: number): AsyncGenerator<OpenCodeEvent> {
  const url = new URL('/event', endpoint)
  url.searchParams.set('directory', cwd)
  const response = await abortable(fetcher(url, { signal, headers: { accept: 'text/event-stream' } }), signal)
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('OpenCode event subscription failed')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  try {
    while (true) {
      const next = await abortable(reader.read(), signal)
      if (next.done) return
      buffer += decoder.decode(next.value, { stream: true })
      if (Buffer.byteLength(buffer) > maxBytes) throw new Error('OpenCode SSE frame limit exceeded')
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (line === '') {
          if (data.length) {
            let event: unknown
            try { event = JSON.parse(data.join('\n')) } catch { throw new Error('Invalid OpenCode SSE data') }
            data = []
            if (!event || typeof event !== 'object' || !('type' in event) || !('properties' in event)) throw new Error('Invalid OpenCode SSE event')
            yield event as OpenCodeEvent
          }
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
          if (Buffer.byteLength(data.join('\n')) > maxBytes) throw new Error('OpenCode SSE frame limit exceeded')
        }
      }
    }
  } finally { void reader.cancel().catch(() => undefined) }
}
