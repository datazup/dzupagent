/**
 * A2A SSE streaming client — thin re-export barrel.
 *
 * The implementation is split into focused sibling modules:
 *   - a2a-sse-stream-types.ts     — A2ASSEConfig, SSEEvent, A2A event payload
 *                                   types, internal StreamEndSignal class
 *   - a2a-sse-stream-parser.ts    — parseSSEEvents (WHATWG SSE parsing) and
 *                                   convertA2AEventToForgeMessage helpers
 *   - a2a-sse-stream-reconnect.ts — sleepWithSignal helper used by the
 *                                   reconnect loop
 *   - a2a-sse-stream-client.ts    — streamA2ATask async generator that drives
 *                                   the connect/read/reconnect lifecycle
 */
export type { A2ASSEConfig, SSEEvent } from './a2a-sse-stream-types.js'
export { parseSSEEvents } from './a2a-sse-stream-parser.js'
export { streamA2ATask } from './a2a-sse-stream-client.js'
