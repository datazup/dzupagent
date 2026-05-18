# Formats Architecture (`packages/core/src/formats`)

## Scope
This document covers the format and schema interoperability surface implemented in `packages/core/src/formats` inside `@dzupagent/core`.

In-scope implementation files:
- `agent-card-types.ts`
- `agents-md-types.ts`
- `agents-md-parser-v2.ts`
- `openai-function-types.ts`
- `tool-format-types.ts`
- `zod-json-schema-converter.ts`
- `structured-output-schema.ts`
- `structured-output-contract.ts`
- `structured-output-retry.ts`
- `tool-format-adapters.ts`
- `index.ts`
- `__tests__/formats.test.ts`

In-scope integration references inside `packages/core`:
- `src/index.ts`
- `src/pipeline.ts`
- `src/advanced.ts`
- `src/stable.ts`
- `src/structured/output-schema.ts`
- `package.json`

Out of scope:
- Provider SDK invocation internals outside this module.
- Non-format packages/modules except where they consume or re-export this surface.

## Responsibilities
`src/formats` provides canonical types and helpers for converting, normalizing, and validating structured formats shared across runtime layers.

Current responsibilities in code:
- Validate A2A-style Agent Card v2 payloads with Zod (`AgentCardV2Schema`, `validateAgentCard`).
- Define AGENTS.md v2 document types and parse/generate/legacy-bridge logic (`parseAgentsMdV2`, `generateAgentsMd`, `toLegacyConfig`).
- Define OpenAI-compatible function/tool type shapes (`OpenAIFunctionDefinition`, `OpenAIToolDefinition`).
- Convert between canonical tool descriptors and OpenAI/MCP-compatible descriptors.
- Convert a basic subset between Zod and JSON Schema (`zodToJsonSchema`, `jsonSchemaToZod`).
- Build structured-output schema descriptors (canonical JSON schema, hash, preview, summary).
- Prepare structured-output contracts (provider schema target, envelope handling, request vs response schema descriptors).
- Execute retry loops for parse-correction workflows (non-streaming and streaming variants).
- Attach structured-output diagnostics to thrown errors for upstream logging/correlation.

## Structure
1. `agent-card-types.ts`
- Defines `AgentCardV2` and related subtypes (`AgentCardCapability`, `AgentCardSkill`, `AgentAuthScheme`, `AgentCardSLA`, etc.).
- Exposes `AgentCardV2Schema` and `validateAgentCard`.

2. `agents-md-types.ts`
- Declares typed AGENTS.md v2 document pieces: metadata, capabilities, memory config, security config, full document.

3. `agents-md-parser-v2.ts`
- Implements lightweight frontmatter parsing (`parseFrontMatter`, simple YAML scalar/array parsing).
- Parses markdown `##` sections for capabilities/memory/security.
- Generates AGENTS.md markdown from typed documents.
- Maps v2 docs into legacy `AgentsMdConfig`.

4. `openai-function-types.ts`
- Contains type-only OpenAI function/tool contracts used by adapter helpers.

5. `tool-format-types.ts`
- Holds shared canonical descriptor types for tools and structured-output diagnostics.

6. `zod-json-schema-converter.ts`
- Implements subset conversion helpers:
  - `zodToJsonSchema`
  - `jsonSchemaToZod`

7. `structured-output-schema.ts`
- Handles schema normalization and diagnostics:
  - `toOpenAISafeSchema`
  - `toStructuredOutputJsonSchema`
  - `describeStructuredOutputSchema`
  - `buildStructuredOutputSchemaName`
  - `attachStructuredOutputErrorContext`

8. `structured-output-contract.ts`
- Determines structured-output strategy/provider and builds runtime contract:
  - `detectStructuredOutputStrategy`
  - `resolveStructuredOutputCapabilities`
  - `resolveStructuredOutputSchemaProvider`
  - `shouldAttemptNativeStructuredOutput`
  - `prepareStructuredOutputSchemaContract`
  - `unwrapStructuredEnvelope`

9. `structured-output-retry.ts`
- Contains generic retry loop primitives and message helpers:
  - `executeStructuredParseLoop`
  - `executeStructuredParseStreamLoop`
  - `buildStructuredOutputCorrectionPrompt`
  - `buildStructuredOutputExhaustedError`
  - `isStructuredOutputExhaustedErrorMessage`

