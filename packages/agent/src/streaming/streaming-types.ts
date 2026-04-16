/**
 * Streaming event types for real-time agent output.
 *
 * These are more granular than the legacy `AgentStreamEvent` in agent-types.ts,
 * providing distinct event shapes for text deltas, tool lifecycle, completion,
 * and errors. Designed for consumption by SSE transport layers and playgrounds.
 */

/**
 * Union of all events that can be emitted during an agent stream.
 *
 * Discriminated on the `type` field for safe narrowing:
 * ```typescript
 * for await (const event of handle.events()) {
 *   switch (event.type) {
 *     case 'text_delta': console.log(event.content); break;
 *     case 'tool_call_start': console.log(`calling ${event.toolName}`); break;
 *     case 'tool_call_end': console.log(`result: ${event.result}`); break;
 *     case 'done': console.log(`final: ${event.finalOutput}`); break;
 *     case 'error': console.error(event.error); break;
 *   }
 * }
 * ```
 */
export type StreamEvent =
  | TextDeltaEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | DoneEvent
  | ErrorEvent

export interface TextDeltaEvent {
  readonly type: 'text_delta'
  /** The partial text content to append. */
  readonly content: string
}

export interface ToolCallStartEvent {
  readonly type: 'tool_call_start'
  /** Name of the tool being invoked. */
  readonly toolName: string
  /** Unique identifier for this tool call (used to correlate with tool_call_end). */
  readonly callId: string
}

export interface ToolCallEndEvent {
  readonly type: 'tool_call_end'
  /** Matches the callId from the corresponding tool_call_start event. */
  readonly callId: string
  /** The result returned by the tool (string, object, etc.). */
  readonly result: unknown
}

export interface DoneEvent {
  readonly type: 'done'
  /** The accumulated final output of the agent run. */
  readonly finalOutput: string
}

export interface ErrorEvent {
  readonly type: 'error'
  /** The error that occurred. */
  readonly error: Error
}
