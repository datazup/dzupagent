# Wave 11 Architecture Decisions

Date: 2026-04-19
Status: Accepted
Scope: `@dzupagent/flow-compiler`, `@dzupagent/flow-ast`, `@dzupagent/core`

Wave 11 closes three follow-ups deferred from Wave 10 E2. This ADR is binding — implementers (`dzupagent-core-dev`, `dzupagent-agent-dev`) must follow the contracts below verbatim. Do not relitigate the locked decisions; raise a new ADR if a contract needs to change after implementation starts.

---

## 1. Context

### 1.1 OI-1 — AsyncToolResolver
`packages/flow-compiler/src/stages/semantic.ts:1` carries a `TODO(wave-11)` that pins Stage 3 semantic resolution to a synchronous `ToolResolver.resolve(ref)`. Callers that back resolution with a remote agent registry, a lazy MCP bootstrap, or a database lookup must currently pre-warm their registry before `compile()`. This pushes accidental complexity out to every integrator and means the compiler cannot natively support async registries.

`packages/flow-ast/src/types.ts:47` documents the synchronous contract:
> Resolution must be synchronous from the compiler's perspective — if async lookup is required, it should be pre-warmed before compile() is invoked.

### 1.2 OI-3 — forwardInnerEvents wiring
`packages/flow-compiler/src/types.ts:13` exposes an `opts.forwardInnerEvents?: boolean` toggle.
`packages/flow-compiler/src/index.ts:64` throws eagerly at factory time:
```ts
if (opts.forwardInnerEvents === true) {
  throw new Error(
    'flow-compiler: forwardInnerEvents is not yet implemented — planned for Wave 11',
  )
}
```
The option exists to propagate per-stage lifecycle events (parse started, shape validated, semantic resolved, lowered) to a shared `DzupEventBus` so the orchestration UI, telemetry, and debug tooling can observe compilation without scraping stdout.

### 1.3 Cleanup — per-kind handle types
`packages/flow-compiler/src/lower/_shared.ts:66-73` defines four handle type aliases all as `unknown`:
```ts
// TODO(wave-11): tighten once core exports per-kind handle types
export type SkillHandle = unknown
export type McpToolHandle = unknown
export type WorkflowHandle = unknown
export type AgentHandle = unknown
```
The `asSkillHandle` / `asMcpToolHandle` / `asWorkflowHandle` / `asAgentHandle` narrowing helpers at lines 75-109 guard the `kind` discriminator but return `unknown`, forcing downstream lowerers into `as any` casts. This must tighten before Wave 12 lowerer work lands.

---

## 2. Decision Summary (locked — do not relitigate)

1. **Breaking change is acceptable.** Workspace grep confirmed only `flow-compiler`'s own tests reference `createFlowCompiler`. No production consumers, no published semver contract to preserve.
2. **`compile()` becomes always-async.** Return type is `Promise<CompileSuccess | CompileFailure>`. No sync overload, no parallel `compileAsync()`. Single API surface minimises maintenance burden; the cost of an unconditional microtask is negligible next to parse + shape-validate + lower.
3. **Event bus is injected** via `CompilerOptions.eventBus?: DzupEventBus`. Required only when `forwardInnerEvents === true`; construct-time throw if the combination is invalid. Cleaner separation of concerns than a self-owned bus, avoids fan-out coordination when multiple subsystems want to subscribe, and sidesteps re-implementing `subscribe()` on the compiler.
4. **`AsyncToolResolver` is a separate interface** parallel to `ToolResolver`. Stage 3 accepts `ToolResolver | AsyncToolResolver` via a duck-typed discriminator on the `resolve()` return type. Synchronous resolvers (in-memory test fixtures) pay zero await overhead; async-only callers (remote agent registries, lazy MCP bootstrap, DB lookups) get a first-class path.
5. **Per-kind handle types live in `@dzupagent/core`**, exported from there and re-imported by `flow-compiler/src/lower/_shared.ts`. Each handle captures the minimum the runtime needs at lowering/invocation time (id + invoke signature + schema), no more.

---

## 3. AsyncToolResolver Interface Contract

### 3.1 Placement
New interface lives next to `ToolResolver` in `packages/flow-ast/src/types.ts` (appended after line 63). flow-ast already hosts `ToolResolver`; keeping async parallel keeps the resolver contract in one place. No runtime imports are introduced — this stays a pure type package.

