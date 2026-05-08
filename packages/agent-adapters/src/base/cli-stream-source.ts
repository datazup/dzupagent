/**
 * CliAdapterStreamSource — bridges a raw CLI subprocess stream (stdout lines or
 * already-parsed JSONL records) to the {@link AdapterStreamSource} contract so
 * any future CLI-backed adapter can plug straight into {@link AdapterStreamRunner}
 * without reimplementing heartbeat, abort, audit, or lifecycle bookkeeping.
 *
 * Most existing CLI adapters (Qwen/Crush/Goose/Gemini) extend
 * {@link BaseCliAdapter}, which already composes {@link AdapterStreamRunner}
 * internally — they do NOT need this class. This wrapper exists for two
 * scenarios:
 *
 *   1. Adapters that need a custom subprocess shape (e.g. multiplexed
 *      stdin/stdout, non-JSONL framing, or interactive REPL loops) that
 *      cannot be modelled inside `BaseCliAdapter.execute()`.
 *   2. Tests / harnesses that want to drive `AdapterStreamRunner` against a
 *      synthetic CLI line stream without spawning a real subprocess.
 *
 * Subclasses implement two hooks:
 *   - {@link openCliStream} — yield raw CLI output (string lines or parsed
 *     records). The caller owns subprocess spawning and abort handling.
 *   - {@link parseCliLine} — convert a single raw line into the typed `TRaw`
 *     event shape that the adapter's `mapRawEvent` will consume. Returning
 *     `null` skips the line (e.g. blank lines, partial JSONL fragments).
 *
 * The base class wires `open` -> `openCliStream` and threads each yielded
 * line through `parseCliLine`. Adapters then override
 * {@link AdapterStreamSource.mapRawEvent} to translate parsed records into
 * `AgentEvent`s, exactly as they would for an SDK adapter.
 *
 * NOTE: this source emits raw `string` lines as `TRaw` so the adapter chooses
 * whether to do JSON parsing, YAML parsing, or simple text splitting in its
 * own `mapRawEvent`. A future variant could parameterise on a parser, but
 * keeping the contract narrow avoids over-fitting to JSONL CLIs.
 */

import type { AdapterProviderId, AgentEvent, AgentInput, TokenUsage } from '../types.js'
import type {
  AdapterStreamSource,
  StreamContext,
  ThreadStartResult,
} from './stream-runner.js'

/**
 * Abstract base implementing {@link AdapterStreamSource} for CLI-backed
 * adapters. Subclasses are responsible for the subprocess lifecycle and the
 * line-by-line semantics; lifecycle/heartbeat/audit handling is delegated
 * upward to {@link AdapterStreamRunner}.
 */
export abstract class CliAdapterStreamSource implements AdapterStreamSource<string> {
  abstract readonly providerId: AdapterProviderId

  /**
   * Yield raw CLI output lines for this run. Implementations typically wrap
   * `spawnAndStreamJsonl` / `spawnAndStreamLines` from `process-helpers` and
   * are expected to honor `signal` cooperatively — when `signal.aborted`
   * becomes true, the generator should return promptly. The runner already
   * combines this signal with any externally-provided cancellation token, so
   * subclasses MUST forward it directly to their child-process spawner.
   */
  abstract openCliStream(input: AgentInput, signal: AbortSignal): AsyncIterable<string>

  /**
   * Convert a single raw CLI line into the adapter's logical raw-event shape.
   * Returning `null` skips the line (useful for blank lines or framing
   * artifacts). The runner does not call `mapRawEvent` for skipped lines, so
   * heartbeats fire normally on quiet streams.
   *
   * Subclasses typically `JSON.parse` the line and shape-check the result.
   */
  abstract parseCliLine(line: string): unknown

  /**
   * Map a parsed CLI record onto one or more `AgentEvent`s, or `null` to
   * suppress emission. Mirrors {@link AdapterStreamSource.mapRawEvent}; we
   * narrow `TRaw = string` here so subclasses receive the *raw* line plus
   * the result of {@link parseCliLine} via the `_parsed` parameter passed
   * back through the runner. (See implementation below.)
   */
  abstract mapParsedEvent(
    parsed: unknown,
    raw: string,
    context: StreamContext,
  ): AgentEvent | AgentEvent[] | null

  // ----- AdapterStreamSource bridge ----------------------------------------

  open(input: AgentInput, signal: AbortSignal): AsyncIterable<string> {
    return this.openCliStream(input, signal)
  }

  /**
   * Default bridge: parse each raw line then defer to `mapParsedEvent`.
   * If `parseCliLine` returns `null` we treat the line as a no-op rather
   * than producing an empty event.
   */
  mapRawEvent(raw: string, context: StreamContext): AgentEvent | AgentEvent[] | null {
    const parsed = this.parseCliLine(raw)
    if (parsed === null || parsed === undefined) return null
    return this.mapParsedEvent(parsed, raw, context)
  }

  /**
   * CLI adapters typically do not stream incremental token usage — pricing
   * is reported (if at all) only on the terminal `completed` record, which
   * `mapParsedEvent` already surfaces via `adapter:completed.usage`. Override
   * if your CLI emits per-line usage deltas you want to capture eagerly.
   */
  extractUsage?(_raw: string): TokenUsage | undefined {
    return undefined
  }

  /**
   * Override when the CLI emits an explicit "session started" frame and you
   * want `adapter:started` to carry that ID rather than a synthetic UUID.
   */
  detectThreadStart?(_raw: string): ThreadStartResult | null {
    return null
  }

  /**
   * Override when the CLI emits keep-alive frames (e.g. blank lines, ping
   * records) that should reset the heartbeat timer. The default is `false`,
   * meaning every line counts as work — which is the safe choice for chatty
   * CLIs and lets the runner log slow-stream warnings on real stalls.
   */
  detectHeartbeat?(_raw: string): boolean {
    return false
  }
}
