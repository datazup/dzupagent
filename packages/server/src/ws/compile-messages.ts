/**
 * WebSocket message shapes for streaming flow-compiler (`flow:compile_*`)
 * events to a connected client.
 *
 * These messages are layered on top of the generic WS control protocol
 * (`subscribe` / `unsubscribe`) and provide a compile-scoped alternative
 * keyed by `compileId` (UUIDv4 emitted by `@dzupagent/flow-compiler`).
 *
 * Client → Server:
 *   - `subscribe:compile`   — subscribe this socket to a compile stream
 *   - `unsubscribe:compile` — stop receiving compile events for an id
 *
 * Server → Client:
 *   - `compile:event`       — forwarded flow-compiler event envelope
 */

/** Client → Server: subscribe to a compile stream. */
export interface SubscribeCompileMessage {
  type: 'subscribe:compile'
  compileId: string
}

/** Client → Server: stop receiving compile events. */
export interface UnsubscribeCompileMessage {
  type: 'unsubscribe:compile'
  compileId: string
}

/** Server → Client: compile event envelope forwarded to this socket. */
export interface CompileEventMessage {
  type: 'compile:event'
  compileId: string
  event: Record<string, unknown>
}

export type CompileWsMessage =
  | SubscribeCompileMessage
  | UnsubscribeCompileMessage
  | CompileEventMessage