### 3.2 Shape

```typescript
/**
 * Async variant of {@link ToolResolver} for registries whose lookup
 * cannot be pre-warmed: remote agent registries, lazy MCP bootstrap,
 * database-backed skill stores.
 *
 * Stage 3 semantic resolution accepts `ToolResolver | AsyncToolResolver`
 * and awaits the result when `resolve()` returns a Promise.
 * `listAvailable()` remains synchronous — resolvers that cannot enumerate
 * synchronously must cache their catalogue internally and refresh it
 * out-of-band (see the guidance note below).
 */
export interface AsyncToolResolver {
  /**
   * Look up a reference by name. Returns `null` (not throws) for unknown
   * references so the compiler can aggregate every unresolved ref into a
   * single validation report. Rejection is reserved for infrastructure
   * failure (network, DB) — it surfaces as a Stage 3 error with code
   * `RESOLVER_INFRA_ERROR` (new code; see §3.5).
   */
  resolve(ref: string): Promise<ResolvedTool | null>

  /**
   * Enumerate every ref currently in the resolver's catalogue.
   * MUST be synchronous. Async resolvers should keep a cached catalogue
   * and refresh it on their own schedule (TTL, LISTEN/NOTIFY, etc.) —
   * the compiler calls `listAvailable()` only when emitting suggestions
   * and cannot tolerate a per-suggestion network round-trip.
   */
  listAvailable(): string[]
}
```

### 3.3 Discrimination strategy

**Chosen: duck-typed on the `resolve()` return type.** No `kind: 'sync' | 'async'` brand. Rationale:
- TypeScript structural typing already lets the compiler distinguish `(ref: string) => ResolvedTool | null` from `(ref: string) => Promise<ResolvedTool | null>` at call sites.
- A brand field leaks an implementation detail into every resolver. Integrators would forget to set it; we would need a runtime check anyway.
- Tests can freely swap sync fixtures for async fixtures without changing the brand.

**Runtime detection** inside `semanticResolve`:
```typescript
const result = resolver.resolve(ref)
const resolved = result instanceof Promise ? await result : result
```
This preserves the sync fast path — synchronous resolvers never hit the microtask queue.

### 3.4 Semantic stage signature change

`packages/flow-compiler/src/stages/semantic.ts`:

```typescript
export interface SemanticOptions {
  toolResolver: ToolResolver | AsyncToolResolver
  personaResolver?: PersonaResolver | AsyncPersonaResolver
  suggestionDistance?: number
}

// Returns a Promise unconditionally — even sync resolvers resolve via
// Promise.resolve() internally, at the cost of one microtask per compile.
// This is the price of the single API surface (Decision 2).
export async function semanticResolve(
  ast: FlowNode,
  opts: SemanticOptions,
): Promise<SemanticResult>
```

`AsyncPersonaResolver` mirrors `AsyncToolResolver`:
```typescript
export interface AsyncPersonaResolver {
  resolve(ref: string): Promise<boolean>
}
```
Lives in `packages/flow-compiler/src/types.ts` next to `PersonaResolver`.

### 3.5 New Stage 3 error code

Infrastructure failures (network timeout, DB unavailable) inside `AsyncToolResolver.resolve()` must surface as compile errors, not thrown exceptions. Add:

```typescript
export type ValidationErrorCode =
  | 'UNRESOLVED_TOOL_REF'
  | 'UNRESOLVED_PERSONA_REF'
  | 'EMPTY_BODY'
  | 'INVALID_CONDITION'
  | 'MISSING_REQUIRED_FIELD'
  | 'RESOLVER_INFRA_ERROR'   // NEW
```

`semanticResolve` wraps `await resolver.resolve(ref)` in try/catch; on rejection, it emits a `RESOLVER_INFRA_ERROR` Stage 3 error carrying the original message + node path. No throw escapes the stage boundary.

### 3.6 Worked example — semanticResolve call dispatch

```typescript
async function resolveOne(
  resolver: ToolResolver | AsyncToolResolver,
  ref: string,
  nodePath: string,
  errors: ValidationError[],
): Promise<ResolvedTool | null> {
  try {
    const maybe = resolver.resolve(ref)
    return maybe instanceof Promise ? await maybe : maybe
  } catch (err) {
    errors.push({
      nodeType: 'action',
      nodePath,
      code: 'RESOLVER_INFRA_ERROR',
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
```