10. `tool-format-adapters.ts`
- Backward-compatible adapter module.
- Re-exports type/converter/schema utilities from focused modules.
- Owns concrete OpenAI/MCP conversion helpers (`toOpenAIFunction`, `toOpenAITool`, `fromOpenAIFunction`, `toMCPToolDescriptor`, `fromMCPToolDescriptor`).

11. `index.ts`
- Barrel export of the formats public surface.

## Runtime and Control Flow
1. Schema contract preparation
- Callers pass a `z.ZodType` into `prepareStructuredOutputSchemaContract`.
- Non-object top-level schemas are wrapped in `{ result: ... }` (`requiresEnvelope: true`).
- `schemaProvider: 'openai'` uses `toOpenAISafeSchema` before descriptor generation.
- Output includes:
  - `requestSchema` (provider-facing)
  - `responseSchema` (validator-facing)
  - stable descriptors/hashes/previews for both.

2. Native structured-output gating
- Runtime strategy is inferred by `detectStructuredOutputStrategy` (`claude/anthropic` => `anthropic-tool-use`, `gpt/openai` => `openai-json-schema`, else `generic-parse`).
- `resolveStructuredOutputCapabilities` merges explicit capabilities with inferred defaults.
- `shouldAttemptNativeStructuredOutput` requires both:
  - runtime has a `withStructuredOutput` function
  - preferred strategy is in native set (`anthropic-tool-use`, `openai-json-schema`) when capabilities are provided.

3. Parse retry loops
- `executeStructuredParseLoop` runs invoke -> parse -> optional state mutation until success/exhaustion.
- `executeStructuredParseStreamLoop` emits intermediate `{ type: 'event' }` events and final `{ type: 'result' }`.
- Stream mode requires each invoke generator to terminate with `{ raw, meta }`; otherwise it throws.

4. Tool descriptor adaptation
- Canonical `ToolSchemaDescriptor` maps to:
  - OpenAI function shape (`toOpenAIFunction`)
  - OpenAI tool wrapper (`toOpenAITool`)
  - MCP-compatible descriptor (`toMCPToolDescriptor`)
- Reverse mapping helpers normalize inbound external shapes back to canonical descriptor types.

5. AGENTS.md v2 flow
- `parseAgentsMdV2` reads optional frontmatter + `##` sections.
- `generateAgentsMd` reconstructs a markdown document with frontmatter and structured sections.
- `toLegacyConfig` converts parsed docs into legacy `AgentsMdConfig` (`instructions`, `allowedTools`, `blockedTools`).

## Key APIs and Types
Primary runtime APIs:
- `validateAgentCard(data)`
- `parseAgentsMdV2(content)`
- `generateAgentsMd(doc)`
- `toLegacyConfig(doc)`
- `zodToJsonSchema(schema)`
- `jsonSchemaToZod(schema)`
- `toOpenAISafeSchema(schema)`
- `toStructuredOutputJsonSchema(schema, options?)`
- `describeStructuredOutputSchema(schema, options?)`
- `buildStructuredOutputSchemaName(input)`
- `attachStructuredOutputErrorContext(err, input)`
- `detectStructuredOutputStrategy(runtime)`
- `resolveStructuredOutputCapabilities(runtime, config?)`
- `resolveStructuredOutputSchemaProvider(override, capabilities)`
- `shouldAttemptNativeStructuredOutput(runtime, capabilities)`
- `prepareStructuredOutputSchemaContract(schema, options?)`
- `unwrapStructuredEnvelope(value, requiresEnvelope)`
- `executeStructuredParseLoop(input)`
- `executeStructuredParseStreamLoop(input)`
- `buildStructuredOutputCorrectionPrompt(schema, error)`
- `buildStructuredOutputExhaustedError(schema, attempts)`
- `isStructuredOutputExhaustedErrorMessage(message, schema)`
- `toOpenAIFunction(tool)` / `toOpenAITool(tool)` / `fromOpenAIFunction(fn)`
- `toMCPToolDescriptor(tool)` / `fromMCPToolDescriptor(mcp)`

