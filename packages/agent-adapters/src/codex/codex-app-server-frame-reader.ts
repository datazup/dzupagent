import { StringDecoder } from 'node:string_decoder'

import { CodexAppServerClientError } from './codex-app-server-client-contracts.js'

export interface CodexAppServerFrameReaderLimits {
  readonly maxLineBytes: number
  readonly maxAggregateOutputBytes: number
  readonly maxFrames: number
}

export interface CodexAppServerFrameReaderHandlers {
  /** Receives one non-blank JSONL line. Parsing and dispatch stay with the owner. */
  readonly onFrame: (line: string) => void
  /** Reports a containment breach. The owner is expected to go terminal. */
  readonly onFailure: (error: CodexAppServerClientError) => void
  /**
   * Whether the owner is still accepting frames.
   *
   * Consulted before reading and again after every dispatched frame, because
   * `onFrame` may take the owner terminal synchronously and the remainder of an
   * already-buffered chunk must not then be delivered.
   */
  readonly isActive: () => boolean
}

/**
 * Turns the raw stdout/stderr byte stream of one Codex process into whole
 * JSONL frames, enforcing the containment limits along the way.
 *
 * This layer is deliberately ignorant of JSON-RPC: it decides only *where a
 * frame ends* and *whether the stream has exceeded its budget*. Every limit
 * fails closed, and a breach stops consumption immediately rather than
 * draining the chunk, so a process that floods the pipe cannot force unbounded
 * work after the ceiling is already known to be crossed.
 *
 * Byte accounting spans both pipes: stderr counts toward the aggregate budget
 * but is never framed, so a provider cannot evade the output ceiling by writing
 * its flood to stderr instead.
 */
export class CodexAppServerFrameReader {
  private readonly decoder = new StringDecoder('utf8')
  private stdoutBuffer = ''
  private aggregateOutputBytes = 0
  private frameCount = 0

  constructor(
    private readonly limits: CodexAppServerFrameReaderLimits,
    private readonly handlers: CodexAppServerFrameReaderHandlers,
  ) {}

  accept(chunk: Buffer | string, stdout: boolean): void {
    if (!this.handlers.isActive()) return
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength
    this.aggregateOutputBytes += bytes
    if (this.aggregateOutputBytes > this.limits.maxAggregateOutputBytes) {
      this.handlers.onFailure(new CodexAppServerClientError(
        'CODEX_APP_SERVER_OUTPUT_LIMIT',
        'Codex app-server output exceeded its aggregate limit',
      ))
      return
    }
    if (!stdout) return

    // A multi-byte character may straddle a chunk boundary; the decoder holds
    // the partial sequence back rather than emitting a replacement character
    // that would corrupt the frame.
    this.stdoutBuffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    for (;;) {
      const boundary = this.stdoutBuffer.indexOf('\n')
      if (boundary < 0) break
      const line = this.stdoutBuffer.slice(0, boundary)
      this.stdoutBuffer = this.stdoutBuffer.slice(boundary + 1)
      if (Buffer.byteLength(line, 'utf8') > this.limits.maxLineBytes) {
        this.failLineLimit()
        return
      }
      if (line.trim().length === 0) continue
      this.frameCount += 1
      if (this.frameCount > this.limits.maxFrames) {
        this.handlers.onFailure(new CodexAppServerClientError(
          'CODEX_APP_SERVER_FRAME_LIMIT',
          'Codex app-server emitted too many frames',
        ))
        return
      }
      this.handlers.onFrame(line)
      if (!this.handlers.isActive()) return
    }
    // An unterminated remainder is checked too: without this, a process could
    // hold the line limit open forever by never emitting a newline.
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.limits.maxLineBytes) {
      this.failLineLimit()
    }
  }

  private failLineLimit(): void {
    this.handlers.onFailure(new CodexAppServerClientError(
      'CODEX_APP_SERVER_LINE_LIMIT',
      'Codex app-server frame exceeded its line limit',
    ))
  }
}