---

## 4. Event Payload Schemas

### 4.1 Naming convention

Existing `DzupEventBus` events (see `packages/core/src/events/event-types.ts`) use `<domain>:<verb>` or `<domain>:<noun_verb>` lowercase with colon separator (`agent:started`, `pipeline:node_completed`, `tool:called`). flow-compiler emits lifecycle events during a single compile() call; we use the `flow:compile_<stage>` form to match existing pipeline naming (`pipeline:run_started`).

### 4.2 Event additions to `DzupEvent` union

Append to `packages/core/src/events/event-types.ts` in a new `// --- Flow Compiler ---` section:

```typescript
| { type: 'flow:compile_started'; compileId: string; inputKind: 'object' | 'json-string' }
| { type: 'flow:compile_parsed'; compileId: string; astNodeType: FlowNode['type'] | null; errorCount: number }
| { type: 'flow:compile_shape_validated'; compileId: string; errorCount: number }
| { type: 'flow:compile_semantic_resolved'; compileId: string; resolvedCount: number; personaCount: number; errorCount: number }
| { type: 'flow:compile_lowered'; compileId: string; target: 'skill-chain' | 'workflow-builder' | 'pipeline'; nodeCount: number; edgeCount: number; warningCount: number }
| { type: 'flow:compile_completed'; compileId: string; target: 'skill-chain' | 'workflow-builder' | 'pipeline'; durationMs: number }
| { type: 'flow:compile_failed'; compileId: string; stage: 1 | 2 | 3 | 4; errorCount: number; durationMs: number }
```

### 4.3 Payload design rules

- **`compileId`** — UUIDv4 minted at factory entry per `compile()` call. Correlates every event from one compilation. Exposed on both success and failure return paths via `result.compileId` (new field on `CompileSuccess`/`CompileFailure`) so consumers can join externally.
- **Counts not arrays.** Payloads carry `errorCount` / `nodeCount` / `warningCount`, not the error/node/warning arrays themselves. Full detail lives in the returned `CompilationResult` / `{ errors }`. The bus is for lifecycle telemetry, not structured result shipping — it avoids duplicating large error arrays into every wildcard subscriber.
- **Terminal events.** Exactly one of `flow:compile_completed` or `flow:compile_failed` fires per `compile()`. Stage-intermediate events (`parsed`, `shape_validated`, `semantic_resolved`, `lowered`) fire only when that stage actually runs — e.g. a Stage 1 failure fires `flow:compile_started` then `flow:compile_parsed` (with `errorCount > 0`) then `flow:compile_failed`, skipping shape/semantic/lowered.
- **`target` on `compile_started` is intentionally absent.** Target is only known after Stage 4 routing. `compile_lowered` carries it; `compile_completed` carries it; `compile_failed` does not.
- **No event coalescing.** Every stage emits on entry-exit semantics: stages emit their event only when they complete (or fail). This keeps the event stream linear and ordered.

### 4.4 Ordering contract

For a given `compileId`, events fire in strict temporal order:
```
compile_started
  → compile_parsed            (always, unless input was structurally unreachable)
    → compile_shape_validated (only if parse produced an AST)
      → compile_semantic_resolved (only if stages 1+2 clean)
        → compile_lowered     (only if stage 3 clean)
          → compile_completed
  | compile_failed            (terminal, on any stage failure)
```
Events run through `DzupEventBus.emit()` which is fire-and-forget and microtask-scheduled. Consumers must not rely on synchronous observation. The compiler awaits nothing on the bus.

### 4.5 Emission skipping

When `forwardInnerEvents !== true` **or** no `eventBus` is provided, the compiler emits nothing — not even to a no-op bus. Guard every emission site with a single captured `emit: (e: DzupEvent) => void = noop` closure set at factory time; no per-event conditional. This keeps the hot path branchless when events are off.

---

## 5. Handle Type Definitions

### 5.1 Placement

New file: `packages/core/src/flow/handle-types.ts`. Re-exported from the package barrel (`packages/core/src/index.ts`). `flow-compiler/src/lower/_shared.ts` imports from `@dzupagent/core` (already a peer/workspace dep).

Handles are **opaque-ish** structural types — enough fields for the runtime to invoke the entity, nothing more. Registries populate them; lowerers consume them; the compiler itself never dereferences `invoke`.

