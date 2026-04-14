# Presets Architecture (`src/presets`)

## 1. Scope and Intent

The `src/presets` module provides a lightweight preset system for bootstrapping `DzupAgent` configurations from reusable profiles.

It is intentionally small and currently includes:

1. A preset data model (`AgentPreset`, `PresetRuntimeDeps`)
2. Four built-in preset definitions (RAG chat, research, summarization, QA)
3. A config factory (`buildConfigFromPreset`)
4. A simple runtime registry (`PresetRegistry`)

This module does not execute agents directly; it prepares configuration payloads used by `new DzupAgent(config)`.

## 2. Module Map

- `types.ts`
  - Defines preset schema (`AgentPreset`) and runtime dependencies (`PresetRuntimeDeps`).
- `built-in.ts`
  - Defines built-in constants:
    - `RAGChatPreset`
    - `ResearchPreset`
    - `SummarizerPreset`
    - `QAPreset`
- `factory.ts`
  - Contains `buildConfigFromPreset`, `PresetRegistry`, and `createDefaultPresetRegistry`.
- `index.ts`
  - Barrel export for public API.

## 3. Data Model and Feature Surface

### 3.1 `AgentPreset`

`AgentPreset` fields and current behavior:

| Field | Purpose | Runtime status |
|---|---|---|
| `name` | Preset identifier | Used by registry and output config (`name`, `id`) |
| `description` | Human-readable explanation | Metadata only in current factory/runtime path |
| `instructions` | Baseline system instructions | Used in output config unless overridden |
| `toolNames` | Expected tool allowlist by name | Used to filter provided runtime tools |
| `guardrails.maxIterations` | Loop iteration cap | Mapped to output `guardrails.maxIterations` |
| `guardrails.maxCostCents` | Cost budget | Mapped to output `guardrails.maxCostCents` |
| `guardrails.maxTokens` | Token budget | Mapped to output `guardrails.maxTokens` |
| `memoryProfile` | Memory budget profile | Mapped to output `memoryProfile` |
| `selfCorrection` | Self-reflection metadata | Declared but not consumed by `buildConfigFromPreset` |
| `defaultModelTier` | Preferred model tier metadata | Declared but not consumed by `buildConfigFromPreset` |

### 3.2 `PresetRuntimeDeps`

`PresetRuntimeDeps` carries runtime objects for materializing a full agent config:

- `model` (required)
- `tools` (optional, then filtered by `preset.toolNames`)
- `memory` (optional)
- `eventBus` (optional)
- `overrides` (optional partial override of `instructions`, `guardrails`, `memoryProfile`)

`overrides` is intentionally narrow and does not include fields such as `model`, `tools`, or `selfCorrection`.

## 4. Built-in Presets (Current Catalog)

### 4.1 `RAGChatPreset` (`name: "rag-chat"`)

- Goal: conversational retrieval with citations
- Tool contract: `rag_query`
- Guardrails: `maxIterations: 5`, `maxCostCents: 20`
- Memory profile: `balanced`
- Characteristics: short-loop, retrieval-only default

### 4.2 `ResearchPreset` (`name: "research"`)

- Goal: multi-step autonomous research and report synthesis
- Tool contract: `web_search`, `ingest_source`, `rag_query`, `create_note`, `generate_content`, `synthesize_report`
- Guardrails: `maxIterations: 20`, `maxCostCents: 100`, `maxTokens: 100000`
- Memory profile: `balanced`
- Self-correction metadata: enabled with threshold hints
- Characteristics: largest budget, broadest tool set

### 4.3 `SummarizerPreset` (`name: "summarizer"`)

- Goal: summarize retrieved material without hallucination
- Tool contract: `rag_query`, `generate_content`
- Guardrails: `maxIterations: 5`, `maxCostCents: 10`
- Memory profile: `minimal`
- Characteristics: cost-focused summarization profile

### 4.4 `QAPreset` (`name: "qa"`)

- Goal: focused question answering over indexed sources with citations
- Tool contract: `rag_query`
- Guardrails: `maxIterations: 8`, `maxCostCents: 30`
- Memory profile: `balanced`
- Characteristics: deeper than summarizer, narrower than research

## 5. Runtime Flow

Preset-to-runtime flow in current implementation:

1. Select a preset object (built-in constant or registry lookup).
2. Gather runtime dependencies (`model`, optional `tools`, `memory`, `eventBus`).
3. Call `buildConfigFromPreset(preset, deps)`.
4. Factory resolves fields:
   - `instructions = overrides.instructions ?? preset.instructions`
   - `guardrails = { ...preset.guardrails, ...overrides.guardrails }`
   - `memoryProfile = overrides.memoryProfile ?? preset.memoryProfile`
5. Factory filters `deps.tools` by `preset.toolNames`:
   - if a tool has a `name`, it must be listed in `toolNames`
   - tools without a `name` are kept
6. Factory returns config object with generated id `preset-${preset.name}-${Date.now()}`.
7. Caller passes resulting config to `new DzupAgent(...)`.
8. During execution, `DzupAgent` and `run-engine` consume:
   - `guardrails.maxIterations` as loop limit candidate
   - `guardrails.maxTokens` / `maxCostCents` via `IterationBudget`
   - `memoryProfile` via `AgentMemoryContextLoader` memory-profile resolution

## 6. Usage Examples

