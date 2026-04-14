# `@dzupagent/core` Formats Architecture

## Scope

This folder defines format contracts and conversion utilities for:

1. Agent identity metadata (`AgentCardV2`)
2. Tool schema interop (Zod, JSON Schema, OpenAI function/tool, MCP descriptor subset)
3. `AGENTS.md` v2 parse/generate + backward compatibility mapping

It is a pure TypeScript utility layer (no I/O, no network calls), and is re-exported through `@dzupagent/core`.

## File Map

- `index.ts`
  - Aggregates and re-exports all public types/functions from this folder.
- `agent-card-types.ts`
  - `AgentCardV2` type model + Zod validation schema + validation helper.
- `openai-function-types.ts`
  - Type-only OpenAI function/tool contracts.
- `tool-format-adapters.ts`
  - Canonical tool schema descriptor and conversion functions.
- `agents-md-types.ts`
  - Type-only model for `AGENTS.md` v2 document structure.
- `agents-md-parser-v2.ts`
  - Parser, generator, and legacy-compat converter for `AGENTS.md` v2.
- `__tests__/formats.test.ts`
  - End-to-end unit tests for all public exports in this folder.

## Public API Surface

## 1) Agent Card v2 Validation

### Exports

- `AgentCardV2Schema`
- `validateAgentCard(data: unknown): AgentCardValidationResult`
- Types: `AgentCardV2`, `AgentCardCapability`, `AgentCardSkill`, `AgentAuthScheme`, `AgentCardAuthentication`, `AgentCardSLA`, `AgentCardProvider`, `ContentMode`

### Feature Description

- Defines an A2A-style Agent Card contract.
- Enforces required fields (`name`, `description`, `url`) and structured optional metadata.
- Normalizes validation into a safe result object (`valid`, `card`, `errors`).

### Validation Flow

1. Caller passes arbitrary `unknown` input.
2. `AgentCardV2Schema.safeParse` validates and type-checks.
3. Success path:
   - Returns `{ valid: true, card }`.
4. Failure path:
   - Converts Zod issues into readable strings (`path: message`).
   - Returns `{ valid: false, errors }`.

### Usage Example

```ts
import { validateAgentCard } from '@dzupagent/core'

const result = validateAgentCard({
  name: 'CodeAgent',
  description: 'Reviews pull requests',
  url: 'https://example.com/agent',
  defaultInputModes: ['text'],
  defaultOutputModes: ['text', 'file'],
})

if (!result.valid) {
  console.error(result.errors)
} else {
  console.log(result.card?.name)
}
```

## 2) Tool Schema Format Adapters

### Exports

- `zodToJsonSchema`
- `jsonSchemaToZod`
- `toOpenAIFunction`
- `toOpenAITool`
- `fromOpenAIFunction`
- `toMCPToolDescriptor`
- `fromMCPToolDescriptor`
- Types: `ToolSchemaDescriptor`, `MCPToolDescriptorCompat`, `OpenAIFunctionDefinition`, `OpenAIToolDefinition`

### Feature Description

- Uses `ToolSchemaDescriptor` as canonical representation for tool metadata:
  - `name`
  - `description`
  - `inputSchema`
  - optional `outputSchema`
- Provides lightweight adapters between internal tool schema and external API shapes.
- Implements a pragmatic subset conversion of Zod/JSON-Schema for common tool inputs.

### Conversion Flow

1. Schema bridge:
   - `zodToJsonSchema` converts a subset of Zod nodes into JSON Schema objects.
   - `jsonSchemaToZod` converts JSON Schema back into Zod validators.
2. OpenAI bridge:
   - `toOpenAIFunction` maps canonical descriptor to OpenAI function format.
   - `toOpenAITool` wraps function in OpenAI tool envelope (`type: 'function'`).
   - `fromOpenAIFunction` maps OpenAI function back to canonical descriptor.
3. MCP bridge:
   - `toMCPToolDescriptor` maps canonical descriptor to MCP-compatible subset.
   - `fromMCPToolDescriptor` maps MCP subset back to canonical descriptor.

### Usage Example

```ts
import { z } from 'zod'
import { zodToJsonSchema, toOpenAITool, type ToolSchemaDescriptor } from '@dzupagent/core'

const input = z.object({
  query: z.string(),
  limit: z.number().optional(),
})

const tool: ToolSchemaDescriptor = {
  name: 'search_docs',
  description: 'Searches documentation',
  inputSchema: zodToJsonSchema(input),
}

const openaiTool = toOpenAITool(tool)
```

### Notes / Boundaries

- Zod support intentionally covers common nodes (`object`, `string`, `number`, `boolean`, `array`, `enum`, `optional`).
- Unsupported/unknown nodes degrade to broad shapes (`{}` or `z.unknown()`), favoring compatibility over strict failure.

## 3) `AGENTS.md` v2 Parse/Generate/Legacy Bridge

### Exports

- `parseAgentsMdV2(content: string): AgentsMdDocument`
- `generateAgentsMd(doc: AgentsMdDocument): string`
- `toLegacyConfig(doc: AgentsMdDocument): AgentsMdConfig`
- Types: `AgentsMdDocument`, `AgentsMdMetadata`, `AgentsMdCapability`, `AgentsMdMemoryConfig`, `AgentsMdSecurityConfig`

### Feature Description

- Parses a v2 shape with:
  - YAML front matter (metadata)
  - `## Capabilities`
  - `## Memory`
  - `## Security` (allowed/blocked tools)
