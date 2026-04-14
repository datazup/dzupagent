# `packages/agent-types` Analysis (Codex)

Date: 2026-04-03  
Requested target: `packages/agent-types`  
Observed implementation: there is currently no `packages/agent-types` package in the repo; the active "agent types" implementation is in `packages/agent/src/agent/agent-types.ts` and its runtime call sites.

## Scope

This analysis covers:

- Type contracts in `packages/agent/src/agent/agent-types.ts`
- Runtime behavior in:
  - `packages/agent/src/agent/dzip-agent.ts`
  - `packages/agent/src/agent/run-engine.ts`
  - `packages/agent/src/agent/tool-loop.ts`
  - `packages/agent/src/agent/memory-context-loader.ts`
  - `packages/agent/src/agent/instruction-resolution.ts`
- Public export surface in `packages/agent/src/index.ts`
- Focused tests:
  - `instruction-resolution.test.ts`
  - `memory-context-loader.test.ts`
  - `dzip-agent-run-parity.test.ts`
  - `token-usage.test.ts`
  - `tool-stats-wiring.test.ts`

Validation run:

- `yarn workspace @dzupagent/agent test src/__tests__/instruction-resolution.test.ts src/__tests__/memory-context-loader.test.ts src/__tests__/dzip-agent-run-parity.test.ts src/__tests__/token-usage.test.ts src/__tests__/tool-stats-wiring.test.ts`
- Result: 24/24 tests passed.

## Executive Summary

The current agent type layer is functional and well-covered for core flows (generate/stream parity, memory loading, instruction resolution, tool-stats prompting). However, there are important contract-to-runtime gaps:

- Some publicly declared API fields are not wired in runtime (`GenerateOptions.context`, `GenerateResult.learnings`).
- Advanced loop capabilities exist at lower layers (`runToolLoop`) but are not exposed through `DzupAgentConfig`.
- The stream event contract is too loosely typed for a public SDK surface.
- "Agent types" are embedded inside `@dzupagent/agent`, not isolated as a reusable standalone package.

Overall maturity: strong runtime foundation, medium API contract consistency risk.

## Current Implementation Map

### 1. Config and result contracts

`DzupAgentConfig` includes:

- Identity and prompting (`id`, `name`, `instructions`, `description`) (`agent-types.ts:22-53`)
- Model resolution strategy (`model`, optional `registry`) (`agent-types.ts:29-33`)
- Tooling and middleware (`tools`, `middleware`) (`agent-types.ts:34-36`)
- Memory and context controls (`memory`, `memoryScope`, `memoryNamespace`, `arrowMemory`, `memoryProfile`) (`agent-types.ts:37-85`)
- Safety and telemetry (`guardrails`, `maxIterations`, `eventBus`, `toolStatsTracker`) (`agent-types.ts:46-60`)
- Instruction composition (`instructionsMode`, `agentsDir`) (`agent-types.ts:87-99`)
- Self-learning toggle (`selfLearning`) (`agent-types.ts:101-110`)

`GenerateOptions` defines per-call controls (`maxIterations`, `signal`, `context`, `onUsage`, `intent`) (`agent-types.ts:126-137`).

`GenerateResult` includes content, messages, usage, stop metadata, tool stats, optional `stuckError`, optional `learnings` (`agent-types.ts:140-167`).

### 2. Runtime wiring

- `DzupAgent.generate()` delegates to shared run preparation + execution (`dzip-agent.ts:109-135`).
- `DzupAgent.stream()` either falls back to shared generate path or runs streaming loop with tool execution parity (`dzip-agent.ts:181-403`).
- `prepareRunState()` resolves max iterations, budget, tools, stuck detector, and attempts self-learning bootstrap (`run-engine.ts:71-111`).
- `executeGenerateRun()` runs `runToolLoop()`, applies output filter, emits stop telemetry (`run-engine.ts:113-191`).
- Tool loop supports rich capabilities: budgeting, stuck recovery, optional parallel execution, tool-arg validation, and tool-stats hint injection (`tool-loop.ts:49-105`, `tool-loop.ts:133-379`).

### 3. Proven by tests

Verified coverage includes:

- Instruction mode behavior + cache semantics (`instruction-resolution.test.ts`)
- Arrow memory path + fallback behavior (`memory-context-loader.test.ts`)
- Generate/stream behavioral parity (`dzip-agent-run-parity.test.ts`)
- Token usage extraction and fallback estimation (`token-usage.test.ts`)
- Tool-stats hint injection lifecycle (`tool-stats-wiring.test.ts`)

## Severity-Ranked Findings

