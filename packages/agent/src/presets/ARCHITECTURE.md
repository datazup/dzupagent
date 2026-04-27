# Presets Architecture

## Scope
This document describes `packages/agent/src/presets` in `@dzupagent/agent`.

Files in scope:
- `types.ts`
- `built-in.ts`
- `factory.ts`
- `index.ts`

Repository context used for this refresh:
- `packages/agent/src/index.ts` (public export wiring)
- `packages/agent/src/__tests__/presets.factory.test.ts`
- `packages/agent/src/__tests__/presets.built-in.test.ts`
- `packages/agent/package.json`
- `packages/agent/README.md`

Out of scope:
- Full `DzupAgent` runtime internals, except where preset output fields are consumed by existing config surfaces.

## Responsibilities
The presets module provides a small declarative layer for packaging reusable agent defaults and converting them into runtime config objects.

Current responsibilities in code:
- Define a preset contract (`AgentPreset`) and runtime dependency envelope (`PresetRuntimeDeps`).
- Ship built-in presets (`RAGChatPreset`, `ResearchPreset`, `SummarizerPreset`, `QAPreset`) plus `BUILT_IN_PRESETS`.
- Materialize a runtime config object from a preset (`buildConfigFromPreset`).
- Provide an in-memory registry (`PresetRegistry`) and a preloaded registry factory (`createDefaultPresetRegistry`).

Behavior implemented today:
- `instructions`, `guardrails`, and `memoryProfile` support override precedence via `deps.overrides`.
- Tools are allowlisted by `preset.toolNames` when both `deps.tools` and non-empty `toolNames` are present.
- `selfCorrection` is translated into runtime `selfLearning` unless `overrides.selfLearning` is provided.
- `defaultModelTier` is copied through as an output hint.

## Structure
`types.ts`
- `AgentPreset`: declarative preset shape.
- `PresetRuntimeDeps`: model/tools/memory/eventBus bundle plus override surface.

`built-in.ts`
- Defines four built-in constants:
- `RAGChatPreset`
- `ResearchPreset`
- `SummarizerPreset`
- `QAPreset`
- Exposes `BUILT_IN_PRESETS` as readonly aggregation.

`factory.ts`
- Defines `PresetConfig` (factory output type).
- Implements `buildConfigFromPreset(preset, deps)`.
- Implements `PresetRegistry` (`register`, `get`, `list`, `listNames`).
- Implements `createDefaultPresetRegistry()` to preload `BUILT_IN_PRESETS`.

`index.ts`
- Re-exports types, factory APIs, and built-in presets for package-level consumption.

## Runtime and Control Flow
Typical flow:
1. Caller selects a preset (direct constant or lookup via `PresetRegistry`).
2. Caller supplies `PresetRuntimeDeps` (required: `model`).
3. `buildConfigFromPreset()` resolves fields:
- `instructions = overrides.instructions ?? preset.instructions`
- `guardrails = { ...preset.guardrails, ...overrides.guardrails }`
- `memoryProfile = overrides.memoryProfile ?? preset.memoryProfile`
4. Tool filtering runs only when `deps.tools` exists and `preset.toolNames.length > 0`.
- Named tools are retained only if `tool.name` is in `preset.toolNames`.
- Nameless tools pass through unchanged.
5. `selfLearning` resolution:
- If `overrides.selfLearning` exists, it wins.
- Else if `preset.selfCorrection?.enabled`, map to `{ enabled: true, maxIterations: maxReflectionIterations }`.
- Else `selfLearning` stays `undefined`.
6. Factory returns `PresetConfig` with generated id format `preset-${preset.name}-${Date.now()}` and passthrough references for `model`, `tools`, `memory`, and `eventBus`.

Built-in preset inventory:
- `rag-chat`: retrieval Q/A with citations, `toolNames: ['rag_query']`, balanced memory, modest guardrails.
- `research`: multi-step research profile, broad tool allowlist, largest budgets among built-ins, self-correction enabled, `defaultModelTier: 'reasoning'`.
- `summarizer`: low-cost summarization profile, minimal memory, `rag_query` + `generate_content` tools.
- `qa`: focused indexed-source QA with citations, `rag_query`, moderate budgets.