### 5.2 Type definitions

```typescript
// packages/core/src/flow/handle-types.ts

import type { JSONSchema7 } from 'json-schema'

/**
 * Structural contract for a resolved skill. Populated by SkillRegistry
 * inside its ToolResolver/AsyncToolResolver adapter.
 */
export interface SkillHandle {
  readonly kind: 'skill'
  /** Stable skill identifier (namespace/name). */
  readonly id: string
  /** Human-readable display name, used in logs + pipeline nodes. */
  readonly displayName: string
  /**
   * Direct execute function. Lowerers wrap this into a ToolNode; the
   * runtime invokes it with validated input.
   */
  readonly execute: (input: unknown, ctx: SkillExecutionContext) => Promise<unknown>
  readonly inputSchema: JSONSchema7
  readonly outputSchema?: JSONSchema7
}

/**
 * Structural contract for a resolved MCP tool. Populated by the MCP
 * client tool-bridge adapter.
 */
export interface McpToolHandle {
  readonly kind: 'mcp-tool'
  /** Fully-qualified ref: `<serverId>/<toolName>`. */
  readonly id: string
  readonly serverId: string
  readonly toolName: string
  /**
   * Invoke the tool on the MCP server. Returns raw MCP content parts;
   * downstream nodes normalise.
   */
  readonly invoke: (input: unknown) => Promise<McpInvocationResult>
  readonly inputSchema: JSONSchema7
}

export interface McpInvocationResult {
  readonly content: ReadonlyArray<{ type: 'text' | 'json' | 'image'; value: unknown }>
  readonly isError: boolean
}

/**
 * Structural contract for a resolved workflow. Populated by
 * WorkflowRegistry. The compiler treats a workflow as an opaque
 * sub-pipeline invocable by reference.
 */
export interface WorkflowHandle {
  readonly kind: 'workflow'
  /** Workflow definition id (immutable across versions). */
  readonly id: string
  /** Active version number; lowerers pin to this. */
  readonly version: number
  /** Reference into PipelineDefinition storage — not the definition itself. */
  readonly definitionRef: string
  readonly inputSchema: JSONSchema7
  readonly outputSchema?: JSONSchema7
}

/**
 * Structural contract for a resolved agent. Populated by AgentRegistry.
 */
export interface AgentHandle {
  readonly kind: 'agent'
  readonly id: string
  readonly displayName: string
  /**
   * Invoke the agent as a tool-like callable. Matches the DzupAgent
   * `generate(input)` signature; lowerers wire this into an AgentNode.
   */
  readonly invoke: (input: AgentInvocation) => Promise<AgentInvocationResult>
}

export interface AgentInvocation {
  readonly prompt: string
  readonly context?: Record<string, unknown>
  readonly parentRunId?: string
}

export interface AgentInvocationResult {
  readonly output: unknown
  readonly runId: string
  readonly durationMs: number
}

/** Narrow discriminated union over all handle kinds. */
export type FlowHandle = SkillHandle | McpToolHandle | WorkflowHandle | AgentHandle

/** Minimal execution context threaded to SkillHandle.execute. */
export interface SkillExecutionContext {
  readonly runId: string
  readonly parentNodeId?: string
  readonly abortSignal?: AbortSignal
}
```

### 5.3 Integration with `ResolvedTool`

`flow-ast/src/types.ts:77` currently types `handle: unknown`. Wave 11 **keeps it `unknown`** at the flow-ast layer — flow-ast still must not depend on `@dzupagent/core`. Instead, the compiler-side narrowing helpers in `_shared.ts` return the typed handle:

```typescript
// packages/flow-compiler/src/lower/_shared.ts (after Wave 11)

import type {
  SkillHandle,
  McpToolHandle,
  WorkflowHandle,
  AgentHandle,
} from '@dzupagent/core'

export type { SkillHandle, McpToolHandle, WorkflowHandle, AgentHandle }

export function asSkillHandle(rt: ResolvedTool): SkillHandle {
  if (rt.kind !== 'skill') {
    throw new Error(
      `asSkillHandle: expected kind 'skill', got '${rt.kind}' for ref '${rt.ref}'`,
    )
  }
  // Runtime invariant: registries populating ResolvedTool with kind='skill'
  // MUST supply a SkillHandle-shaped handle. Violation is a registry bug,
  // not a compiler error — hence the cast rather than a structural check.
  return rt.handle as SkillHandle
}
// … same pattern for asMcpToolHandle / asWorkflowHandle / asAgentHandle
```

