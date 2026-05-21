/**
 * @dzupagent/agent/reflection — post-run reflection analysis and pattern storage.
 *
 * Re-exports the reflection subsystem for hosts that persist reflection
 * summaries and patterns. Use this subpath when implementing a custom
 * RunReflectionStore backend or wiring the in-memory store into a server.
 */

export * from './reflection/index.js'
