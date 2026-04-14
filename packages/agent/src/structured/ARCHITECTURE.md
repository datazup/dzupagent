# Structured Output Architecture (`packages/agent/src/structured`)

## Purpose
This module provides a lightweight, schema-first structured-output engine for LLM calls in `@dzupagent/agent`.

It solves one core problem:
- given raw model output, produce strongly-typed data (`zod`) with retries and fallback strategies.

Primary runtime consumer:
- `PlanningAgent.decompose(...)` in [`packages/agent/src/orchestration/planning-agent.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/orchestration/planning-agent.ts:426)

---

## Module Contents

### 1) Public barrel
- [`index.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/structured/index.ts:1)
- Re-exports:
  - `generateStructured`
  - `detectStrategy`
  - `StructuredLLM`, `StructuredLLMWithMeta`
  - `StructuredOutputStrategy`, `StructuredOutputConfig`, `StructuredOutputResult`

### 2) Types
- [`structured-output-types.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/structured/structured-output-types.ts:1)
- Defines:
  - Strategy union:
    - `anthropic-tool-use`
    - `openai-json-schema`
    - `generic-parse`
    - `fallback-prompt`
  - Config:
    - `schema` (required `z.ZodType<T>`)
    - optional `strategy`, `maxRetries`, `schemaName`, `schemaDescription`
  - Result:
    - `data`, `strategy`, `retries`, `raw`

### 3) Engine
- [`structured-output-engine.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/structured/structured-output-engine.ts:1)
- Implements:
  - provider strategy detection (`detectStrategy`)
  - JSON extraction (`extractJson`)
  - schema prompt generation via JSON Schema (`buildSchemaPrompt`)
  - parse + zod validate (`tryParse`)
  - per-strategy retry loop (`tryStrategy`)
  - global fallback chain orchestration (`generateStructured`)

---

## Key Features

### Feature: Model-aware strategy auto-detection
`detectStrategy(llm)` maps model metadata to a preferred strategy:
- Claude/Anthropic names -> `anthropic-tool-use`
- GPT/OpenAI names -> `openai-json-schema`
- otherwise -> `generic-parse`

Metadata fields checked:
- `llm.model`
- `llm.modelName`
- `llm.name`

Reference: [`structured-output-engine.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/structured/structured-output-engine.ts:29)

### Feature: Robust JSON extraction from noisy text
`extractJson(raw)` accepts:
- plain JSON object/array
- fenced JSON markdown blocks
- fenced generic markdown blocks
- best-effort first object/array match

Reference: [`structured-output-engine.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/structured/structured-output-engine.ts:49)

### Feature: Zod-backed validation and error-guided retries
`tryParse`:
- `JSON.parse(...)`
- `schema.safeParse(...)`
- formats validation issues for feedback back into retry prompts

`tryStrategy`:
- on validation error, appends:
  - previous assistant response
  - corrective user instruction with exact parse/validation error
- retries up to `maxRetries`

Reference: [`structured-output-engine.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/structured/structured-output-engine.ts:99)

### Feature: Multi-strategy fallback chain
`generateStructured` executes:
1. primary strategy (`config.strategy` or auto-detected)
2. `generic-parse` (if not already primary)
3. `fallback-prompt` (if not already primary)

If all fail, throws a detailed error including attempted strategies and retry budget.

Reference: [`structured-output-engine.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/structured/structured-output-engine.ts:193)

### Feature: Schema-in-prompt fallback mode
For `fallback-prompt`, engine serializes Zod schema to JSON Schema via:
- `zodToJsonSchema` from `@dzupagent/core`

It injects strict instructions:
- return only JSON
- include schema name/description and JSON Schema body

Reference:
- [`structured-output-engine.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/structured/structured-output-engine.ts:79)
- [`packages/core/src/formats/tool-format-adapters.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/formats/tool-format-adapters.ts:39)

---

## End-to-End Flow

```text
Caller (PlanningAgent or public API)
  -> generateStructured(llm, messages, config)
    -> choose primary strategy (explicit or detectStrategy)
    -> for strategy in [primary, generic-parse?, fallback-prompt?]:
         -> tryStrategy(...)
            -> optional schema prompt injection (fallback-prompt only)
            -> invoke llm with current messages
            -> extractJson -> JSON.parse -> zod.safeParse
            -> if valid: return StructuredOutputResult
            -> if invalid and retries left: append correction turn and retry
            -> if exhausted: return null
    -> if all strategies returned null: throw error
```

---

## API Usage

### Direct usage: typed extraction
```ts
import { z } from 'zod'
import { generateStructured } from '@dzupagent/agent'

const PersonSchema = z.object({
  name: z.string(),
  age: z.number().int().nonnegative(),
})

const result = await generateStructured(llm, [
  { role: 'system', content: 'Extract person data' },
  { role: 'user', content: 'Alice is 30 years old.' },
], {
  schema: PersonSchema,
  maxRetries: 2,
  schemaName: 'Person',
  schemaDescription: 'Person profile extracted from text',
})

// result.data is typed as { name: string; age: number }
```

### Force a specific strategy
```ts
const result = await generateStructured(llm, messages, {
  schema: PersonSchema,
  strategy: 'fallback-prompt',
})
```

### Use detected strategy (default)
```ts
const result = await generateStructured(llmWithModelMeta, messages, {
  schema: PersonSchema,
})
```