## High

1. `selfLearning` contract is not propagated to `GenerateResult.learnings`.

- Impact:
  - Public contract advertises run-level learnings (`GenerateResult.learnings`), but generate path does not populate it.
  - Consumers may build logic on learnings that never arrive.
- Evidence:
  - Declared: `learnings?: RunLearnings` (`agent-types.ts:163-167`).
  - `executeGenerateRun()` return object has no `learnings` field (`run-engine.ts:178-190`).
  - `prepareRunState()` creates `learningHook` then only calls `loadSpecialistConfig()`; hook is not carried forward (`run-engine.ts:97-100`).
  - `tool-loop-learning` lifecycle methods (`recordToolExecution`, `onLoopComplete`) are never wired into tool-loop callbacks.
- Recommendation:
  - Thread a `learningHook` through `PreparedRunState` and into `runToolLoop` callbacks.
  - Populate `GenerateResult.learnings` from `learningHook.onLoopComplete(...)`.
  - Add explicit tests for `selfLearning.enabled = true` asserting non-empty `learnings` and callback invocation.

## Medium

2. `GenerateOptions.context` is declared but unused in runtime.

- Impact:
  - API consumers can pass `context`, but it has no effect.
  - Silent no-op behavior causes integration confusion and hidden prompt-quality regressions.
- Evidence:
  - Declared in options (`agent-types.ts:131-133`).
  - No runtime read of `options.context` in `dzip-agent.ts`, `run-engine.ts`, or `tool-loop.ts`.
- Recommendation:
  - Either implement (inject context into prepared system/user message path), or remove/deprecate the field.
  - Add regression test for context injection ordering.

3. Advanced loop controls are not reachable from top-level `DzupAgentConfig`.

- Impact:
  - `runToolLoop` supports `parallelTools`, `maxParallelTools`, and `validateToolArgs` (`tool-loop.ts:74-88`), but `DzupAgentConfig` cannot configure these.
  - Teams using only `DzupAgent` cannot access key safety/performance features without bypassing the abstraction.
- Evidence:
  - Fields exist in `ToolLoopConfig` (`tool-loop.ts:74-88`).
  - `executeGenerateRun` passes only a subset to `runToolLoop` (`run-engine.ts:121-159`).
  - `DzupAgentConfig` has no corresponding fields (`agent-types.ts:22-111`).
- Recommendation:
  - Add `toolLoop?: { parallelTools?: boolean; maxParallelTools?: number; validateToolArgs?: ... }` to `DzupAgentConfig`.
  - Preserve backward compatibility by defaulting to current behavior.

4. Stream event type is too weak for a public contract.

- Impact:
  - `AgentStreamEvent` uses `data: Record<string, unknown>` (`agent-types.ts:170-173`), forcing consumers into manual narrowing and runtime assumptions.
  - Event payload drift is likely as event variants evolve.
- Evidence:
  - Event emission sites produce different payload shapes (`dzip-agent.ts:213-222`, `dzip-agent.ts:324-358`, `dzip-agent.ts:401-403`).
- Recommendation:
  - Replace with discriminated union payloads per event type:
    - `text`, `tool_call`, `tool_result`, `budget_warning`, `stuck`, `done`, `error`.
  - Export event payload types for adapter/server integration.

## Low

5. Agent type contracts are tightly coupled to runtime modules.

- Impact:
  - `agent-types.ts` imports runtime-linked types from `tool-loop`, `stuck-error`, and `tool-loop-learning` (`agent-types.ts:15-20`), limiting portability.
  - Harder to ship a lightweight types-only package for external consumers.
- Recommendation:
  - Move stable contracts into a dedicated package (`@dzupagent/agent-types`) with zero runtime dependencies.
  - Keep runtime-specific types in `@dzupagent/agent` and map them at boundaries.

6. Non-fatal catch blocks reduce diagnosis quality.

- Impact:
  - Several core paths swallow errors without emitting typed diagnostics (memory load, summarization, middleware, instruction merge).
- Evidence:
  - `dzip-agent.ts:487-491`, `dzip-agent.ts:523-538`
  - `middleware-runtime.ts:32-36`, `middleware-runtime.ts:67-71`
  - `instruction-resolution.ts:62-64`
- Recommendation:
  - Keep non-fatal behavior, but emit structured debug events (`agent:nonfatal_error`) to `eventBus`.

## Gap Analysis

### A. Contract Completeness Gap

Current:

- Public type surface promises richer semantics than currently delivered (`context`, `learnings`).

Gap:

- SDK consumers cannot reliably infer behavior from types alone.

