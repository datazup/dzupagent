# Presets Architecture

## Scope
This document describes the current `packages/agent/src/presets` implementation in `@dzupagent/agent`, based on local source code in `packages/agent`:

- `src/presets/types.ts`
- `src/presets/built-in.ts`
- `src/presets/factory.ts`
- `src/presets/index.ts`
- `src/presets/dev.ts`
- `src/__tests__/presets.factory.test.ts`
- `src/__tests__/presets.built-in.test.ts`
- package integration surfaces: `src/index.ts`, `src/compat.ts`, `package.json`, `README.md`

Out of scope: unrelated runtime internals except where preset outputs map into `DzupAgentConfig` fields.

## Responsibilities
The presets area currently serves two related but separate concerns:

- Declarative agent behavior presets (`AgentPreset`) for instructions/tool allowlists/guardrails/memory profile/self-correction hints.
- Factory and registry utilities to turn a preset into a runtime config object and manage in-memory preset registration.
- Built-in preset catalog (`rag-chat`, `research`, `summarizer`, `qa`).
- Development-only governance helper (`dev.ts`) that wraps production tool-governance preset creation but forces `scanFailureMode: 'fail-open'`.

The first three concerns are exported publicly through package barrels. The dev governance helper exists in source but is not wired into public exports.

## Structure
`src/presets/types.ts`
- Defines `AgentPreset`.
- Defines `PresetRuntimeDeps` (runtime dependencies plus override envelope).

`src/presets/built-in.ts`
- Declares four built-in presets:
- `RAGChatPreset`
- `ResearchPreset`
- `SummarizerPreset`
- `QAPreset`
- Exposes `BUILT_IN_PRESETS` as readonly list.

`src/presets/factory.ts`
- Defines `PresetConfig` (factory return type).
- Implements `buildConfigFromPreset(preset, deps)`.
- Implements `PresetRegistry` (`register`, `get`, `list`, `listNames`).
- Implements `createDefaultPresetRegistry()` (pre-registers `BUILT_IN_PRESETS`).

`src/presets/index.ts`
- Re-exports `types.ts`, `factory.ts`, and built-ins from `built-in.ts`.

`src/presets/dev.ts`
- Defines `DevToolGovernancePresetOptions` and `DevToolGovernancePreset`.
- Implements `createDevToolGovernancePreset(options)`.
- Implements `withDevToolGovernancePreset(config, options)`.
- Reuses `createProductionToolGovernancePreset(...)` and only overrides `toolExecution.scanFailureMode` to `'fail-open'`.

## Runtime and Control Flow
`buildConfigFromPreset` flow:

1. Read preset and runtime deps.
2. Resolve instruction and memory overrides:
- `instructions = deps.overrides?.instructions ?? preset.instructions`
- `memoryProfile = deps.overrides?.memoryProfile ?? preset.memoryProfile`
3. Merge guardrails shallowly:
- `guardrails = { ...preset.guardrails, ...deps.overrides?.guardrails }`
4. Filter tools only when `deps.tools` exists and `preset.toolNames.length > 0`:
- Named tools are kept only when `tool.name` is in `preset.toolNames`.
- Nameless tools are kept.
5. Resolve `selfLearning`:
- If `overrides.selfLearning` exists, it wins.
- Else if `preset.selfCorrection?.enabled`, map to `{ enabled: true, maxIterations: preset.selfCorrection.maxReflectionIterations }`.
- Else leave `selfLearning` undefined.
6. Return `PresetConfig` with generated id `preset-${preset.name}-${Date.now()}` and passthrough runtime deps (`model`, `tools`, `memory`, `eventBus`), plus `defaultModelTier`.

`PresetRegistry` flow:

1. `register(preset)` stores by `preset.name` in `Map`.
2. Re-registering same name overwrites previous value.
3. `createDefaultPresetRegistry()` instantiates registry and registers all built-ins.

`dev.ts` flow (source-local helper):

1. Build production preset via `createProductionToolGovernancePreset(options)`.
2. Clone returned `toolExecution` and force `scanFailureMode: 'fail-open'`.
3. Return production-derived `eventBus`, `safetyMonitor`, `governance`, and overridden `toolExecution`.
4. `withDevToolGovernancePreset` applies that bundle onto an existing `DzupAgentConfig`, defaulting `agentId`, `tools`, and `eventBus` from config when omitted.

## Key APIs and Types
Publicly exported from package root/compat via `src/presets/index.ts`:

- `AgentPreset`
- `PresetRuntimeDeps`
- `PresetConfig`
- `buildConfigFromPreset(...)`
- `PresetRegistry`
- `createDefaultPresetRegistry()`
- `RAGChatPreset`
- `ResearchPreset`
- `SummarizerPreset`
- `QAPreset`
- `BUILT_IN_PRESETS`

`AgentPreset` fields:
- Required: `name`, `description`, `instructions`, `toolNames`, `guardrails.maxIterations`
- Optional guardrail fields: `maxCostCents`, `maxTokens`
- Optional behavior fields: `memoryProfile`, `selfCorrection`, `defaultModelTier`

`PresetRuntimeDeps` fields:
- Required: `model`
- Optional: `tools`, `memory`, `eventBus`
- Optional overrides: `instructions`, `guardrails`, `memoryProfile`, `selfLearning`

Source-defined but not exported from package public barrels:
- `DevToolGovernancePresetOptions`
- `DevToolGovernancePreset`
- `createDevToolGovernancePreset(...)`
- `withDevToolGovernancePreset(...)`

## Dependencies
In-module dependencies:

- `types.ts` and `built-in.ts`: no external runtime imports.
- `factory.ts`: imports `AgentPreset`/`PresetRuntimeDeps` and `BUILT_IN_PRESETS` from sibling preset modules.
- `dev.ts` runtime dependencies:
- `../agent/production-tool-governance-preset.js`
- `../utils/exact-optional.js`
- `dev.ts` type-only dependencies:
- `@langchain/core/tools`
- `@dzupagent/core/events`
- `@dzupagent/core/security`
- `@dzupagent/core/tools`
- `../agent/agent-types.js`

Package manifest context (`packages/agent/package.json`):
- Runtime deps include `@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/agent-types`, `@dzupagent/adapter-types`, `@dzupagent/runtime-contracts`, `@dzupagent/security`.
- Peer deps: `@langchain/core`, `@langchain/langgraph`, `zod`.

## Integration Points
- `src/index.ts` re-exports presets from `./presets/index.js` under the `// --- Presets ---` block.
- `src/compat.ts` re-exports `./presets/index.js` as part of transitional compatibility surface.
- `package.json` does not define a dedicated `./presets` subpath; consumption is via root (`@dzupagent/agent`) or `@dzupagent/agent/compat`.
- `buildConfigFromPreset` output aligns with key `DzupAgentConfig` fields (`id`, `instructions`, `model`, `tools`, `memory`, `eventBus`, `guardrails`, `memoryProfile`, `selfLearning`), but the preset factory keeps broad `unknown` typing and does not itself enforce strict `DzupAgentConfig` types.
- `defaultModelTier` is included in `PresetConfig` but is not a declared `DzupAgentConfig` field.
- No non-test runtime module in `src/` currently calls `buildConfigFromPreset` directly.
- `src/presets/dev.ts` is currently not imported by `src/presets/index.ts`, `src/index.ts`, or `src/compat.ts`, and no `package.json` export points to it.

## Testing and Observability
Tests present:

- `src/__tests__/presets.factory.test.ts`
- Covers id generation format, override precedence, guardrail merge behavior, tool filtering rules, self-correction to self-learning mapping, `defaultModelTier` passthrough, registry behavior, and default registry preload.
- `src/__tests__/presets.built-in.test.ts`
- Covers built-in preset contract invariants and collection integrity (count, uniqueness, expected names).

Observability:

- `types.ts`, `built-in.ts`, and `factory.ts` emit no telemetry/events.
- Observable behavior is downstream via whichever runtime path consumes produced config.
- `dev.ts` composes governance/event-bus/safety monitor primitives but has no module-local tests in `src/__tests__` and no public export wiring.

## Risks and TODOs
- `src/presets/dev.ts` is source-present but not publicly exported, not referenced by package README, and not covered by dedicated tests; this creates discoverability and drift risk.
- `PresetConfig` uses `unknown` for `model`, `tools`, `memory`, and `eventBus`, so compatibility with strict `DzupAgentConfig` expectations is caller-enforced.
- Tool filtering allows nameless tool objects through even when `toolNames` allowlisting is enabled.
- Factory-generated ids use `Date.now()`; same-millisecond collisions are possible for same preset name.
- `defaultModelTier` is preserved in preset output but currently has no direct typed slot in `DzupAgentConfig`.
- Built-in preset list is static and manually curated; changes require explicit updates to both source and tests.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: refreshed against current `src/presets` implementation, including `dev.ts` status and export-path reality

