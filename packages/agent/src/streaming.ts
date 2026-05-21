/**
 * @dzupagent/agent/streaming — streaming run handles and stream event types.
 *
 * Re-exports the streaming subsystem for hosts that bridge agent stream
 * output to HTTP/SSE/WebSocket transports. Use this subpath when wiring
 * StreamingRunHandle to a transport-specific adapter.
 */

export * from './streaming/index.js'