The cast survives because:
- Registries own handle population and are in-repo; a structural-check cost per lowered node is unjustified.
- The `kind` discriminator guard already ensures no cross-kind leakage.
- `ResolvedTool.handle: unknown` stays honest at the flow-ast boundary (no core dep leak).

---

## 6. Migration Plan

Work proceeds in three ordered steps. Step B depends on Step A being merged; Step C depends on Step A only and can run in parallel with B.

### 6.1 Step A — `@dzupagent/core` additions (dzupagent-core-dev)

Independent of compiler changes. Deliverables:

1. Create `packages/core/src/flow/handle-types.ts` with the five interfaces from §5.2 plus supporting types (`McpInvocationResult`, `AgentInvocation`, `AgentInvocationResult`, `SkillExecutionContext`, `FlowHandle` union).
2. Re-export from `packages/core/src/flow/index.ts` and from the package barrel.
3. Append the seven `flow:compile_*` events to the `DzupEvent` union in `packages/core/src/events/event-types.ts` (§4.2), placed in a `// --- Flow Compiler ---` section between existing sections.
4. Add unit tests for handle type narrowing (`SkillHandle` vs `McpToolHandle` discrimination via `kind`).
5. Add event-bus integration test that a `flow:compile_started` emission reaches a typed `bus.on('flow:compile_started', …)` handler.

Quality gate: `yarn typecheck --filter=@dzupagent/core && yarn test --filter=@dzupagent/core`.

### 6.2 Step B — compiler rewire (dzupagent-agent-dev)

Depends on Step A merged. Deliverables:

1. Extend `CompilerOptions` in `packages/flow-compiler/src/types.ts`:
   ```typescript
   import type { DzupEventBus } from '@dzupagent/core'

   export interface CompilerOptions {
     toolResolver: ToolResolver | AsyncToolResolver
     personaResolver?: PersonaResolver | AsyncPersonaResolver
     /**
      * When `true`, lifecycle events (`flow:compile_*`) are forwarded to
      * `eventBus`. Requires `eventBus` to be set; factory throws otherwise.
      * Rationale: cleaner separation of concerns than a self-owned bus,
      * less code than internal subscribe(), avoids fan-out coordination
      * when multiple subsystems want to listen. — Wave 11 ADR
      */
     forwardInnerEvents?: boolean
     /**
      * Shared bus for lifecycle event forwarding. Only consulted when
      * `forwardInnerEvents === true`. See ADR Wave 11 §4.
      */
     eventBus?: DzupEventBus
   }
   ```
2. Append `AsyncPersonaResolver` interface to `packages/flow-compiler/src/types.ts`.
3. Append `AsyncToolResolver` to `packages/flow-ast/src/types.ts` (§3.2). Add `RESOLVER_INFRA_ERROR` to `ValidationErrorCode`.
4. Rewrite `packages/flow-compiler/src/stages/semantic.ts` to:
   - Accept `ToolResolver | AsyncToolResolver`.
   - Return `Promise<SemanticResult>`.
   - Use the duck-typed dispatch from §3.6.
   - Emit `RESOLVER_INFRA_ERROR` on infra rejection.
5. Rewrite `packages/flow-compiler/src/index.ts`:
   - Factory validates the `forwardInnerEvents` + `eventBus` pair at construction, throws with a clear message on mismatch.
   - `compile()` becomes `async` returning `Promise<CompileSuccess | CompileFailure>`.
   - Mint `compileId = crypto.randomUUID()` at the top of every `compile()` call; include it on both success and failure return values.
   - Capture `emit` as a closure: `const emit = (opts.forwardInnerEvents && opts.eventBus) ? opts.eventBus.emit.bind(opts.eventBus) : noop`.
   - Emit the seven events at the boundaries specified in §4.4.
6. Update all tests in `packages/flow-compiler/tests/**` to `await compile(...)`.
7. Add new tests (see §7).

Quality gate: `yarn verify` (cross-package change).

### 6.3 Step C — `_shared.ts` tightening (dzupagent-agent-dev or codegen-dev)

Depends on Step A only. Deliverables:

