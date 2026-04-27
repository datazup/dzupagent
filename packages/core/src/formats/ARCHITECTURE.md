# `@dzupagent/core` Formats Architecture

## Scope
`src/formats` is a format/contract utility layer inside `@dzupagent/core`. It owns:
- Agent card validation contracts (`agent-card-types.ts`).
- Tool and structured-output schema adapters (`tool-format-adapters.ts`, `structured-output-contract.ts`, `structured-output-retry.ts`, `openai-function-types.ts`).
- AGENTS.md v2 parse/generate/legacy mapping (`agents-md-types.ts`, `agents-md-parser-v2.ts`).
- The local public surface aggregator (`index.ts`).

The folder is computation-only (string/schema transforms, parsing, validation, retry state transitions). It does not own transport, storage, or process I/O.

## Responsibilities
- Provide strongly typed contracts for agent metadata and tool schema exchange.
- Normalize Zod/JSON-schema conversions and OpenAI/MCP-compatible tool definitions.
- Prepare provider-aware structured-output schema contracts:
  - schema naming,
  - envelope handling for non-object top-level outputs,
  - OpenAI-safe schema stripping,
  - schema hash/preview/summary metadata.
- Provide reusable structured parse retry loops for both non-streaming and streaming invoke patterns.
- Parse and regenerate AGENTS.md v2 documents and bridge to legacy `AgentsMdConfig`.

## Structure
- `index.ts`
  - Re-exports all format APIs/types from this directory.
- `agent-card-types.ts`
  - `AgentCardV2` interfaces, `AgentCardV2Schema`, and `validateAgentCard`.
- `openai-function-types.ts`
  - OpenAI function/tool TypeScript contracts.
- `tool-format-adapters.ts`
  - Canonical `ToolSchemaDescriptor`, Zod<->JSON schema adapters, OpenAI/MCP adapters, structured-output schema descriptors, and error context enrichment helpers.
- `structured-output-contract.ts`
  - Strategy/provider resolution and `prepareStructuredOutputSchemaContract`.
- `structured-output-retry.ts`
  - Generic structured parse retry loops and standardized correction/exhaustion messages.
- `agents-md-types.ts`
  - AGENTS.md v2 document/type model.
- `agents-md-parser-v2.ts`
  - Front matter + markdown section parser, generator, and v2->legacy adapter.
- `__tests__/formats.test.ts`
  - Primary formats suite.
- `../__tests__/w15-h2-branch-coverage.test.ts`
  - Additional branch-oriented tests for parser and adapters.

## Runtime and Control Flow
1. Consumers import format helpers via `@dzupagent/core` (re-exported in `src/index.ts`) or `src/formats/index.ts`.
2. For structured-output flows:
   - `resolveStructuredOutputCapabilities` determines preferred strategy/provider.
   - `prepareStructuredOutputSchemaContract` derives request/response schemas, optional envelope, schema name, hash, preview, and summary.
   - Callers execute model invocation and parsing; on retry they use correction prompts from `buildStructuredOutputCorrectionPrompt`.
   - On terminal failure they build canonical errors via `buildStructuredOutputExhaustedError` and `attachStructuredOutputErrorContext`.
3. For AGENTS.md flows:
   - `parseAgentsMdV2` parses optional front matter and known markdown sections.
   - `generateAgentsMd` writes a normalized document.
   - `toLegacyConfig` maps parsed v2 data into legacy `AgentsMdConfig`.
4. For tool schema interop:
   - Convert Zod/JSON schema as needed (`zodToJsonSchema`, `jsonSchemaToZod`, `toStructuredOutputJsonSchema`).
   - Map tool descriptors to OpenAI/MCP wire shapes and back.

## Key APIs and Types
- Agent card:
  - `AgentCardV2Schema`
  - `validateAgentCard(data)`
  - `AgentCardV2`, `AgentCardValidationResult`
- Tool/schema adapters:
  - `zodToJsonSchema`, `jsonSchemaToZod`
  - `toOpenAIFunction`, `toOpenAITool`, `fromOpenAIFunction`
  - `toMCPToolDescriptor`, `fromMCPToolDescriptor`
  - `ToolSchemaDescriptor`, `MCPToolDescriptorCompat`