Target state:

- Every exported field is either fully implemented or explicitly marked deprecated/experimental.

### B. Abstraction Gap (Top-level Agent vs Lower-level Loop)

Current:

- `runToolLoop` has advanced knobs; `DzupAgentConfig` does not expose them.

Gap:

- Teams choosing high-level API lose tuning controls, creating abstraction leakage.

Target state:

- Full-fidelity `DzupAgentConfig.toolLoop` passthrough for advanced execution control.

### C. Type Safety Gap in Streaming APIs

Current:

- Event payload is generic record.

Gap:

- Compile-time guarantees are weak; downstream adapters/servers must rely on runtime shape knowledge.

Target state:

- Discriminated union stream events with strict payload contracts.

### D. Packaging/Reuse Gap

Current:

- No dedicated `packages/agent-types`; agent contracts live in `@dzupagent/agent` internals.

Gap:

- Third-party consumers that only need type contracts still depend on larger runtime package.

Target state:

- Standalone `@dzupagent/agent-types` package, similar in intent to existing `@dzupagent/adapter-types`.

### E. Observability Gap for Best-Effort Paths

Current:

- Fail-open design is used correctly for resilience, but mostly silent.

Gap:

- Operator visibility into degraded modes is limited.

Target state:

- Non-fatal failure telemetry channel + optional debug hooks for incident triage.

## Suggested New Features

1. Introduce dedicated `@dzupagent/agent-types` package.

- Include:
  - `DzupAgentConfig`, `GenerateOptions`, `GenerateResult`, stream event unions, shared stop reasons.
- Keep runtime implementation in `@dzupagent/agent`.
- Benefits:
  - Smaller dependency footprint for integrators.
  - Cleaner versioning of external contracts.

2. Add `toolLoop` execution profile in `DzupAgentConfig`.

- Proposed shape:
  - `toolLoop.parallelTools`
  - `toolLoop.maxParallelTools`
  - `toolLoop.validateToolArgs`
  - `toolLoop.validationFailureMode` (`message` | `throw`)
- Benefits:
  - Exposes existing runtime capabilities safely.

3. Implement typed stream event unions with versioning.

- Proposed addition:
  - `AgentStreamEventV1` discriminated union.
  - Optional `eventVersion: 1` on each event.
- Benefits:
  - Compile-time safety for downstream consumers.
  - Cleaner migration path for future payload changes.

4. Complete self-learning result integration.

- Wire `ToolLoopLearningHook` into the tool loop lifecycle.
- Populate `GenerateResult.learnings` and stream final diagnostics event.
- Benefits:
  - Makes existing `selfLearning` API truly actionable.

5. Add explicit `contextInjection` strategy.

- Options:
  - `append_system` (default)
  - `append_user`
  - `disabled`
- Tie to `GenerateOptions.context` and test deterministic placement.

6. Add structured non-fatal diagnostics channel.

- Emit to `eventBus`:
  - source module, error class/message, fallback action, timestamp.
- Benefits:
  - Maintains resilience while improving operability.

## Prioritized Roadmap

### Immediate (1-2 sprints)

1. Fix `selfLearning` wiring and `GenerateResult.learnings` population.
2. Resolve `GenerateOptions.context` mismatch (implement or deprecate).
3. Expose `toolLoop` passthrough in `DzupAgentConfig`.
4. Add tests for all three above.

### Short-term (2-4 sprints)

1. Replace `AgentStreamEvent` with discriminated union payloads.
2. Add event schema tests at compile-time and runtime.
3. Add non-fatal diagnostics emission hooks.

### Mid-term

1. Create new workspace package `packages/agent-types` (`@dzupagent/agent-types`).
2. Move stable contracts out of runtime module imports.
3. Maintain compatibility re-exports from `@dzupagent/agent` for one release cycle.

## Proposed Validation Matrix (After Improvements)

- Unit:
  - `selfLearning` generates `learnings` and callbacks fire.
  - `context` injection order is deterministic.
  - `toolLoop` config fields pass through to runtime.
  - Stream payload typing matches emitted shapes.
- Integration:
  - `generate()` and `stream()` parity remains intact with new config fields.
  - Backward compatibility of `@dzupagent/agent` exports.
- Type tests:
  - Public API compile tests for event unions and config surfaces.

## Conclusion

The current implementation is solid in core execution behavior but has contract drift in a few high-impact areas. Closing the `selfLearning` and `context` mismatches, exposing loop controls at the top-level config, and extracting a dedicated `agent-types` package would substantially improve API reliability, external integrability, and long-term maintainability.