1. Replace the four `type … = unknown` declarations in `packages/flow-compiler/src/lower/_shared.ts:66-73` with imports from `@dzupagent/core`.
2. Re-export the four handle types from `_shared.ts` so existing lowerer imports keep working.
3. No runtime change to `asSkillHandle` / `asMcpToolHandle` / `asWorkflowHandle` / `asAgentHandle` — only the return types tighten.
4. Update lowerer call sites (`lower-skill-chain.ts`, `lower-pipeline-flat.ts`, `lower-pipeline-loop.ts`) to remove any `as any` casts the `unknown` return type forced.

Quality gate: `yarn typecheck --filter=@dzupagent/flow-compiler`.

### 6.4 Order enforcement

```
  [A] core: handles + events
       │
       ├──────────────┐
       ▼              ▼
  [B] compiler    [C] _shared
      async + events  tightening
```
B and C can land independently but neither can merge before A.

---

## 7. Test Coverage Targets

Minimum additional tests before Wave 11 can close. Each bullet is one test case unless noted.

### 7.1 AsyncToolResolver path (`flow-compiler/tests/semantic-async.test.ts`)

- Sync resolver with Promise-returning `resolve()` is detected via duck-type and awaited (fixture: resolver returning `Promise.resolve(resolvedTool)`).
- Sync resolver with direct return does **not** hit the microtask queue (assert via instrumented `Promise.prototype.then` spy or a counter in `semanticResolve`).
- Async resolver rejection surfaces as `RESOLVER_INFRA_ERROR` with correct `nodePath` and message.
- Mixed resolvers — async tool resolver + sync persona resolver — compile correctly.
- Async persona resolver that returns `false` produces `UNRESOLVED_PERSONA_REF` (no change from sync behaviour).
- Unknown ref from async resolver still produces `UNRESOLVED_TOOL_REF` with suggestions drawn from `listAvailable()`.

### 7.2 Event emission (`flow-compiler/tests/event-bus.test.ts`)

- All seven `flow:compile_*` events fire in the §4.4 order for a clean compile. Assert via `bus.onAny` capturing an ordered array.
- Stage 1 failure emits `compile_started` → `compile_parsed` (errorCount > 0) → `compile_failed`. Shape/semantic/lowered **do not** fire.
- Stage 3 failure emits through `compile_semantic_resolved` (errorCount > 0) → `compile_failed`. `compile_lowered` does not fire.
- Every event in a single compile shares the same `compileId`.
- Two concurrent `compile()` calls produce two distinct `compileId` streams, interleaved but internally ordered.
- `forwardInnerEvents: false` + `eventBus` provided ⇒ zero events emitted (assert via wildcard subscriber counter).
- `forwardInnerEvents: undefined` + no eventBus ⇒ zero events emitted, no throw.

### 7.3 Missing-bus rejection (`flow-compiler/tests/factory-validation.test.ts`)

- `{ forwardInnerEvents: true, eventBus: undefined }` throws at factory time with a message containing `eventBus` and `forwardInnerEvents`.
- `{ forwardInnerEvents: true, eventBus: createEventBus() }` does not throw.
- `{ forwardInnerEvents: false, eventBus: undefined }` does not throw.
- `{ forwardInnerEvents: false, eventBus: createEventBus() }` does not throw (bus is simply unused).

### 7.4 Handle narrowing (`core/tests/flow/handle-types.test.ts`)

- `asSkillHandle` on a `ResolvedTool{ kind: 'skill' }` returns `SkillHandle` with `handle.execute` callable.
- `asSkillHandle` on a `ResolvedTool{ kind: 'mcp-tool' }` throws with a message naming both kinds + the ref.
- Same for the other three narrowing helpers.
- Type-level test (via `expectTypeOf` or `tsd`): `SkillHandle.kind` is the literal `'skill'`; `FlowHandle` narrows on `kind` discriminator.

### 7.5 Backward-compat sweep

- Run the existing flow-compiler suite under the new async signature (tests updated to `await`). Zero semantic regressions.
- `yarn verify` passes with no type errors across the workspace.

Target: at least 15 new test cases total. Existing tests are modified in place, not duplicated.

---

## 8. Out of Scope

Wave 11 is deliberately narrow. The following are **not** in scope and must not creep in:

- **No changes to Stage 1 (`parseFlow`) logic.** Parser behaviour is frozen.
- **No changes to Stage 2 (`validateShape`) logic.** Shape rules are frozen.
- **No changes to Stage 4 lowerer outputs.** `lowerSkillChain`, `lowerPipelineFlat`, `lowerPipelineLoop` produce byte-identical artifacts before and after Wave 11. Handle-type tightening is purely a type-system change; runtime code paths are unchanged.
- **No event-bus wiring outside flow-compiler.** No other package subscribes to `flow:compile_*` events as part of Wave 11. Consumers (playground, orchestration UI, otel) may subscribe in later waves.
- **No registry adapter work.** `SkillRegistry`, `WorkflowRegistry`, `MCPClient`, `AgentRegistry` keep their existing `ToolResolver` adapters. Introducing `AsyncToolResolver` adapters for any of them is Wave 12+ scope.
- **No pre-warm removal.** Existing callers that pre-warm registries before `compile()` continue to work unchanged via the synchronous `ToolResolver` path.
- **No streaming / back-pressure.** Event emission is fire-and-forget through the existing `DzupEventBus`. No SSE bridging, no event buffer, no replay.
- **No new `CompilationError` fields.** `stage` / `message` / `nodePath` are unchanged. `compileId` is added to the **result** object (`CompileSuccess` / `CompileFailure`), not to individual errors.
- **No breaking change to flow-ast exports** beyond the new `AsyncToolResolver` interface and the new `RESOLVER_INFRA_ERROR` error code.

---

## 9. Consequences

### Positive
- Stage 3 resolves async registries first-class; no more pre-warm contortions.
- Compile lifecycle observable via typed events; playground + otel wiring trivialised.
- Lowerer call sites gain real types; removes `as any` casts and catches kind mismatches at compile time.
- Single async API surface ⇒ less surface area, less test matrix, less docs drift.

### Negative
- Breaking change. Every `compile()` call site must add `await`. Mitigated by the zero-production-consumer fact (only in-package tests today).
- One unconditional microtask per compile even when all resolvers are sync. Measured overhead is sub-millisecond; acceptable.
- `@dzupagent/core` now owns flow handle types ⇒ the core package surface grows. Acceptable: handles are small, well-scoped, and co-located with existing pipeline types.

### Risks
- **Registry adapter authors may mistakenly mark their resolver `AsyncToolResolver` when they are actually synchronous**, paying the await cost unnecessarily. Mitigation: doc note in `AsyncToolResolver` JSDoc steering toward `ToolResolver` for sync cases.
- **Event stream backpressure** if a slow handler blocks the bus. Mitigation: `DzupEventBus.emit` is microtask-scheduled, not synchronous; slow handlers delay only themselves. Existing bus contract.
- **`RESOLVER_INFRA_ERROR` masks genuine infrastructure outages as "just another compile error".** Mitigation: code is distinct from `UNRESOLVED_TOOL_REF`; callers can grep for it and surface operator alerts separately.

---

## 10. Alternatives Considered

- **Sync overload + separate `compileAsync()`.** Rejected: two code paths to maintain, two test matrices, two sets of docs. The microtask overhead on sync resolvers is negligible.
- **`kind: 'sync' | 'async'` brand on resolver.** Rejected: leaks implementation detail, easy to forget, requires runtime check anyway.
- **Compiler owns its own `DzupEventBus` instance and exposes `subscribe()`.** Rejected: duplicates the DzupEventBus surface, requires consumers to re-plumb subscriptions, makes fan-out to multiple listeners harder.
- **Handle types in `@dzupagent/flow-ast`.** Rejected: flow-ast stays pure; handles carry runtime-specific invocation signatures that belong with the core runtime contracts.
- **Emit full error arrays in events.** Rejected: duplicates the returned result payload into every wildcard subscriber and blows up event size for large compile failures.

---

## 11. References

- Wave 10 E2 context: `docs/tooling/DECISIONS_WAVE_10.md` (D1 — ToolResolver as injected interface).
- Existing bus contract: `packages/core/src/events/event-bus.ts`.
- Event union: `packages/core/src/events/event-types.ts`.
- Current sync resolution site: `packages/flow-compiler/src/stages/semantic.ts:60`.
- Handle `unknown` aliases: `packages/flow-compiler/src/lower/_shared.ts:66-73`.
- ToolResolver contract: `packages/flow-ast/src/types.ts:49-63`.
- Factory entry point: `packages/flow-compiler/src/index.ts:61-165`.