- Structured-output schema contract:
  - `toOpenAISafeSchema`, `toStructuredOutputJsonSchema`, `describeStructuredOutputSchema`
  - `buildStructuredOutputSchemaName`
  - `detectStructuredOutputStrategy`, `resolveStructuredOutputCapabilities`, `resolveStructuredOutputSchemaProvider`, `shouldAttemptNativeStructuredOutput`
  - `prepareStructuredOutputSchemaContract`, `unwrapStructuredEnvelope`
  - `StructuredOutputSchemaDescriptor`, `StructuredOutputSchemaSummary`, `StructuredOutputSchemaContract`
- Structured retry loop:
  - `executeStructuredParseLoop`, `executeStructuredParseStreamLoop`
  - `buildStructuredOutputCorrectionPrompt`, `buildStructuredOutputExhaustedError`, `isStructuredOutputExhaustedErrorMessage`
  - `StructuredParseLoopResult` and related loop input/output types
- AGENTS.md v2:
  - `parseAgentsMdV2`, `generateAgentsMd`, `toLegacyConfig`
  - `AgentsMdDocument`, `AgentsMdMetadata`, `AgentsMdMemoryConfig`, `AgentsMdSecurityConfig`

## Dependencies
- External:
  - `zod` for validation and schema conversion.
- Node built-in:
  - `node:crypto` (`createHash`) for stable schema hash generation.
- Internal type/runtime dependencies:
  - `../llm/model-config.ts` for `StructuredOutputModelCapabilities`/strategy types.
  - `../skills/agents-md-parser.ts` type import (`AgentsMdConfig`) for legacy bridge.
- Package-level context:
  - `@dzupagent/core` exports this module through the root entrypoint.
  - `@dzupagent/core` declares `zod` and LangChain packages as peers; formats itself only directly imports `zod`.

## Integration Points
- `packages/core/src/index.ts`
  - Re-exports formats APIs/types to the package root.
- `packages/agent/src/structured/structured-output-engine.ts`
  - Uses schema contract and retry/error helpers from this module for multi-strategy structured extraction.
- `packages/agent/src/agent/structured-generate.ts`
  - Uses the same schema contract and retry/error helpers for DzupAgent structured generation path.
- Tests in `packages/agent/src/__tests__/structured-output.test.ts`
  - Exercise structured-output capability and schema descriptor behavior with `@dzupagent/core` exports.
- No verified runtime callsites outside tests for:
  - `AgentCardV2Schema`/`validateAgentCard`.
  - AGENTS.md v2 parser/generator/legacy bridge.
  - OpenAI/MCP tool adapter pair (`toOpenAIFunction`/`toMCPToolDescriptor` family).

## Testing and Observability
- Tests covering this directory:
  - `src/formats/__tests__/formats.test.ts` (primary feature and contract coverage).
  - `src/__tests__/w15-h2-branch-coverage.test.ts` (extra branch-path coverage for AGENTS.md parser and tool adapters).
- Package test runner:
  - Vitest (`packages/core/vitest.config.ts`, Node environment, v8 coverage, coverage include on `src/**/*.ts` with test/index exclusions).
- Observability characteristics:
  - `src/formats` has no logger/event bus of its own.
  - It contributes structured diagnostic payload fields through `attachStructuredOutputErrorContext` (schema hash, preview, summary, category, provider/model metadata) that downstream runtimes emit/log.

## Risks and TODOs
- `agents-md-parser-v2.ts` uses a deliberately lightweight YAML parser:
  - Flat key/value + inline array support only.
  - Nested YAML objects, anchors, and multiline semantics are out of scope.
- `zodToJsonSchema`/`jsonSchemaToZod` are intentionally partial conversions:
  - Unsupported Zod/JSON-schema constructs degrade to broad fallbacks (`{}` / `z.unknown()`).
- Structured-output OpenAI safety stripping removes numeric/string/array constraints for request schema compatibility:
  - Correctness then depends on response-side validation (`responseSchema`) by caller paths.
- Schema conversion overlap exists with `src/mcp/mcp-tool-bridge.ts` internal converter helpers:
  - Behavior drift risk between formats adapters and MCP bridge conversion logic.
- `attachStructuredOutputErrorContext` mutates and augments `Error` instances via `Object.assign`:
  - Consumers should not assume plain `Error` shape only.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js