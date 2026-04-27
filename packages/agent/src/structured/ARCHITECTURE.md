# Structured Output Architecture (`packages/agent/src/structured`)

## Scope
This document covers the structured-output subsystem in `@dzupagent/agent`:

- `src/structured/index.ts`
- `src/structured/structured-output-types.ts`
- `src/structured/structured-output-engine.ts`

It also covers direct runtime consumers inside `packages/agent` and relevant public exports.

Out of scope:

- `src/agent/structured-generate.ts` and `DzupAgent.generateStructured(...)` (separate implementation path)
- Provider SDK-native structured output wiring in other packages

## Responsibilities
The subsystem is responsible for turning LLM responses into validated typed data with stable schema diagnostics.

Core responsibilities:

- Resolve structured-output capabilities from explicit config, model metadata, or model-name heuristics.
- Build a schema contract via `prepareStructuredOutputSchemaContract(...)`, including:
  - stable schema name
  - schema hash
  - optional envelope (`{ result: ... }`) for non-object schemas
  - provider-oriented schema normalization (`generic` vs `openai`)
- Execute retry-aware parse loops with corrective prompts using `executeStructuredParseLoop(...)`.
- Support strategy execution and fallback ordering.
- Attach structured diagnostics to thrown errors (failure category, schema refs, provider/model context, message count).

## Structure
- `index.ts`
  - Re-exports:
    - `generateStructured`
    - `detectStrategy` (alias of `detectStructuredOutputStrategy` from `@dzupagent/core`)
    - `resolveStructuredOutputCapabilities`
  - Re-exports types:
    - `StructuredOutputStrategy`
    - `StructuredOutputCapabilities`
    - `StructuredOutputConfig`
    - `StructuredOutputResult`
    - `StructuredLLM`
    - `StructuredLLMWithMeta`

- `structured-output-types.ts`
  - Defines API-facing config/result types.
  - `StructuredOutputConfig<T>` includes:
    - `schema` (required)
    - optional `strategy`
    - optional explicit `capabilities`
    - `maxRetries`
    - `schemaName`
    - `agentId`
    - `intent`
    - `schemaDescription`
    - `schemaProvider` (`generic` or `openai`)
  - `StructuredOutputResult<T>` includes:
    - `data`
    - `strategy`
    - `retries`
    - `raw`
    - `schemaName`
    - `schemaHash`

- `structured-output-engine.ts`
  - Public API:
    - `generateStructured<T>(llm, messages, config)`
    - `detectStrategy`
    - `resolveStructuredOutputCapabilities`
  - Internal helpers:
    - `extractJson(...)`
    - `buildSchemaPrompt(...)`
    - `tryParse(...)`
    - `tryStrategy(...)`

## Runtime and Control Flow
1. Caller invokes `generateStructured(llm, messages, config)`.
2. Engine resolves capabilities:
   - `config.capabilities` (highest priority)
   - `llm.structuredOutputCapabilities`
   - heuristic `detectStrategy` from model/modelName/name
3. Engine resolves schema provider via `resolveStructuredOutputSchemaProvider(...)`.
4. Engine builds a schema contract with `prepareStructuredOutputSchemaContract(...)`:
   - derives stable `schemaName`
   - computes request/response schema descriptors and hashes
   - wraps non-object schemas in envelope form
5. Engine computes strategy list:
   - if `config.strategy` is set: run only that strategy
   - otherwise: run `preferredStrategy` plus either capability-defined fallbacks or default fallbacks (`generic-parse`, `fallback-prompt`, deduped)
6. For each strategy, `tryStrategy(...)` runs `executeStructuredParseLoop(...)`:
   - optional envelope system instruction is appended when required
   - for `fallback-prompt`, schema instructions (name/hash/JSON Schema) are injected
   - each attempt calls `llm.invoke(messages)`
   - output is parsed (`extractJson` -> `JSON.parse` -> `schema.safeParse`)
   - on parse/validation failure, retry state appends assistant raw output plus corrective user message from `buildStructuredOutputCorrectionPrompt(...)`
7. On first success, return `StructuredOutputResult`.
8. On exhaustion/failure:
   - choose terminal error (`parse_exhausted` vs provider execution error)
   - enrich via `attachStructuredOutputErrorContext(...)`
   - attach `structuredOutputStrategies` and `structuredOutputMaxRetriesPerStrategy`
   - throw enriched error

## Key APIs and Types
- `generateStructured<T>(llm, messages, config): Promise<StructuredOutputResult<T>>`
  - Main entrypoint for typed structured extraction.