Primary exported types:
- Agent card types: `AgentCardV2` and related capability/auth/SLA/provider shapes.
- AGENTS.md v2 types: `AgentsMdDocument`, `AgentsMdMetadata`, `AgentsMdCapability`, `AgentsMdMemoryConfig`, `AgentsMdSecurityConfig`.
- OpenAI descriptor types: `OpenAIFunctionDefinition`, `OpenAIToolDefinition`.
- Canonical descriptor types: `ToolSchemaDescriptor`, `MCPToolDescriptorCompat`.
- Structured-output descriptors and error context types.
- Structured-output runtime/contract types: `StructuredOutputRuntimeMeta`, `StructuredOutputProvider`, `StructuredOutputSchemaContract`.
- Retry-loop input/result/stream event types.

## Dependencies
External/runtime dependencies used directly in this module:
- `zod`
- Node built-in `node:crypto` (`createHash`)

Internal dependencies:
- `../llm/model-config.js` (structured-output capability/strategy types)
- `../skills/agents-md-parser.js` (legacy `AgentsMdConfig` bridge type)

Package-level dependency context (`packages/core/package.json`):
- `zod` is a peer dependency and also present in dev dependencies for local test/build.
- No direct OpenAI/Anthropic SDK imports in runtime format modules.
- `@langchain/openai` and `@langchain/anthropic` appear in `formats.test.ts` only (test-time contract checks).

## Integration Points
Entry-point exposure:
- `src/index.ts` re-exports the formats API and types from `./formats/index.js`.
- `src/pipeline.ts` also re-exports the same formats surface.
- `src/advanced.ts` mirrors root exports via `export * from './index.js'`, so formats are reachable through `@dzupagent/core/advanced`.
- `src/stable.ts` exports only facades (`./facades/index.js`), so formats are not available via `@dzupagent/core/stable`.

Package subpath exports (`packages/core/package.json`):
- No dedicated `./formats` subpath is exported.
- Consumers access this surface through `@dzupagent/core`, `@dzupagent/core/pipeline`, or `@dzupagent/core/advanced`.

Intra-package consumers:
- `src/structured/output-schema.ts` imports `prepareStructuredOutputSchemaContract` and `unwrapStructuredEnvelope` from formats to build runtime-agnostic structured validators.

## Testing and Observability
Tests directly covering this module:
- `src/formats/__tests__/formats.test.ts`
  - Agent card schema validation paths.
  - Zod <-> JSON Schema conversion paths.
  - OpenAI-safe schema stripping and structured-output descriptor generation.
  - Retry loops (sync + stream) and correction/exhaustion message helpers.
  - OpenAI/MCP adapter mappings and round-trips.
  - AGENTS.md v2 parse/generate/round-trip/legacy conversion.
  - Provider-facing payload shape checks through LangChain OpenAI/Anthropic wrappers.
- `src/__tests__/w15-h2-branch-coverage.test.ts`
  - Additional branch-focused coverage for `agents-md-parser-v2.ts` and `tool-format-adapters.ts` code paths.

Observability behavior in this module:
- No direct event-bus or telemetry emission in `src/formats`.
- `attachStructuredOutputErrorContext` enriches `Error` objects with schema metadata, provider/model hints, and failure category for upstream logging/diagnostics.

## Risks and TODOs
- AGENTS.md frontmatter parsing is intentionally lightweight (flat key/value + inline arrays); complex YAML features are not supported.
- `zodToJsonSchema` / `jsonSchemaToZod` cover a constrained subset and fall back to permissive outputs for unsupported constructs.
- `toOpenAISafeSchema` intentionally strips constraints (length/range/pattern-like guards) to satisfy OpenAI structured-output compatibility, reducing provider-side strictness compared with original schema intent.
- `detectStructuredOutputStrategy` relies on model-name substring heuristics; non-standard model naming can lead to `generic-parse` defaults unless capabilities are supplied.
- `executeStructuredParseStreamLoop` requires a terminal `{ raw, meta }` return from invoke generator; missing return raises an error.
- `attachStructuredOutputErrorContext` mutates `Error` objects via `Object.assign`; downstream code expecting strict error shapes should account for enriched fields.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