## Key APIs and Types
`AgentPreset` (`types.ts`)
- Core fields: `name`, `description`, `instructions`, `toolNames`, `guardrails.maxIterations`.
- Optional fields: `guardrails.maxCostCents`, `guardrails.maxTokens`, `memoryProfile`, `selfCorrection`, `defaultModelTier`.

`PresetRuntimeDeps` (`types.ts`)
- Required: `model`.
- Optional: `tools`, `memory`, `eventBus`.
- Optional `overrides`:
- `instructions`
- `guardrails`
- `memoryProfile`
- `selfLearning` (`enabled`, `maxIterations`)

`PresetConfig` (`factory.ts`)
- Returned object includes:
- Identity/prompt: `id`, `name`, `instructions`
- Runtime wiring: `model`, `tools`, `memory`, `eventBus`
- Execution hints/settings: `guardrails`, `memoryProfile`, `selfLearning`, `defaultModelTier`

Factory and registry APIs (`factory.ts`)
- `buildConfigFromPreset(preset, deps): PresetConfig`
- `new PresetRegistry()`
- `PresetRegistry.register(preset)`
- `PresetRegistry.get(name)`
- `PresetRegistry.list()`
- `PresetRegistry.listNames()`
- `createDefaultPresetRegistry()`

## Dependencies
Module-local dependencies (`src/presets/*`):
- Internal imports only (`./types.js`, `./built-in.js`, `./factory.js`).
- No direct imports from `@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory`, `@langchain/*`, or `zod`.

Package-level dependency context (`packages/agent/package.json`):
- Runtime deps: `@dzupagent/adapter-types`, `@dzupagent/agent-types`, `@dzupagent/context`, `@dzupagent/core`, `@dzupagent/memory`, `@dzupagent/memory-ipc`.
- Peer deps: `@langchain/core`, `@langchain/langgraph`, `zod`.
- Presets code does not directly bind to these peer/runtime packages, but is exported through the package root.

## Integration Points
Public export surface:
- `src/presets/index.ts` is re-exported from `src/index.ts` under the `// --- Presets ---` section.
- Package root export map exposes only `dist/index.js`, so presets are consumed through package root exports.

Config compatibility with `DzupAgentConfig`:
- `instructions`, `model`, `tools`, `memory`, `eventBus`, `guardrails`, `memoryProfile`, and `selfLearning` align with fields present on `DzupAgentConfig`.
- `defaultModelTier` is currently a preset output hint and is not a `DzupAgentConfig` field in `agent-types.ts`.

Runtime consumers of compatible fields:
- `guardrails` is consumed by run/tool-loop guardrail wiring.
- `memoryProfile` is consumed by memory context loading (`AgentMemoryContextLoader` profile resolution path).
- `selfLearning` is consumed by run-engine learning hook setup (`createToolLoopLearningHook`).

Intra-package call sites:
- `buildConfigFromPreset` is exercised in tests and exported publicly.
- No non-test runtime module in `packages/agent/src` currently calls `buildConfigFromPreset` directly.

## Testing and Observability
Preset tests in `packages/agent/src/__tests__`:
- `presets.factory.test.ts`
- Validates id shape, field mapping, override precedence, guardrail merge behavior, tool filtering (including nameless tool pass-through), self-correction mapping, `defaultModelTier`, return shape, and registry semantics.
- `presets.built-in.test.ts`
- Validates shared preset contract, per-preset invariants, and `BUILT_IN_PRESETS` uniqueness/completeness.

Observability status:
- `src/presets` emits no telemetry/events itself.
- Observable effects are indirect through downstream runtime behavior once returned config is used by agent execution layers.

## Risks and TODOs
- Type looseness at preset boundary:
- `model`, `tools`, `memory`, and `eventBus` are typed as `unknown` in preset types and output config. This keeps factory generic but shifts strict typing to call sites.

- Tool allowlist gap for nameless tools:
- Filtering keeps tools without `name`, which preserves compatibility but weakens strict allowlisting semantics.

- Generated id collision risk:
- `Date.now()`-based ids can collide for same-preset invocations in the same millisecond.

- `defaultModelTier` not consumed by `DzupAgentConfig` directly:
- Preset factory carries this hint forward, but current agent config type has no dedicated `defaultModelTier` property.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js.