## 6.1 Basic built-in preset

```ts
import {
  DzupAgent,
  RAGChatPreset,
  buildConfigFromPreset,
  type DzupAgentConfig,
} from '@dzupagent/agent'

const cfg = buildConfigFromPreset(RAGChatPreset, {
  model: chatModel,
  tools: [ragQueryTool, webSearchTool], // webSearchTool is filtered out
  memory,
  eventBus,
})

const agent = new DzupAgent(cfg as DzupAgentConfig)
```

## 6.2 Override instructions and budgets

```ts
import {
  DzupAgent,
  ResearchPreset,
  buildConfigFromPreset,
  type DzupAgentConfig,
} from '@dzupagent/agent'

const cfg = buildConfigFromPreset(ResearchPreset, {
  model: reasoningModel,
  tools: [webSearchTool, ingestSourceTool, ragQueryTool, createNoteTool, generateContentTool, synthesizeReportTool],
  overrides: {
    instructions: `${ResearchPreset.instructions}\n\nPrefer peer-reviewed and primary sources.`,
    guardrails: { maxCostCents: 60, maxIterations: 12 },
    memoryProfile: 'memory-heavy',
  },
})

const agent = new DzupAgent(cfg as DzupAgentConfig)
```

## 6.3 Custom presets with registry

```ts
import {
  PresetRegistry,
  buildConfigFromPreset,
  DzupAgent,
  type AgentPreset,
  type DzupAgentConfig,
} from '@dzupagent/agent'

const registry = new PresetRegistry()

const triagePreset: AgentPreset = {
  name: 'incident-triage',
  description: 'Incident triage and initial diagnosis',
  instructions: 'You triage incidents, classify severity, and propose immediate mitigation.',
  toolNames: ['search_incidents', 'query_metrics', 'create_ticket'],
  guardrails: { maxIterations: 6, maxCostCents: 25 },
  memoryProfile: 'minimal',
}

registry.register(triagePreset)

const preset = registry.get('incident-triage')
if (!preset) throw new Error('Preset not found')

const cfg = buildConfigFromPreset(preset, { model: chatModel, tools })
const agent = new DzupAgent(cfg as DzupAgentConfig)
```

## 6.4 About `createDefaultPresetRegistry()`

```ts
import { createDefaultPresetRegistry, RAGChatPreset } from '@dzupagent/agent'

const registry = createDefaultPresetRegistry()
registry.register(RAGChatPreset) // required today; default registry starts empty
```

## 7. Cross-Package References and Usage

Observed usage in this monorepo:

1. `@dzupagent/agent` public API exports preset symbols via `packages/agent/src/index.ts`.
2. No runtime code in other workspace packages currently imports:
   - `buildConfigFromPreset`
   - `PresetRegistry`
   - `createDefaultPresetRegistry`
   - built-in preset constants (`RAGChatPreset`, `ResearchPreset`, `SummarizerPreset`, `QAPreset`)
3. API documentation references are generated under `docs/api/agent/src/*` (Typedoc output).
4. `packages/create-dzupagent/src/presets.ts` is a separate scaffolding preset system and does not consume `packages/agent/src/presets`.

Implication: the preset module is currently a published surface with low in-repo runtime adoption.

## 8. Test Coverage Status

### 8.1 Direct tests

There are currently no dedicated tests targeting `src/presets/*` in `packages/agent/src/__tests__`.

### 8.2 Coverage evidence

From `packages/agent/coverage/coverage-summary.json`:

- `src/presets/built-in.ts`:
  - lines: `0%` (`0/69`)
  - functions: `0%`
  - branches: `0%`
- `src/presets/factory.ts`:
  - lines: `0%` (`0/66`)
  - functions: `0%`
  - branches: `0%`

### 8.3 Indirectly related tests

`src/__tests__/memory-profiles.test.ts` validates memory profile resolution in `agent/memory-profiles.ts`, which is conceptually related to `preset.memoryProfile`, but does not exercise preset factory wiring.

## 9. Gaps and Recommendations

Current architectural gaps:

1. `createDefaultPresetRegistry()` returns an empty registry despite the name suggesting built-ins.
2. `AgentPreset.selfCorrection` and `AgentPreset.defaultModelTier` are not mapped into generated config.
3. `buildConfigFromPreset` returns `Record<string, unknown>` rather than `DzupAgentConfig`, which weakens compile-time safety for callers.
4. No contract tests validate tool filtering, override precedence, or built-in preset integrity.

Recommended tests to add:

1. `presets.factory.test.ts`
   - validates override precedence for instructions/guardrails/memoryProfile
   - validates tool filtering behavior (allowed, disallowed, nameless tool objects)
   - validates output id/name/guardrail mapping
2. `presets.registry.test.ts`
   - validates register/get/list/listNames semantics
   - validates default registry behavior explicitly (empty vs expected built-ins)
3. `presets.built-in.test.ts`
   - snapshots or asserts stable built-in contracts (names, required toolNames, minimum guardrail fields)

Potential evolution options:

1. Auto-register built-ins in `createDefaultPresetRegistry()`.
2. Change `buildConfigFromPreset` return type to `DzupAgentConfig` (or `Pick<DzupAgentConfig, ...>`).
3. Decide whether `selfCorrection` and `defaultModelTier` are:
   - strictly metadata, or
   - first-class runtime config fields with explicit wiring.

