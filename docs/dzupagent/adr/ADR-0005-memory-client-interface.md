# ADR-0005: MemoryClient Interface

## Status

Accepted — 2026-05-04

## Context

`@dzupagent/agent` currently uses `await import('@dzupagent/memory-ipc')` inside
`memory-context-loader.ts` to lazy-load the Arrow IPC runtime. This pattern has
several drawbacks identified in the agent audit (AG-06, Agent/High):

- **Hidden runtime dependency.** The dynamic import is invisible to package
  manifest tooling and dependency-graph linters; static analysis cannot detect
  the coupling.
- **Untestable.** Consumers of `@dzupagent/agent` cannot inject a fake memory
  transport for tests without monkey-patching `import()`.
- **Tight coupling to one transport.** The agent framework is implicitly
  bound to Arrow IPC, even though the conceptual contract is just
  `get`/`put`/`delete`/`subscribe`.
- **Boundary leak.** A core framework package should depend on contracts, not
  on a specific transport implementation.

## Decision

Introduce a first-class `MemoryClient` interface in `@dzupagent/agent-types`
(the layer-0 contracts package). The agent accepts a `MemoryClient` via
constructor injection (`DzupAgentConfig.memoryClient`).

Three implementations are provided across the existing memory packages:

1. **`InMemoryMemoryClient`** (`@dzupagent/memory`) — in-process Map-backed
   client for development, tests, and single-process deployments.
2. **`IpcMemoryClient`** (`@dzupagent/memory-ipc`) — production transport that
   wraps the Arrow IPC runtime.
3. **`HttpMemoryClient`** (`@dzupagent/memory`) — stub for a future remote
   memory service. Methods throw `NotImplementedError` until the wire protocol
   is finalised.

A backwards-compatibility adapter, `memoryServiceToClient`, bridges the
existing `MemoryService` API to `MemoryClient` so consumers can migrate
gradually without rewriting their memory wiring.

## Consequences

### Positive

- The `MemoryClient` contract lives in `@dzupagent/agent-types`, the
  bottom-of-graph layer with no `@dzupagent/*` dependencies.
- Dependency injection is explicit and discoverable through `DzupAgentConfig`.
- Tests can inject a mock client without `vi.mock('@dzupagent/memory-ipc', …)`
  hacks.
- The dynamic `await import('@dzupagent/memory-ipc')` in
  `memory-context-loader.ts` is replaced with a constructor-injected runtime
  loader, removing the hidden dependency from the read path.
- Future transports (HTTP, gRPC, NATS) plug in by implementing the same
  interface.

### Negative / Trade-offs

- The existing `MemoryService` API is richer than `MemoryClient`
  (search, decay, formatForPrompt). `MemoryService` remains the primary
  service surface for advanced features; `MemoryClient` covers the canonical
  CRUD + subscribe contract that crosses the agent boundary.
- Two parallel memory APIs coexist during the migration window. Documentation
  must clarify when to use each.

## Migration Path

1. **Phase 1 (this ADR).** Add `MemoryClient` interface, three implementations,
   and the adapter. The agent accepts both `memory` (legacy) and
   `memoryClient` (new). Remove the dynamic IPC import from
   `memory-context-loader.ts` by accepting a constructor-injected
   `loadArrowRuntime`.
2. **Phase 2.** Migrate internal callers (codegen, evals, server) to construct
   a `MemoryClient` and pass it via `memoryClient`. The `memory` field is
   marked `@deprecated`.
3. **Phase 3.** Remove the legacy `memory` field. Memory features that are
   not on the `MemoryClient` surface (decay, consolidation, healing) move
   to companion services that the application composes alongside the client.

## Related

- AG-06 (Agent/High): "Hidden runtime dependency on `@dzupagent/memory-ipc`"
- `dzupagent/packages/agent/src/agent/memory-context-loader.ts`
- `dzupagent/packages/agent-types/src/memory-client.ts` (new)