- `detectStrategy(runtime): StructuredOutputStrategy`
  - Heuristic strategy detection based on model metadata.

- `resolveStructuredOutputCapabilities(runtime, config?)`
  - Capability resolution utility exposed for callers/tests.

- `StructuredLLM`
  - Minimal contract: `invoke(messages) => Promise<{ content: string }>`.

- `StructuredLLMWithMeta`
  - Optional metadata fields for strategy/capability resolution:
    - `model`
    - `modelName`
    - `name`
    - `structuredOutputCapabilities`

- Strategy identifiers (from `@dzupagent/core`):
  - `anthropic-tool-use`
  - `openai-json-schema`
  - `generic-parse`
  - `fallback-prompt`

## Dependencies
Direct package dependencies used by this subsystem:

- `@dzupagent/core`
  - `detectStructuredOutputStrategy`
  - `resolveStructuredOutputCapabilities`
  - `resolveStructuredOutputSchemaProvider`
  - `prepareStructuredOutputSchemaContract`
  - `executeStructuredParseLoop`
  - `buildStructuredOutputCorrectionPrompt`
  - `buildStructuredOutputExhaustedError`
  - `isStructuredOutputExhaustedErrorMessage`
  - `attachStructuredOutputErrorContext`
  - `unwrapStructuredEnvelope`
- `zod`
  - Runtime schema validation through the prepared schema contract.

`package.json` context for `@dzupagent/agent`:

- Internal runtime dependencies include `@dzupagent/core` and related framework packages.
- Peer dependencies include `zod` and LangChain packages.

## Integration Points
Primary runtime integration:

- `src/orchestration/planning-agent.ts`
  - Imports `generateStructured` and `StructuredLLM`.
  - `PlanningAgent.decompose(...)` calls `generateStructured(...)` with:
    - explicit capabilities (`preferredStrategy: generic-parse`, fallback `fallback-prompt`)
    - explicit `schemaProvider: generic`
    - stable schema metadata (`agentId`, `intent`, `schemaName`, `schemaDescription`)

Related orchestration integration:

- `src/orchestration/delegating-supervisor.ts`
  - Uses `StructuredLLM` type in `planAndDelegate` options.
  - Falls back to keyword planning if LLM-based decomposition fails.

Public API integration:

- `src/index.ts`
  - Re-exports `generateStructured` as `generateStructuredOutput`.
  - Re-exports strategy/config/result/capability/LLM types from `src/structured`.

Adjacent but separate path:

- `src/agent/dzip-agent.ts` -> `src/agent/structured-generate.ts`
  - `DzupAgent.generateStructured(...)` does not call this subsystem.

## Testing and Observability
Test coverage in `packages/agent` directly exercises this module and its planning integration.

Direct structured-output tests:

- `src/__tests__/structured-output.test.ts`
  - strategy detection matrix checks
  - capability resolution precedence
  - parse from plain JSON and fenced code blocks
  - retries and corrective loop behavior
  - fallback ordering
  - explicit strategy behavior
  - envelope wrapping/unwrapping for non-object schemas
  - provider/schema diagnostics on failures
  - provider execution failure categorization

Integration-adjacent tests:

- `src/__tests__/plan-decomposition.test.ts`
  - `PlanningAgent.decompose(...)` behavior relying on structured extraction
  - invalid specialist filtering, dependency cleanup, cycle detection, max-node enforcement
  - `DelegatingSupervisor.planAndDelegate(...)` LLM fallback behavior

Local verification run used for this refresh:

- `yarn workspace @dzupagent/agent test -- structured-output.test.ts plan-decomposition.test.ts`
- Result: 2 test files passed, 48 tests passed.

Observability/error surface:

- thrown errors are enriched with:
  - `failureCategory`
  - `schemaName`
  - `schemaHash`
  - provider/model metadata
  - structured request/response schema references
  - selected strategy list and retry budget per strategy

## Risks and TODOs
- Strategy names imply provider-native modes (`anthropic-tool-use`, `openai-json-schema`), but this engine currently executes all strategies through `llm.invoke(...)` plus parse/validate loops.
- `extractJson(...)` remains regex-based and can still mis-handle ambiguous mixed-content responses.
- Cancellation is not wired into `generateStructured(...)`/`tryStrategy(...)` (no `AbortSignal` path in this module).
- The module intentionally relies on caller-provided capability metadata for deterministic behavior; call sites that omit explicit capabilities may still depend on heuristic model-name detection.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