- Generates markdown back from structured model.
- Converts to legacy `AgentsMdConfig` for compatibility with older systems.

### Parser Flow

1. `parseFrontMatter`:
   - Detects leading `--- ... ---`.
   - Parses simple flat YAML key/value pairs and inline arrays.
2. `parseMarkdownSections`:
   - Splits content by `##` headings.
3. Section extractors:
   - Capabilities: bullet list, supports `Name: Description` and `Name — Description`.
   - Memory: `namespaces` + `maxRecords`, supports bullet-style namespace list.
   - Security: supports subsection headings (`### Allowed Tools`, `### Blocked Tools`) and legacy `!tool` deny markers.
4. Assembles `AgentsMdDocument`.

### Generator Flow

1. Writes YAML front matter from metadata.
2. Conditionally emits `Capabilities`, `Memory`, and `Security` sections.
3. Produces deterministic markdown sections for round-trip use.

### Legacy Mapping Flow

1. Initializes `AgentsMdConfig` with empty `instructions` and `rules`.
2. Maps:
   - `metadata.description` -> instruction
   - each capability -> instruction string
   - security allow/block lists -> `allowedTools` / `blockedTools`
3. Returns compatibility payload for existing v1-style consumers.

### Usage Example

```ts
import { parseAgentsMdV2, generateAgentsMd, toLegacyConfig } from '@dzupagent/core'

const doc = parseAgentsMdV2(`---
name: Reviewer
description: Reviews code
tags: [quality, lint]
---

## Capabilities
- Lint: Analyze lint issues

## Security
### Allowed Tools
- eslint
### Blocked Tools
- rm
`)

const md = generateAgentsMd(doc)
const legacy = toLegacyConfig(doc)
```

## Integration and Real Usage in Monorepo

## Re-export Boundary

- `packages/core/src/index.ts` re-exports this folder's APIs so consumers import from `@dzupagent/core`.

## Runtime References Outside `core`

- Confirmed active cross-package runtime usage:
  - `packages/agent/src/structured/structured-output-engine.ts`
    - imports `zodToJsonSchema` from `@dzupagent/core`
    - used to render JSON Schema into fallback structured-output prompt (`buildSchemaPrompt`).

## Current Non-usage (as of this analysis)

- `parseAgentsMdV2`, `generateAgentsMd`, `toLegacyConfig`:
  - currently validated by tests and exported, but no runtime call sites found outside this folder.
- `AgentCardV2Schema` / `validateAgentCard`:
  - exported and tested, but not used by server A2A route path yet.
  - server currently uses its local card model in `packages/server/src/a2a/agent-card.ts`.
- OpenAI/MCP adapter conversion helpers:
  - exported and tested; no external runtime call site in non-test packages detected.

## Relationship to Adjacent Modules

- `packages/core/src/mcp/mcp-tool-bridge.ts` includes its own internal `jsonSchemaToZod` / `zodToJsonSchema` logic for MCP-to-LangChain bridging.
- This creates partial conceptual overlap with `formats/tool-format-adapters.ts`, but they currently target different descriptor types and execution paths.

## Test Coverage

## Test Suite

- Primary file: `packages/core/src/formats/__tests__/formats.test.ts`
- Focused execution command used:
  - `yarn workspace @dzupagent/core test src/formats/__tests__/formats.test.ts`
- Result:
  - `1` test file passed
  - `41` tests passed
  - `0` failures

## Coverage Snapshot (Focused Run)

Command used:

- `yarn workspace @dzupagent/core test:coverage src/formats/__tests__/formats.test.ts`

Outcome:

- Formats files received high local coverage.
- Command exits non-zero because package-level global thresholds apply to all `src/**/*.ts`, not just formats.

Per-file coverage for `src/formats/*` from `coverage-summary.json`:

- `agent-card-types.ts`
  - statements/lines/functions/branches: `100% / 100% / 100% / 100%`
- `agents-md-parser-v2.ts`
  - statements/lines/functions/branches: `97.34% / 97.34% / 100% / 71.13%`
- `tool-format-adapters.ts`
  - statements/lines/functions/branches: `96.13% / 96.13% / 100% / 88.09%`

## Coverage Gaps (Behavioral)

- `agents-md-parser-v2.ts`
  - limited branch coverage for less-common parsing paths, such as edge subsection handling and fallback capability formatting.
- `tool-format-adapters.ts`
  - limited branch coverage for unsupported/unknown schema node fallbacks and sparse schema edge cases.

## Recommended Next Tests

1. `AGENTS.md` front matter edge cases:
   - multi-line YAML values, nested objects, and ambiguous `---` delimiters.
2. Adapter fallback behavior:
   - explicit assertions for unsupported Zod nodes and unknown JSON Schema `type`.
3. Runtime integration tests:
   - server A2A card validation with `AgentCardV2Schema`.
   - direct OpenAI/MCP adapter use in production flow tests.

## Quality Observations

1. Strong points:
   - Clear separation of type contracts and conversion utilities.
   - Extensive positive + negative tests in a single cohesive suite.
   - Backward compatibility path provided (`toLegacyConfig`) to reduce migration risk.
2. Risks / tradeoffs:
   - Lightweight YAML parser is intentionally limited; complex YAML constructs are out of scope.
   - Similar schema-conversion logic exists elsewhere (`mcp-tool-bridge`), which may drift if behavior evolves independently.