### Integration usage: planning decomposition
```ts
import { PlanningAgent } from '@dzupagent/agent'

const planner = new PlanningAgent({ supervisor })
const plan = await planner.decompose('Build onboarding flow', llm)

// Internally uses generateStructured(..., { schema: DecompositionSchema })
// and returns a validated DAG with executionLevels.
```

---

## Practical Use Cases

### 1) LLM plan decomposition (current production usage)
- Parse planner output into DAG-shaped nodes (`DecompositionSchema`)
- Remove invalid nodes/specialists and compute execution levels
- Used by `DelegatingSupervisor.planAndDelegate(..., { llm })` path through `PlanningAgent.decompose`

References:
- [`planning-agent.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/orchestration/planning-agent.ts:397)
- [`delegating-supervisor.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/orchestration/delegating-supervisor.ts:230)

### 2) Typed extraction from unstructured model responses
- classification outputs
- entity extraction
- policy/compliance checks with strict schema
- any place where downstream logic requires validated structure

### 3) Progressive reliability for less-structured model responses
- strategy fallback and corrective retries reduce brittle single-pass parsing failures

---

## References Across Packages

### Runtime references
- `packages/agent/src/orchestration/planning-agent.ts`
  - imports `generateStructured` and `StructuredLLM`
  - uses `DecompositionSchema` in `decompose(...)`
- `packages/agent/src/orchestration/delegating-supervisor.ts`
  - imports `StructuredLLM` type for `planAndDelegate` options
  - delegates LLM decomposition to `PlanningAgent` when LLM is provided

### Public package surface references
- `packages/agent/src/index.ts`
  - re-exports `generateStructured` as `generateStructuredOutput`
  - re-exports detection/types

### Documentation references
- `packages/agent/README.md` lists structured output APIs
- `packages/agent/ARCHITECTURE.md` references structured engine/tests
- `packages/core/src/formats/ARCHITECTURE.md` references structured engine dependency on `zodToJsonSchema`

### Related but separate implementation in another package
- `packages/agent-adapters/src/output/structured-output.ts` contains a different structured-output adapter (provider-fallback around adapter registry).
- It is conceptually similar (parse/retry/fallback) but not a runtime import of this module.

### Important distinction inside `@dzupagent/agent`
- `DzupAgent.generateStructured(...)` in [`packages/agent/src/agent/dzip-agent.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/dzip-agent.ts:143) is a separate path.
- It prefers model-native `withStructuredOutput` when available, else does a local JSON parse fallback.
- It does not call `generateStructured` from this module.

---

## Test Coverage

### Test files covering this module directly
- [`packages/agent/src/__tests__/structured-output.test.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/__tests__/structured-output.test.ts:1)
  - `detectStrategy` model mapping cases
  - JSON parsing from plain JSON and code blocks
  - retry on schema validation failure
  - multi-strategy fallback behavior
  - failure after retry exhaustion
  - explicit strategy override
  - message pass-through to LLM

### Integration-adjacent tests using this module path
- [`packages/agent/src/__tests__/plan-decomposition.test.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/__tests__/plan-decomposition.test.ts:150)
  - validates `PlanningAgent.decompose` behavior that depends on `generateStructured`
  - covers valid decomposition, invalid specialists filtering, cycle handling, maxNodes behavior, and LLM-failure fallback in supervisor path

### Latest executed test results (local run)
- `yarn workspace @dzupagent/agent test -- structured-output.test.ts` -> 13/13 passed
- `yarn workspace @dzupagent/agent test -- plan-decomposition.test.ts` -> 13/13 passed

### Coverage snapshot (targeted run)
Command run:
- `yarn workspace @dzupagent/agent test:coverage -- structured-output.test.ts plan-decomposition.test.ts`

Observed module coverage for `src/structured/structured-output-engine.ts`:
- Statements: `95.92%`
- Branches: `86.2%`
- Functions: `100%`
- Lines: `95.92%`

Notes:
- Coverage command exits non-zero due global package thresholds across unrelated files, despite structured module being highly covered.
- Reported uncovered lines in this module include:
  - non-issue fallback text branch in validation formatting
  - non-string `response.content` JSON-stringify branch
  - terminal defensive `return null` after retry loop

---

## Design Strengths
- Minimal interface (`StructuredLLM`) keeps engine decoupled from concrete model SDKs.
- Clear fallback ordering and retry semantics.
- Rich validation feedback loop improves correction quality.
- Strong unit coverage around core parsing/retry/fallback behavior.

## Current Limitations / Tradeoffs
- Strategy labels (`anthropic-tool-use`, `openai-json-schema`) are currently heuristic names; `tryStrategy` path itself always uses `invoke` + text parse, not provider-native structured APIs.
- `extractJson` uses regex-based extraction; malformed or multi-JSON responses can still confuse parsing.
- Fallback schema prompt quality depends on `zodToJsonSchema` subset support in `@dzupagent/core`.
- No abort-signal handling inside engine loops; cancellation control is owned by caller and model implementation.

## Extension Opportunities
- Add optional provider-native execution paths for named strategies where supported.
- Add cancellable retries (`AbortSignal`) and timeout options.
- Add structured telemetry hooks (strategy attempts, parse error categories, retry counts).
- Add fuzz tests for `extractJson` with mixed markdown/text payloads.
