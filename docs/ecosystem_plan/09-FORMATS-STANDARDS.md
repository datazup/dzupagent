# 09 — Formats & Standards Compliance

> **Created:** 2026-03-24
> **Status:** Planned
> **Priority:** P0-P1 (mixed by feature)
> **Estimated Effort:** 38h total
> **Depends On:** 01-Identity (for Agent Card v2 identity fields)
> **Feeds Into:** 10-Pipelines, 11-Developer Experience

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Feature Specifications](#2-feature-specifications)
   - F1: Agent Card v2
   - F2: AGENTS.md Support
   - F3: OpenAI Function Calling Compatibility
   - F4: Structured Output Standard
   - F5: Pipeline Definition Format
   - F6: Agent Snapshot Format
   - F7: Tool Schema Registry
   - F8: Message Format Standard
3. [Schema Specifications](#3-schema-specifications)
4. [Compatibility Matrix](#4-compatibility-matrix)
5. [File Structure](#5-file-structure)
6. [Testing Strategy](#6-testing-strategy)

---

## 1. Architecture Overview

### 1.1 Current State

DzipAgent has partial format support scattered across packages:

| Capability | Current State | Gap |
|-----------|--------------|-----|
| Agent Card | Basic `AgentCard` in `@dzipagent/server` (6 fields, no JSON-LD, no SLA) | Missing: JSON-LD context, output modes, SLA, full A2A compliance |
| AGENTS.md | Parser in `@dzipagent/core` (`agents-md-parser.ts`) reads instructions/tools/globs | Missing: AAIF-standard generation, capability declarations, memory/security fields |
| Tool format | `ForgeToolConfig` in `@dzipagent/agent` uses Zod + LangChain `tool()` | Missing: OpenAI function calling export/import, bidirectional conversion |
| Structured output | `generateStructured()` in `DzipAgent` uses `withStructuredOutput` | Missing: model-specific strategies, retry on mismatch, fallback chain |
| Pipeline definition | `GenPipelineBuilder` captures phase config, no serialization format | Missing: JSON-serializable format, import/export, validation, DAG semantics |
| Agent snapshot | `AgentStateSnapshot` in `@dzipagent/agent` covers messages + budget | Missing: full config, memory dump, working memory, compression, signing |
| Tool registry | `DynamicToolRegistry` in `@dzipagent/agent` manages runtime tools | Missing: schema versioning, backward compat checking, auto-docs |
| Message format | `SerializedMessage` in `@dzipagent/agent` has role/content/name/toolCallId | Missing: tool_calls array on AI messages, metadata, multimodal content, migration |

### 1.2 Standards Compliance Matrix

| Standard | Spec Version | DzipAgent Support | Target |
|----------|-------------|-------------------|--------|
| A2A Agent Card | Draft 2024-12 | Partial (basic fields) | Full compliance |
| AGENTS.md (AAIF) | v0.1 | Read-only (instructions + tools) | Read + Generate |
| OpenAI Function Calling | 2024-01 (strict mode) | None | Bidirectional |
| JSON Schema | Draft 2020-12 | Via Zod (partial) | Full via `zod-to-json-schema` |
| JSON-LD | 1.1 | None | Agent Card context |
| MCP Tool Format | 2024-11 | Via `MCPToolDescriptor` | Maintained |
| LangChain Tool Format | 0.3.x | Native (`StructuredToolInterface`) | Maintained |

### 1.3 Format Adapter Architecture

All format conversions flow through adapter functions that live in a single module per conversion direction. No adapter holds state. Every adapter is a pure function: input format in, output format out.

```
                     ForgeToolConfig (canonical)
                    /          |            \
                   /           |             \
    toLangChainTool()  toOpenAIFunction()  toMCPTool()
                  |            |              |
    StructuredTool   OpenAIFunctionDef   MCPToolDescriptor
                  \            |              /
                   \           |             /
    fromLangChainTool() fromOpenAIFunction() fromMCPTool()
                    \          |            /
                     ForgeToolConfig (canonical)
```

### 1.4 Schema Validation Pipeline

All serializable formats pass through a validation pipeline before acceptance:

```
Input (unknown) --> Structural Validation (Zod parse)
                --> Semantic Validation (custom rules)
                --> Version Migration (if older version detected)
                --> Validated Output (typed)
```

### 1.5 Package Ownership

| Feature | Owner Package | Rationale |
|---------|--------------|-----------|
| Agent Card v2 types | `@dzipagent/core` | Types used across packages |
| Agent Card v2 builder + serving | `@dzipagent/server` | HTTP serving is server concern |
| AGENTS.md parser | `@dzipagent/core` | Already there, extend in place |
| AGENTS.md generator | `@dzipagent/core` | Pairs with parser |
| Tool format adapters | `@dzipagent/core` | Cross-cutting, no I/O |
| Structured output | `@dzipagent/agent` | Agent-level execution concern |
| Pipeline definition | `@dzipagent/codegen` | Pipeline builder lives here |
| Agent snapshot | `@dzipagent/agent` | Agent state lives here |
| Tool schema registry | `@dzipagent/agent` | Extends existing `DynamicToolRegistry` |
| Message format | `@dzipagent/agent` | Extends existing `agent-state.ts` |

---

## 2. Feature Specifications

---

### F1: Agent Card v2 (P0, 4h)

**Goal:** Full A2A-compatible Agent Card with JSON-LD context, capabilities with JSON Schema I/O, authentication modes, input/output modes, skills, and SLA declarations. Served at both `/.well-known/agent.json` and `/.well-known/agent-card.json`.

**Migration:** The existing `AgentCard` and `AgentCardConfig` in `@dzipagent/server/src/a2a/agent-card.ts` are replaced. The `buildAgentCard` function signature changes: old callers get a compile error guiding them to `buildAgentCardV2`. The old type is re-exported as `AgentCardV1` for one release cycle.

#### Types (owner: `@dzipagent/core`)

```typescript
// file: packages/forgeagent-core/src/formats/agent-card-types.ts

/**
 * A2A-compliant Agent Card v2.
 *
 * JSON-LD document served at /.well-known/agent.json describing an agent's
 * capabilities, authentication requirements, and service-level guarantees.
 *
 * @see https://google.github.io/A2A/#/documentation?id=agent-card
 */
export interface AgentCardV2 {
  /** JSON-LD context for semantic interoperability */
  readonly '@context': 'https://schema.org/Agent' | string

  /** JSON-LD type */
  readonly '@type': 'Agent'

  /** Unique agent identifier (URI format preferred: forge://org/agent-name) */
  readonly id: string

  /** Human-readable agent name */
  readonly name: string

  /** What this agent does */
  readonly description: string

  /** Canonical URL where this agent is reachable */
  readonly url: string

  /** Semantic version of the agent */
  readonly version: string

  /** URL to the agent's logo/icon */
  readonly iconUrl?: string

  /** Agent provider/organization */
  readonly provider?: AgentProvider

  /** Capabilities this agent exposes */
  readonly capabilities: readonly AgentCardCapability[]

  /** Skills this agent possesses (human-readable, for discovery UI) */
  readonly skills?: readonly AgentCardSkill[]

  /** Authentication requirements */
  readonly authentication: AgentCardAuthentication

  /** Default input content types this agent accepts */
  readonly defaultInputModes: readonly ContentMode[]

  /** Default output content types this agent produces */
  readonly defaultOutputModes: readonly ContentMode[]

  /** Service-level agreement declarations */
  readonly sla?: AgentCardSLA

  /** Protocol versions this agent supports */
  readonly protocolVersions?: readonly string[]

  /** Tags for categorization and search */
  readonly tags?: readonly string[]

  /** Timestamp when this card was last updated (ISO 8601) */
  readonly updatedAt: string
}

export interface AgentProvider {
  readonly name: string
  readonly url?: string
}

export interface AgentCardCapability {
  /** Machine-readable capability identifier */
  readonly id: string

  /** Human-readable name */
  readonly name: string

  /** What this capability does */
  readonly description: string

  /** JSON Schema describing the expected input */
  readonly inputSchema: JsonSchema

  /** JSON Schema describing the output */
  readonly outputSchema?: JsonSchema

  /** HTTP method and path for invoking this capability (relative to agent URL) */
  readonly endpoint?: string

  /** Whether this capability supports streaming responses */
  readonly streaming?: boolean

  /** Estimated cost per invocation in cents (for cost-aware routing) */
  readonly estimatedCostCents?: number
}

export interface AgentCardSkill {
  readonly name: string
  readonly description: string
  /** Skill tags for matching (e.g., "code-generation", "testing") */
  readonly tags?: readonly string[]
}

/**
 * Authentication modes the agent requires.
 * Callers MUST provide credentials matching one of the supported schemes.
 */
export interface AgentCardAuthentication {
  /** Supported authentication schemes, in preference order */
  readonly schemes: readonly AgentAuthScheme[]
}

export type AgentAuthScheme =
  | { readonly type: 'none' }
  | { readonly type: 'bearer'; readonly tokenUrl?: string }
  | { readonly type: 'api-key'; readonly headerName?: string }
  | {
      readonly type: 'oauth2'
      readonly authorizationUrl: string
      readonly tokenUrl: string
      readonly scopes?: readonly string[]
    }

/**
 * Content modes for input/output declarations.
 * Values are MIME types or shorthand identifiers.
 */
export type ContentMode =
  | 'text/plain'
  | 'application/json'
  | 'text/markdown'
  | 'image/png'
  | 'image/jpeg'
  | 'audio/wav'
  | 'application/pdf'
  | (string & {})

/**
 * Service-level agreement declarations.
 * These are informational (not enforced by the protocol) but used
 * by cost-aware routers and orchestrators for planning.
 */
export interface AgentCardSLA {
  /** Maximum expected latency in milliseconds for a single request */
  readonly maxLatencyMs?: number

  /** Maximum cost in cents for a single request */
  readonly maxCostCents?: number

  /** Target availability percentage (e.g., 99.9) */
  readonly availabilityPercent?: number

  /** Maximum requests per minute this agent can handle */
  readonly rateLimitRpm?: number

  /** Maximum concurrent requests */
  readonly maxConcurrency?: number
}

/**
 * Subset of JSON Schema used in capability declarations.
 * Full JSON Schema Draft 2020-12 is accepted; this type captures
 * the most commonly used fields for IDE autocompletion.
 */
export interface JsonSchema {
  readonly type?: string | readonly string[]
  readonly properties?: Record<string, JsonSchema>
  readonly required?: readonly string[]
  readonly items?: JsonSchema
  readonly description?: string
  readonly enum?: readonly unknown[]
  readonly default?: unknown
  readonly $ref?: string
  readonly additionalProperties?: boolean | JsonSchema
  readonly oneOf?: readonly JsonSchema[]
  readonly anyOf?: readonly JsonSchema[]
  readonly allOf?: readonly JsonSchema[]
  readonly [key: string]: unknown
}
```

#### Builder (owner: `@dzipagent/server`)

```typescript
// file: packages/forgeagent-server/src/a2a/agent-card-v2.ts

import type {
  AgentCardV2,
  AgentCardCapability,
  AgentCardSkill,
  AgentAuthScheme,
  ContentMode,
  AgentCardSLA,
  AgentProvider,
} from '@dzipagent/core'

/**
 * Configuration for building an Agent Card v2.
 * Most fields have sensible defaults.
 */
export interface AgentCardV2Config {
  /** Agent identifier (will be prefixed with forge:// if not a URI) */
  id: string
  name: string
  description: string
  /** Base URL where this agent is deployed */
  baseUrl: string
  version: string
  iconUrl?: string
  provider?: AgentProvider
  /** Agents/capabilities to advertise */
  capabilities: Array<{
    id: string
    name: string
    description: string
    inputSchema?: Record<string, unknown>
    outputSchema?: Record<string, unknown>
    endpoint?: string
    streaming?: boolean
    estimatedCostCents?: number
  }>
  /** Authentication scheme(s). Defaults to [{ type: 'none' }] */
  auth?: AgentAuthScheme[]
  /** Input modes. Defaults to ['application/json'] */
  inputModes?: ContentMode[]
  /** Output modes. Defaults to ['application/json', 'text/plain'] */
  outputModes?: ContentMode[]
  /** SLA declarations */
  sla?: AgentCardSLA
  tags?: string[]
  protocolVersions?: string[]
}

/**
 * Build a fully A2A-compliant Agent Card v2 from configuration.
 *
 * @example
 * ```ts
 * const card = buildAgentCardV2({
 *   id: 'code-reviewer',
 *   name: 'Code Reviewer',
 *   description: 'Reviews code for quality and security issues',
 *   baseUrl: 'https://agents.example.com',
 *   version: '1.0.0',
 *   capabilities: [{
 *     id: 'review-pr',
 *     name: 'Review Pull Request',
 *     description: 'Analyzes a PR diff and provides feedback',
 *     inputSchema: { type: 'object', properties: { diff: { type: 'string' } }, required: ['diff'] },
 *     outputSchema: { type: 'object', properties: { score: { type: 'number' }, comments: { type: 'array' } } },
 *   }],
 *   auth: [{ type: 'bearer' }],
 *   sla: { maxLatencyMs: 30_000, maxCostCents: 10 },
 * })
 * ```
 */
export function buildAgentCardV2(config: AgentCardV2Config): AgentCardV2 {
  const id = config.id.includes('://') ? config.id : `forge://${config.id}`

  const capabilities: AgentCardCapability[] = config.capabilities.map((cap) => ({
    id: cap.id,
    name: cap.name,
    description: cap.description,
    inputSchema: (cap.inputSchema ?? { type: 'object', properties: {} }) as AgentCardCapability['inputSchema'],
    outputSchema: cap.outputSchema as AgentCardCapability['outputSchema'],
    endpoint: cap.endpoint,
    streaming: cap.streaming,
    estimatedCostCents: cap.estimatedCostCents,
  }))

  const skills: AgentCardSkill[] = config.capabilities.map((cap) => ({
    name: cap.name,
    description: cap.description,
  }))

  return {
    '@context': 'https://schema.org/Agent',
    '@type': 'Agent',
    id,
    name: config.name,
    description: config.description,
    url: config.baseUrl,
    version: config.version,
    iconUrl: config.iconUrl,
    provider: config.provider,
    capabilities,
    skills,
    authentication: {
      schemes: config.auth ?? [{ type: 'none' }],
    },
    defaultInputModes: config.inputModes ?? ['application/json'],
    defaultOutputModes: config.outputModes ?? ['application/json', 'text/plain'],
    sla: config.sla,
    protocolVersions: config.protocolVersions ?? ['a2a/1.0', 'forge/0.1'],
    tags: config.tags,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Auto-generate an Agent Card v2 from a DzipAgent instance.
 *
 * Inspects the agent's tools, config, and budget to populate
 * the card automatically.
 */
export function agentCardFromDzipAgent(
  agent: { id: string; name: string; description: string },
  options: {
    baseUrl: string
    version?: string
    auth?: AgentAuthScheme[]
    sla?: AgentCardSLA
    tools?: Array<{ name: string; description: string; schema?: Record<string, unknown> }>
  },
): AgentCardV2 {
  const capabilities = (options.tools ?? []).map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.schema,
  }))

  return buildAgentCardV2({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    baseUrl: options.baseUrl,
    version: options.version ?? '0.1.0',
    capabilities,
    auth: options.auth,
    sla: options.sla,
  })
}
```

#### Route Updates (owner: `@dzipagent/server`)

The A2A routes file adds a second endpoint for the alternate well-known path:

```typescript
// Addition to packages/forgeagent-server/src/routes/a2a.ts

// Serve at both well-known paths
app.get('/.well-known/agent.json', (c) => {
  return c.json(config.agentCard)
})
app.get('/.well-known/agent-card.json', (c) => {
  return c.json(config.agentCard)
})
```

#### Validation

```typescript
// file: packages/forgeagent-core/src/formats/agent-card-validator.ts

import type { AgentCardV2 } from './agent-card-types.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Validate an Agent Card v2 for A2A compliance.
 *
 * Checks structural requirements (required fields, correct types)
 * and semantic requirements (valid URL, non-empty capabilities, etc.).
 */
export function validateAgentCard(card: unknown): ValidationResult {
  // Implementation: Zod schema parse + custom semantic rules
  // Returns structured validation result, never throws
}
```

---

### F2: AGENTS.md Support (P1, 4h)

**Goal:** Extend the existing `agents-md-parser.ts` to handle the full AAIF standard format, and add a generator that produces AGENTS.md from DzipAgent project configuration.

**Current state:** The parser in `@dzipagent/core/src/skills/agents-md-parser.ts` reads instructions, glob-based rules, and tool allow/block lists from markdown with `##` headings. It does not handle structured YAML front matter, capability declarations, memory requirements, or security constraints as defined in the emerging AAIF standard.

#### Extended Types (owner: `@dzipagent/core`)

```typescript
// file: packages/forgeagent-core/src/formats/agents-md-types.ts

/**
 * Full AGENTS.md configuration following the AAIF standard.
 *
 * Extends the existing AgentsMdConfig with structured metadata,
 * capability declarations, and operational constraints.
 */
export interface AgentsMdDocument {
  /** YAML front matter metadata */
  metadata: AgentsMdMetadata

  /** Top-level instructions (before first heading) */
  instructions: string[]

  /** Named sections (## Heading -> content) */
  sections: AgentsMdSection[]

  /** Glob-based conditional rules (## *.test.ts -> instructions) */
  rules: Array<{ glob: string; instructions: string[] }>

  /** Tool configuration */
  tools: AgentsMdToolConfig

  /** Capability declarations */
  capabilities: AgentsMdCapability[]

  /** Memory requirements */
  memory?: AgentsMdMemoryConfig

  /** Security constraints */
  security?: AgentsMdSecurityConfig
}

export interface AgentsMdMetadata {
  /** Agent name */
  name: string
  /** Agent description */
  description: string
  /** Semantic version */
  version?: string
  /** Agent author/maintainer */
  author?: string
  /** Tags for categorization */
  tags?: string[]
  /** Model requirements (e.g., "reasoning", "codegen") */
  modelTier?: string
  /** URL to agent's API endpoint */
  url?: string
}

export interface AgentsMdSection {
  heading: string
  body: string
  /** Nesting level (## = 2, ### = 3, etc.) */
  level: number
}

export interface AgentsMdToolConfig {
  /** Tools explicitly allowed */
  allowed?: string[]
  /** Tools explicitly blocked */
  blocked?: string[]
  /** Tool-specific configuration */
  toolConfigs?: Record<string, Record<string, unknown>>
}

export interface AgentsMdCapability {
  /** Capability identifier */
  id: string
  /** Human-readable description */
  description: string
  /** Input description or schema reference */
  input?: string
  /** Output description or schema reference */
  output?: string
}

export interface AgentsMdMemoryConfig {
  /** Whether agent requires persistent memory */
  persistent: boolean
  /** Memory namespaces this agent reads */
  readNamespaces?: string[]
  /** Memory namespaces this agent writes */
  writeNamespaces?: string[]
  /** Maximum memory entries to retrieve per query */
  maxRetrievalCount?: number
}

export interface AgentsMdSecurityConfig {
  /** Whether agent can access the network */
  networkAccess: boolean
  /** Whether agent can execute system commands */
  shellAccess: boolean
  /** File system paths the agent can read */
  readPaths?: string[]
  /** File system paths the agent can write */
  writePaths?: string[]
  /** Environment variables the agent can access */
  allowedEnvVars?: string[]
  /** Maximum cost budget in cents per invocation */
  maxCostCents?: number
}
```

#### Extended Parser (owner: `@dzipagent/core`)

```typescript
// file: packages/forgeagent-core/src/formats/agents-md-parser-v2.ts

import type { AgentsMdDocument, AgentsMdMetadata } from './agents-md-types.js'

/**
 * Parse an AGENTS.md file with AAIF-standard support.
 *
 * Handles:
 * - YAML front matter between --- delimiters
 * - ## Capabilities section with structured entries
 * - ## Memory section with requirement declarations
 * - ## Security section with constraint declarations
 * - All existing features (instructions, glob rules, tool lists)
 *
 * @example
 * ```ts
 * const doc = parseAgentsMdV2(`---
 * name: code-reviewer
 * description: Reviews code for quality
 * version: 1.0.0
 * tags: [code, review, quality]
 * ---
 *
 * You are a code reviewer. Follow best practices.
 *
 * ## Capabilities
 * - id: review-pr
 *   description: Review a pull request diff
 *   input: PR diff as unified format
 *   output: Structured review with comments
 *
 * ## Tools
 * - read_file
 * - grep
 * - !execute_command
 *
 * ## Security
 * networkAccess: false
 * shellAccess: false
 * readPaths: [src/, tests/]
 * `)
 * ```
 */
export function parseAgentsMdV2(content: string): AgentsMdDocument {
  // Implementation: YAML front matter extraction, section parsing,
  // structured sub-section parsing for Capabilities/Memory/Security
}

/**
 * Backward-compatible wrapper: converts AgentsMdDocument to the
 * legacy AgentsMdConfig shape for existing consumers.
 */
export function toLegacyConfig(
  doc: AgentsMdDocument,
): import('../skills/agents-md-parser.js').AgentsMdConfig {
  // Maps new format to old { instructions, rules, allowedTools, blockedTools }
}
```

#### Generator (owner: `@dzipagent/core`)

```typescript
// file: packages/forgeagent-core/src/formats/agents-md-generator.ts

import type { AgentsMdDocument } from './agents-md-types.js'

/**
 * Generate an AGENTS.md file from structured configuration.
 *
 * Produces valid AAIF-standard markdown with YAML front matter,
 * capability declarations, tool lists, and constraint sections.
 *
 * @example
 * ```ts
 * const markdown = generateAgentsMd({
 *   metadata: { name: 'code-reviewer', description: 'Reviews code', version: '1.0.0' },
 *   instructions: ['You review code for quality and security issues.'],
 *   sections: [],
 *   rules: [{ glob: '*.test.ts', instructions: ['Focus on test coverage and assertions.'] }],
 *   tools: { allowed: ['read_file', 'grep'], blocked: ['execute_command'] },
 *   capabilities: [{ id: 'review-pr', description: 'Review a pull request' }],
 *   security: { networkAccess: false, shellAccess: false },
 * })
 * ```
 */
export function generateAgentsMd(doc: AgentsMdDocument): string {
  // Implementation: YAML front matter serialization, section rendering,
  // capability/memory/security block formatting
}

/**
 * Generate AGENTS.md from a DzipAgent's runtime configuration.
 *
 * Inspects the agent's id, description, tools, guardrails, and memory
 * config to produce a compliant AGENTS.md file.
 */
export function agentsMdFromDzipAgent(agent: {
  id: string
  name: string
  description: string
  tools?: Array<{ name: string; description: string }>
  guardrails?: { maxCostCents?: number }
  memoryNamespace?: string
}): string {
  // Maps DzipAgent config to AgentsMdDocument, then calls generateAgentsMd
}
```

---

### F3: OpenAI Function Calling Compatibility (P0, 2h)

**Goal:** Bidirectional conversion between ForgeToolConfig (Zod-based) and OpenAI function calling format. Support `strict: true` mode and parallel function calling.

#### Types (owner: `@dzipagent/core`)

```typescript
// file: packages/forgeagent-core/src/formats/openai-function-types.ts

/**
 * OpenAI function calling definition.
 * Matches the shape expected by OpenAI's chat completions API.
 *
 * @see https://platform.openai.com/docs/guides/function-calling
 */
export interface OpenAIFunctionDefinition {
  /** Function name (must match ^[a-zA-Z0-9_-]{1,64}$) */
  name: string
  /** Description shown to the model */
  description: string
  /** JSON Schema for function parameters */
  parameters: OpenAIFunctionParameters
  /**
   * When true, the model must follow the schema exactly.
   * Enables Structured Outputs mode.
   */
  strict?: boolean
}

/**
 * Parameters schema in OpenAI's expected format.
 * Always type: "object" at the top level.
 */
export interface OpenAIFunctionParameters {
  type: 'object'
  properties: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: false
}

/**
 * OpenAI tool wrapper (the `tools` array element format).
 */
export interface OpenAIToolDefinition {
  type: 'function'
  function: OpenAIFunctionDefinition
}

/**
 * A tool call as returned by OpenAI in the assistant message.
 */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON string
  }
}

/**
 * Options for parallel function calling configuration.
 */
export interface ParallelFunctionConfig {
  /** Whether to allow the model to call multiple functions in one turn */
  parallelToolCalls?: boolean
}
```

#### Adapters (owner: `@dzipagent/core`)

```typescript
// file: packages/forgeagent-core/src/formats/tool-format-adapters.ts

import type { z } from 'zod'
import type { OpenAIFunctionDefinition, OpenAIToolDefinition } from './openai-function-types.js'
import type { MCPToolDescriptor } from '../mcp/mcp-types.js'
import type { JsonSchema } from './agent-card-types.js'

/**
 * Canonical tool descriptor used as the internal pivot format.
 * All conversions go through this shape.
 *
 * NOTE: This is NOT a replacement for ForgeToolConfig (which includes
 * the execute function). This is a schema-only descriptor for
 * import/export/discovery purposes.
 */
export interface ToolSchemaDescriptor {
  /** Tool name (machine-readable identifier) */
  name: string
  /** Description shown to the model */
  description: string
  /** JSON Schema for input parameters */
  inputSchema: JsonSchema
  /** JSON Schema for output (if known) */
  outputSchema?: JsonSchema
  /** Whether strict mode is requested for this tool */
  strict?: boolean
}

// ---------- Zod <-> JSON Schema ----------

/**
 * Convert a Zod schema to JSON Schema.
 *
 * Uses zod-to-json-schema under the hood, with DzipAgent-specific
 * post-processing to ensure compatibility with OpenAI strict mode
 * (additionalProperties: false on all objects, all properties required).
 *
 * @param schema - Zod schema to convert
 * @param options - Conversion options
 * @returns JSON Schema object
 *
 * @example
 * ```ts
 * const jsonSchema = zodToJsonSchema(
 *   z.object({ city: z.string(), units: z.enum(['C', 'F']).optional() }),
 *   { strict: true }
 * )
 * // { type: 'object', properties: { city: { type: 'string' }, units: { ... } },
 * //   required: ['city', 'units'], additionalProperties: false }
 * ```
 */
export function zodToJsonSchema(
  schema: z.ZodType,
  options?: { strict?: boolean; name?: string },
): JsonSchema {
  // Implementation: use zod-to-json-schema, then apply strict mode fixups
}

/**
 * Convert a JSON Schema to a Zod schema (best-effort).
 *
 * Supports: object, string, number, integer, boolean, array, enum, oneOf.
 * Unsupported JSON Schema features produce z.unknown() with a description.
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodType {
  // Implementation: recursive schema translation
}

// ---------- OpenAI Function Format ----------

/**
 * Convert a ForgeToolConfig or ToolSchemaDescriptor to OpenAI function format.
 *
 * @example
 * ```ts
 * const fn = toOpenAIFunction({
 *   name: 'get_weather',
 *   description: 'Get current weather',
 *   inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
 *   strict: true,
 * })
 * // { name: 'get_weather', description: '...', parameters: {...}, strict: true }
 * ```
 */
export function toOpenAIFunction(tool: ToolSchemaDescriptor): OpenAIFunctionDefinition {
  // Validates name matches OpenAI regex, converts schema
}

/**
 * Wrap as OpenAI tool definition (adds { type: 'function' } wrapper).
 */
export function toOpenAITool(tool: ToolSchemaDescriptor): OpenAIToolDefinition {
  return { type: 'function', function: toOpenAIFunction(tool) }
}

/**
 * Convert an OpenAI function definition to a ToolSchemaDescriptor.
 */
export function fromOpenAIFunction(fn: OpenAIFunctionDefinition): ToolSchemaDescriptor {
  // Extracts name, description, parameters -> inputSchema
}

/**
 * Batch convert: export all tools in OpenAI format.
 */
export function toOpenAITools(tools: readonly ToolSchemaDescriptor[]): OpenAIToolDefinition[] {
  return tools.map(toOpenAITool)
}

/**
 * Batch convert: import OpenAI function definitions.
 */
export function fromOpenAIFunctions(fns: readonly OpenAIFunctionDefinition[]): ToolSchemaDescriptor[] {
  return fns.map(fromOpenAIFunction)
}

// ---------- MCP Tool Format ----------

/**
 * Convert a ToolSchemaDescriptor to MCP tool format.
 */
export function toMCPToolDescriptor(
  tool: ToolSchemaDescriptor,
  serverId: string,
): MCPToolDescriptor {
  // Maps name, description, inputSchema to MCP format
}

/**
 * Convert an MCP tool descriptor to a ToolSchemaDescriptor.
 */
export function fromMCPToolDescriptor(mcp: MCPToolDescriptor): ToolSchemaDescriptor {
  // Extracts fields, drops serverId
}

// ---------- LangChain Tool Extraction ----------

/**
 * Extract a ToolSchemaDescriptor from a LangChain StructuredToolInterface.
 *
 * Reads the tool's name, description, and Zod schema, converting
 * the schema to JSON Schema for the descriptor.
 */
export function fromLangChainTool(
  tool: import('@langchain/core/tools').StructuredToolInterface,
): ToolSchemaDescriptor {
  // Reads tool.name, tool.description, tool.schema -> zodToJsonSchema
}
```

---

### F4: Structured Output Standard (P0, 4h)

**Goal:** Model-specific structured output strategies with proper fallback chain, response validation, and retry on schema mismatch.

**Current state:** `DzipAgent.generateStructured()` uses `withStructuredOutput` when available, falling back to JSON extraction from markdown code blocks. This has gaps: no model-specific strategy selection, no retry on validation failure, no distinction between Anthropic tool_use and OpenAI response_format approaches.

#### Types (owner: `@dzipagent/agent`)

```typescript
// file: packages/forgeagent-agent/src/structured/structured-output-types.ts

import type { z } from 'zod'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'

/**
 * Strategy for obtaining structured output from an LLM.
 */
export type StructuredOutputStrategy =
  | 'anthropic_tool_use'     // Anthropic: tool_use with single tool forced
  | 'openai_json_schema'     // OpenAI: response_format.type = 'json_schema'
  | 'openai_function_call'   // OpenAI: function_call with single function forced
  | 'generic_structured'     // LangChain withStructuredOutput (model picks method)
  | 'generate_parse_validate'// Fallback: prompt for JSON, parse, validate

/**
 * Configuration for structured output generation.
 */
export interface StructuredOutputConfig<T> {
  /** Zod schema the output must conform to */
  schema: z.ZodType<T>

  /** Human-readable name for the schema (used in prompts and tool names) */
  schemaName?: string

  /** Description of what the structured output represents */
  schemaDescription?: string

  /** Force a specific strategy (auto-detected if omitted) */
  strategy?: StructuredOutputStrategy

  /**
   * Maximum retry attempts on schema validation failure.
   * Each retry sends the validation error back to the model.
   * Default: 2
   */
  maxRetries?: number

  /**
   * Whether to include the JSON Schema in the system prompt
   * as additional guidance (useful for fallback strategy).
   * Default: true for generate_parse_validate, false otherwise
   */
  includeSchemaInPrompt?: boolean

  /** Abort signal */
  signal?: AbortSignal
}

/**
 * Result of structured output generation.
 */
export interface StructuredOutputResult<T> {
  /** The validated, parsed output */
  data: T

  /** Which strategy was used */
  strategy: StructuredOutputStrategy

  /** Number of attempts (1 = first try succeeded) */
  attempts: number

  /** Token usage across all attempts */
  usage: {
    totalInputTokens: number
    totalOutputTokens: number
    llmCalls: number
  }

  /** Raw LLM response content (before parsing) */
  rawContent?: string
}

/**
 * Error thrown when structured output cannot be obtained
 * after all retries are exhausted.
 */
export interface StructuredOutputError {
  code: 'STRUCTURED_OUTPUT_FAILED'
  message: string
  /** The last validation error from Zod */
  validationErrors: z.ZodIssue[]
  /** Number of attempts made */
  attempts: number
  /** The last raw content that failed validation */
  lastRawContent: string
}
```

#### Strategy Resolver (owner: `@dzipagent/agent`)

```typescript
// file: packages/forgeagent-agent/src/structured/strategy-resolver.ts

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredOutputStrategy } from './structured-output-types.js'

/**
 * Model capability detection for structured output strategy selection.
 */
export interface ModelCapabilities {
  /** Model supports withStructuredOutput natively */
  supportsStructuredOutput: boolean
  /** Model supports OpenAI-style response_format */
  supportsResponseFormat: boolean
  /** Model supports Anthropic-style tool_use forcing */
  supportsToolUseForcing: boolean
  /** Model supports OpenAI-style function calling */
  supportsFunctionCalling: boolean
  /** Provider identifier */
  provider: 'anthropic' | 'openai' | 'openrouter' | 'unknown'
}

/**
 * Detect model capabilities by inspecting the BaseChatModel instance.
 *
 * Uses duck-typing to check for provider-specific methods and properties:
 * - ChatAnthropic: has `model` starting with "claude-"
 * - ChatOpenAI: has `model` or `modelName`, has `response_format` support
 * - Others: fall back to withStructuredOutput detection
 */
export function detectModelCapabilities(model: BaseChatModel): ModelCapabilities {
  // Implementation: duck-type inspection
}

/**
 * Select the best structured output strategy for a given model.
 *
 * Priority order:
 * 1. Anthropic tool_use (most reliable for Claude models)
 * 2. OpenAI json_schema response_format (most reliable for GPT models)
 * 3. Generic withStructuredOutput (LangChain abstraction)
 * 4. Generate + parse + validate (universal fallback)
 */
export function selectStrategy(capabilities: ModelCapabilities): StructuredOutputStrategy {
  if (capabilities.provider === 'anthropic' && capabilities.supportsToolUseForcing) {
    return 'anthropic_tool_use'
  }
  if (capabilities.provider === 'openai' && capabilities.supportsResponseFormat) {
    return 'openai_json_schema'
  }
  if (capabilities.supportsStructuredOutput) {
    return 'generic_structured'
  }
  return 'generate_parse_validate'
}
```

#### Executor (owner: `@dzipagent/agent`)

```typescript
// file: packages/forgeagent-agent/src/structured/structured-output-executor.ts

import type { z } from 'zod'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import type {
  StructuredOutputConfig,
  StructuredOutputResult,
  StructuredOutputStrategy,
} from './structured-output-types.js'

/**
 * Execute structured output generation with strategy selection,
 * validation, and retry logic.
 *
 * @example
 * ```ts
 * const result = await executeStructuredOutput(
 *   model,
 *   [new HumanMessage('Extract the address from: 123 Main St, Springfield, IL 62701')],
 *   {
 *     schema: z.object({
 *       street: z.string(),
 *       city: z.string(),
 *       state: z.string(),
 *       zip: z.string(),
 *     }),
 *     schemaName: 'Address',
 *     maxRetries: 2,
 *   },
 * )
 * // result.data = { street: '123 Main St', city: 'Springfield', state: 'IL', zip: '62701' }
 * ```
 */
export async function executeStructuredOutput<T>(
  model: BaseChatModel,
  messages: BaseMessage[],
  config: StructuredOutputConfig<T>,
): Promise<StructuredOutputResult<T>> {
  // 1. Detect model capabilities
  // 2. Select strategy (or use forced strategy from config)
  // 3. Execute with selected strategy
  // 4. Validate output against Zod schema
  // 5. On validation failure: retry with error context up to maxRetries
  // 6. On all retries exhausted: throw StructuredOutputError
}
```

The `DzipAgent.generateStructured()` method will be refactored to delegate to `executeStructuredOutput`, keeping the public API identical but gaining retry logic and model-specific strategies.

---

### F5: Pipeline Definition Format (P1, 8h)

**Goal:** JSON-serializable pipeline definitions with full DAG semantics, import/export between `GenPipelineBuilder` and the definition format, and structural validation.

**Current state:** `GenPipelineBuilder` captures an ordered list of `PipelinePhase` objects with names, types, tools, and skip conditions. These are not serializable (they contain function references and StructuredToolInterface objects).

#### Types (owner: `@dzipagent/codegen`)

```typescript
// file: packages/forgeagent-codegen/src/pipeline/pipeline-definition-types.ts

/**
 * JSON-serializable pipeline definition.
 *
 * Represents a complete DAG of processing nodes that can be:
 * - Persisted to a database
 * - Versioned and compared
 * - Shared between systems
 * - Compiled to a LangGraph StateGraph
 * - Validated for structural correctness
 *
 * @example
 * ```json
 * {
 *   "id": "feature-gen-v2",
 *   "name": "Feature Generation Pipeline",
 *   "version": "2.0.0",
 *   "nodes": [
 *     { "id": "plan", "type": "agent", "config": { "modelTier": "reasoning", "promptType": "planning" } },
 *     { "id": "gen_db", "type": "agent", "config": { "modelTier": "codegen", "promptType": "database" } },
 *     { "id": "validate", "type": "gate", "config": { "threshold": 0.7, "dimensions": ["correctness", "security"] } }
 *   ],
 *   "edges": [
 *     { "from": "plan", "to": "gen_db" },
 *     { "from": "gen_db", "to": "validate" },
 *     { "from": "validate", "to": "gen_db", "condition": { "type": "field_equals", "field": "validationResult.success", "value": false } }
 *   ]
 * }
 * ```
 */
export interface PipelineDefinition {
  /** Unique pipeline identifier */
  id: string

  /** Human-readable name */
  name: string

  /** Semantic version */
  version: string

  /** What this pipeline does */
  description?: string

  /** JSON Schema for pipeline input */
  inputSchema?: JsonSchema

  /** JSON Schema for pipeline output */
  outputSchema?: JsonSchema

  /** Processing nodes */
  nodes: PipelineNodeDefinition[]

  /** Edges connecting nodes (defines execution order and conditions) */
  edges: PipelineEdgeDefinition[]

  /** Pipeline-level metadata */
  metadata?: PipelineMetadata
}

/**
 * A single node in the pipeline DAG.
 */
export interface PipelineNodeDefinition {
  /** Unique node identifier within this pipeline */
  id: string

  /** Node type determines execution behavior */
  type: PipelineNodeType

  /** Human-readable label */
  label?: string

  /** Type-specific configuration (JSON-serializable) */
  config: PipelineNodeConfig

  /** Retry configuration for this node */
  retry?: {
    maxAttempts: number
    backoffMs?: number
  }

  /** Timeout in milliseconds */
  timeoutMs?: number
}

export type PipelineNodeType =
  | 'agent'      // Invokes a DzipAgent or sub-agent
  | 'tool'       // Invokes a single tool
  | 'transform'  // Pure data transformation (JavaScript expression or JSONata)
  | 'gate'       // Conditional gate (validation, quality check, approval)
  | 'fork'       // Splits execution into parallel branches
  | 'join'       // Waits for all/any parallel branches to complete
  | 'loop'       // Iterates until condition is met
  | 'input'      // Pipeline entry point (exactly one required)
  | 'output'     // Pipeline exit point (exactly one required)

/**
 * Node configuration varies by type.
 * All values must be JSON-serializable (no functions, no class instances).
 */
export type PipelineNodeConfig =
  | AgentNodeConfig
  | ToolNodeConfig
  | TransformNodeConfig
  | GateNodeConfig
  | ForkNodeConfig
  | JoinNodeConfig
  | LoopNodeConfig
  | InputNodeConfig
  | OutputNodeConfig

export interface AgentNodeConfig {
  nodeType: 'agent'
  /** Agent ID to invoke (resolved at runtime) */
  agentId?: string
  /** Model tier for ad-hoc agent creation */
  modelTier?: string
  /** Prompt type to use */
  promptType?: string
  /** Tool names available to this agent (resolved at runtime) */
  toolNames?: string[]
  /** Skill names to load */
  skillNames?: string[]
  /** Maximum iterations for the agent's tool loop */
  maxIterations?: number
}

export interface ToolNodeConfig {
  nodeType: 'tool'
  /** Tool name to invoke */
  toolName: string
  /** Static input overrides (merged with edge data) */
  staticInput?: Record<string, unknown>
}

export interface TransformNodeConfig {
  nodeType: 'transform'
  /**
   * Transformation expression.
   * Supported formats:
   * - JSONata expression string
   * - JSON path mapping: { "output.field": "$.input.nested.field" }
   */
  expression: string | Record<string, string>
}

export interface GateNodeConfig {
  nodeType: 'gate'
  /** Gate sub-type */
  gateType: 'validation' | 'approval' | 'quality' | 'custom'
  /** For quality gates: minimum score threshold (0-1) */
  threshold?: number
  /** For quality gates: dimensions to evaluate */
  dimensions?: string[]
  /** For approval gates: who must approve */
  approvers?: string[]
  /** For custom gates: expression that evaluates to boolean */
  condition?: string
}

export interface ForkNodeConfig {
  nodeType: 'fork'
  /** How to distribute data to branches */
  strategy: 'broadcast' | 'round-robin' | 'conditional'
}

export interface JoinNodeConfig {
  nodeType: 'join'
  /** When to proceed: all branches complete, or first one */
  strategy: 'all' | 'any' | 'quorum'
  /** For quorum: minimum number of branches that must complete */
  quorumCount?: number
  /** How to merge results from branches */
  mergeStrategy?: 'concat' | 'vote' | 'first' | 'custom'
}

export interface LoopNodeConfig {
  nodeType: 'loop'
  /** Maximum iterations before forced exit */
  maxIterations: number
  /** Field path to check for loop termination (must be truthy to exit) */
  exitConditionField?: string
  /** Expression that evaluates to boolean for exit */
  exitConditionExpr?: string
}

export interface InputNodeConfig {
  nodeType: 'input'
}

export interface OutputNodeConfig {
  nodeType: 'output'
  /** Fields to extract from state as final output */
  outputFields?: string[]
}

/**
 * An edge connecting two nodes.
 */
export interface PipelineEdgeDefinition {
  /** Source node ID */
  from: string

  /** Target node ID */
  to: string

  /** Condition for traversing this edge (if omitted, always traverse) */
  condition?: EdgeCondition

  /** Data transformation applied when traversing this edge */
  transform?: string | Record<string, string>

  /** Edge label (for documentation/visualization) */
  label?: string

  /** Priority when multiple outgoing edges from same node (lower = higher priority) */
  priority?: number
}

/**
 * Condition for edge traversal.
 */
export type EdgeCondition =
  | { type: 'field_equals'; field: string; value: unknown }
  | { type: 'field_truthy'; field: string }
  | { type: 'field_falsy'; field: string }
  | { type: 'expression'; expr: string }

/**
 * Pipeline-level metadata.
 */
export interface PipelineMetadata {
  /** Who created this pipeline */
  author?: string
  /** When this definition was created (ISO 8601) */
  createdAt?: string
  /** When this definition was last modified (ISO 8601) */
  updatedAt?: string
  /** Tags for categorization */
  tags?: string[]
  /** Estimated total cost in cents */
  estimatedCostCents?: number
  /** Estimated total duration in milliseconds */
  estimatedDurationMs?: number
}
```

#### Validation (owner: `@dzipagent/codegen`)

```typescript
// file: packages/forgeagent-codegen/src/pipeline/pipeline-validator.ts

import type { PipelineDefinition } from './pipeline-definition-types.js'

export interface PipelineValidationResult {
  valid: boolean
  errors: PipelineValidationError[]
  warnings: PipelineValidationWarning[]
}

export interface PipelineValidationError {
  code: string
  message: string
  nodeId?: string
  edgeIndex?: number
}

export interface PipelineValidationWarning {
  code: string
  message: string
  nodeId?: string
}

/**
 * Validate a pipeline definition for structural and semantic correctness.
 *
 * Checks performed:
 * - Exactly one 'input' node and at least one 'output' node
 * - All edge references point to existing nodes
 * - No cycles in unconditional edges (conditional cycles allowed for loops)
 * - All nodes are reachable from the input node
 * - All paths from input reach an output node
 * - Fork nodes have matching join nodes
 * - Node configs match their declared type
 * - No duplicate node IDs
 */
export function validatePipelineDefinition(
  definition: PipelineDefinition,
): PipelineValidationResult {
  // Implementation: graph traversal, topological sort attempt,
  // reachability analysis, type-specific config validation
}
```

#### Import/Export (owner: `@dzipagent/codegen`)

```typescript
// file: packages/forgeagent-codegen/src/pipeline/pipeline-serializer.ts

import type { PipelineDefinition } from './pipeline-definition-types.js'
import type { GenPipelineBuilder } from './gen-pipeline-builder.js'

/**
 * Export a GenPipelineBuilder's configuration to a PipelineDefinition.
 *
 * Note: Skip conditions (functions) are NOT exported. They must be
 * reconstructed from the pipeline definition's edge conditions at import time.
 * Tool references are exported as tool names (string), not tool instances.
 *
 * @param builder - The pipeline builder to export
 * @param meta - Pipeline metadata (id, name, version)
 */
export function exportPipelineDefinition(
  builder: GenPipelineBuilder,
  meta: { id: string; name: string; version: string; description?: string },
): PipelineDefinition {
  // Converts PipelinePhase[] to PipelineNodeDefinition[] + PipelineEdgeDefinition[]
  // Generation phases -> agent nodes
  // Validation phases -> gate nodes
  // Fix phases -> loop nodes with conditional back-edges
  // Review phases -> gate nodes (gateType: 'approval')
}

/**
 * Import a PipelineDefinition into a GenPipelineBuilder.
 *
 * Reconstructs the builder phases from the definition's nodes and edges.
 * Only agent, gate (validation/approval), and loop (fix) nodes are imported;
 * transform/fork/join nodes are ignored with a warning.
 *
 * @returns The builder and any import warnings
 */
export function importPipelineDefinition(
  definition: PipelineDefinition,
): { builder: GenPipelineBuilder; warnings: string[] } {
  // Reverse mapping: nodes + edges -> PipelinePhase[]
}
```

---

### F6: Agent Snapshot Format (P1, 8h)

**Goal:** Full agent state export including config, memory, working memory, conversation, and budget state. Support import, diff, and integrity signing.

**Current state:** `AgentStateSnapshot` in `@dzipagent/agent/src/agent/agent-state.ts` captures messages, conversation summary, and budget state. It does not include the agent's configuration, memory contents, working memory, or any integrity mechanism.

#### Types (owner: `@dzipagent/agent`)

```typescript
// file: packages/forgeagent-agent/src/snapshot/snapshot-types.ts

/**
 * Complete agent snapshot for export/import.
 *
 * Contains everything needed to reconstruct an agent's state
 * at a point in time — configuration, memory, conversation, and budget.
 */
export interface DzipAgentSnapshot {
  /** Snapshot format version (for migration) */
  formatVersion: '1.0.0'

  /** When this snapshot was created (ISO 8601) */
  createdAt: string

  /** Agent configuration (JSON-serializable subset) */
  agentConfig: SnapshotAgentConfig

  /** Serialized conversation messages */
  messages: SerializedMessageV2[]

  /** Conversation summary (if auto-compress has run) */
  conversationSummary: string | null

  /** Budget/usage state at snapshot time */
  budgetState: SnapshotBudgetState

  /** Memory dump — selected memory entries relevant to this agent */
  memory: SnapshotMemoryDump

  /** Working memory state */
  workingMemory: SnapshotWorkingMemory

  /** Agent run metadata */
  runMetadata: SnapshotRunMetadata

  /**
   * HMAC-SHA256 signature over the snapshot content.
   * Computed over JSON.stringify of all fields except 'signature'.
   * Null if signing was not requested.
   */
  signature: string | null
}

/**
 * JSON-serializable agent configuration.
 * Excludes non-serializable fields (model instance, tool functions, middleware).
 */
export interface SnapshotAgentConfig {
  id: string
  name: string
  description: string
  instructions: string
  /** Model identifier (tier or provider/model string, not the instance) */
  modelId: string
  /** Tool names available to this agent */
  toolNames: string[]
  /** Guardrail configuration */
  guardrails?: {
    maxIterations?: number
    maxTokens?: number
    maxCostCents?: number
    blockedTools?: string[]
  }
  /** Memory namespace and scope */
  memoryNamespace?: string
  memoryScope?: Record<string, string>
  /** Message compression config */
  messageConfig?: {
    maxTokens?: number
    summaryThreshold?: number
  }
}

/**
 * Enhanced serialized message format.
 * Extends the existing SerializedMessage with tool_calls and metadata.
 */
export interface SerializedMessageV2 {
  role: 'system' | 'human' | 'ai' | 'tool'
  content: string | SerializedContentBlock[]
  name?: string
  toolCallId?: string
  /** Tool calls made by an AI message */
  toolCalls?: SerializedToolCall[]
  /** Arbitrary metadata attached to the message */
  metadata?: Record<string, unknown>
  /** Timestamp when this message was created */
  timestamp?: string
}

export interface SerializedContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  /** Base64-encoded image data */
  imageData?: string
  imageMimeType?: string
  toolCallId?: string
  toolName?: string
}

export interface SerializedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface SnapshotBudgetState {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostCents: number
  llmCalls: number
  iterations: number
  toolCallCount: number
}

export interface SnapshotMemoryDump {
  /** Memory entries keyed by namespace */
  entries: Record<string, SnapshotMemoryEntry[]>
  /** Total entry count across all namespaces */
  totalEntries: number
  /** Whether the dump was truncated due to size limits */
  truncated: boolean
}

export interface SnapshotMemoryEntry {
  key: string
  value: Record<string, unknown>
  namespace: string
  /** When this entry was last updated (ISO 8601) */
  updatedAt?: string
  /** Decay score at snapshot time */
  decayScore?: number
}

export interface SnapshotWorkingMemory {
  /** Current working memory entries */
  entries: Record<string, unknown>
  /** Active context keys */
  activeContextKeys: string[]
}

export interface SnapshotRunMetadata {
  /** Run ID (if this snapshot is from a tracked run) */
  runId?: string
  /** Session ID */
  sessionId?: string
  /** Parent agent ID (if this is a sub-agent) */
  parentAgentId?: string
  /** Pipeline phase (if running in a pipeline) */
  pipelinePhase?: string
  /** Custom metadata */
  custom?: Record<string, unknown>
}
```

#### Operations (owner: `@dzipagent/agent`)

```typescript
// file: packages/forgeagent-agent/src/snapshot/snapshot-operations.ts

import type { DzipAgentSnapshot } from './snapshot-types.js'

export interface CreateSnapshotOptions {
  /** Whether to include memory entries (can be large) */
  includeMemory?: boolean
  /** Maximum memory entries per namespace */
  maxMemoryEntries?: number
  /** Whether to sign the snapshot with HMAC-SHA256 */
  sign?: boolean
  /** HMAC key for signing (required if sign: true) */
  hmacKey?: string
  /** Whether to compress the snapshot with gzip */
  compress?: boolean
}

export interface SnapshotExportResult {
  /** The snapshot data */
  snapshot: DzipAgentSnapshot
  /** Compressed bytes (if compress: true was set) */
  compressedBytes?: Uint8Array
  /** Size in bytes (uncompressed JSON) */
  sizeBytes: number
}

/**
 * Create a snapshot from a DzipAgent instance.
 *
 * @example
 * ```ts
 * const result = await createSnapshot(agent, messages, {
 *   includeMemory: true,
 *   maxMemoryEntries: 100,
 *   sign: true,
 *   hmacKey: process.env.SNAPSHOT_HMAC_KEY,
 * })
 * await fs.writeFile('snapshot.json', JSON.stringify(result.snapshot, null, 2))
 * ```
 */
export async function createSnapshot(
  agent: import('../agent/dzip-agent.js').DzipAgent,
  messages: import('@langchain/core/messages').BaseMessage[],
  options?: CreateSnapshotOptions,
): Promise<SnapshotExportResult> {
  // Implementation: extract config, serialize messages, dump memory,
  // compute signature, optionally compress
}

/**
 * Verify a snapshot's HMAC-SHA256 signature.
 *
 * @returns true if the signature is valid, false if tampered
 * @throws if the snapshot has no signature
 */
export function verifySnapshot(snapshot: DzipAgentSnapshot, hmacKey: string): boolean {
  // Implementation: recompute HMAC over all fields except 'signature',
  // compare with snapshot.signature using timing-safe equality
}

/**
 * Compute a diff between two snapshots.
 *
 * Returns a structured description of what changed:
 * - Messages added/removed
 * - Memory entries changed
 * - Budget state changes
 * - Config changes
 */
export function diffSnapshots(
  older: DzipAgentSnapshot,
  newer: DzipAgentSnapshot,
): SnapshotDiff {
  // Implementation: field-by-field comparison
}

export interface SnapshotDiff {
  /** Whether the snapshots are from the same agent */
  sameAgent: boolean
  /** Time elapsed between snapshots */
  elapsedMs: number
  /** Messages added since older snapshot */
  messagesAdded: number
  /** Messages removed (e.g., due to eviction) */
  messagesRemoved: number
  /** Memory entries added/modified/removed per namespace */
  memoryChanges: Record<string, { added: number; modified: number; removed: number }>
  /** Budget consumption between snapshots */
  budgetDelta: {
    inputTokens: number
    outputTokens: number
    costCents: number
    llmCalls: number
    iterations: number
  }
  /** Config fields that differ */
  configChanges: string[]
}

/**
 * Restore agent state from a snapshot.
 *
 * Returns deserialized messages and the configuration needed to
 * reconstruct the agent. Does NOT create the agent (the caller
 * must create a DzipAgent with the returned config and inject messages).
 *
 * @example
 * ```ts
 * const { messages, config, conversationSummary } = restoreFromSnapshot(snapshot)
 * const agent = new DzipAgent({ ...config, model: registry.getModel(config.modelId) })
 * const result = await agent.generate(messages)
 * ```
 */
export function restoreFromSnapshot(snapshot: DzipAgentSnapshot): {
  messages: import('@langchain/core/messages').BaseMessage[]
  config: import('./snapshot-types.js').SnapshotAgentConfig
  conversationSummary: string | null
  budgetState: import('./snapshot-types.js').SnapshotBudgetState
  workingMemory: import('./snapshot-types.js').SnapshotWorkingMemory
} {
  // Implementation: deserialize messages, return config subset
}
```

#### Migration (owner: `@dzipagent/agent`)

The existing `AgentStateSnapshot` in `agent-state.ts` is preserved as an alias. The `serializeMessages` and `deserializeMessages` functions are extended to handle `SerializedMessageV2` while remaining backward-compatible with `SerializedMessage`:

```typescript
/**
 * Detect snapshot format version and migrate if needed.
 */
export function migrateSnapshot(raw: unknown): DzipAgentSnapshot {
  // If raw has no 'formatVersion' field, treat as legacy AgentStateSnapshot
  // and wrap into DzipAgentSnapshot with default values for new fields.
}
```

---

### F7: Tool Schema Registry (P2, 4h)

**Goal:** Central registry for tool schemas with versioning, backward compatibility checking, and auto-documentation generation.

**Current state:** `DynamicToolRegistry` in `@dzipagent/agent/src/agent/tool-registry.ts` manages runtime tool registration/deregistration with event emission. It does not version schemas or check compatibility.

#### Types (owner: `@dzipagent/agent`)

```typescript
// file: packages/forgeagent-agent/src/tools/tool-schema-registry-types.ts

import type { JsonSchema } from '@dzipagent/core'
import type { ToolSchemaDescriptor } from '@dzipagent/core'

/**
 * A versioned tool schema entry in the registry.
 */
export interface ToolSchemaEntry {
  /** Tool name */
  name: string
  /** Current schema version (semver) */
  version: string
  /** Schema descriptor */
  schema: ToolSchemaDescriptor
  /** When this version was registered (ISO 8601) */
  registeredAt: string
  /** Whether this tool is deprecated */
  deprecated: boolean
  /** Deprecation message and replacement tool name */
  deprecation?: {
    message: string
    replacedBy?: string
    removeAfter?: string
  }
  /** Previous schema versions (for compatibility checking) */
  previousVersions?: ToolSchemaVersion[]
}

export interface ToolSchemaVersion {
  version: string
  schema: ToolSchemaDescriptor
  registeredAt: string
}

/**
 * Result of a backward compatibility check.
 */
export interface CompatibilityResult {
  compatible: boolean
  /** Breaking changes found */
  breaking: CompatibilityIssue[]
  /** Non-breaking changes (additions, description changes) */
  nonBreaking: CompatibilityIssue[]
}

export interface CompatibilityIssue {
  type:
    | 'required_field_added'       // Breaking: new required input field
    | 'field_removed'              // Breaking: existing field removed
    | 'type_changed'               // Breaking: field type changed
    | 'enum_value_removed'         // Breaking: enum value removed
    | 'optional_field_added'       // Non-breaking: new optional field
    | 'description_changed'        // Non-breaking
    | 'enum_value_added'           // Non-breaking
    | 'field_made_optional'        // Non-breaking (relaxation)
  field: string
  message: string
  oldValue?: unknown
  newValue?: unknown
}
```

#### Registry (owner: `@dzipagent/agent`)

```typescript
// file: packages/forgeagent-agent/src/tools/tool-schema-registry.ts

import type {
  ToolSchemaEntry,
  CompatibilityResult,
} from './tool-schema-registry-types.js'
import type { ToolSchemaDescriptor } from '@dzipagent/core'

/**
 * Central registry for tool schemas with versioning and compatibility checking.
 *
 * @example
 * ```ts
 * const registry = new ToolSchemaRegistry()
 *
 * // Register a tool schema
 * registry.register({
 *   name: 'write_file',
 *   version: '1.0.0',
 *   schema: { name: 'write_file', description: '...', inputSchema: {...} },
 * })
 *
 * // Check compatibility before updating
 * const compat = registry.checkCompatibility('write_file', newSchema)
 * if (compat.breaking.length > 0) {
 *   console.warn('Breaking changes detected:', compat.breaking)
 * }
 *
 * // Generate documentation
 * const docs = registry.generateDocs('markdown')
 * ```
 */
export class ToolSchemaRegistry {
  /**
   * Register a tool schema. If the tool already exists, the previous
   * version is archived and a compatibility check is logged.
   */
  register(entry: {
    name: string
    version: string
    schema: ToolSchemaDescriptor
    deprecated?: boolean
    deprecation?: { message: string; replacedBy?: string }
  }): CompatibilityResult | null {
    // Returns compatibility result if updating, null if new registration
  }

  /** Get the current schema for a tool */
  get(name: string): ToolSchemaEntry | undefined {}

  /** Get a specific version of a tool schema */
  getVersion(name: string, version: string): ToolSchemaDescriptor | undefined {}

  /** List all registered tools */
  list(): ToolSchemaEntry[] {}

  /** List all deprecated tools */
  listDeprecated(): ToolSchemaEntry[] {}

  /**
   * Check backward compatibility between the current registered schema
   * and a proposed new schema.
   */
  checkCompatibility(
    toolName: string,
    newSchema: ToolSchemaDescriptor,
  ): CompatibilityResult {}

  /**
   * Generate documentation for all registered tools.
   *
   * @param format - Output format
   * @returns Documentation string
   */
  generateDocs(format: 'markdown' | 'json' | 'openapi'): string {}

  /** Remove a tool from the registry */
  unregister(name: string): boolean {}

  /** Export registry state for persistence */
  export(): ToolSchemaEntry[] {}

  /** Import registry state from persistence */
  import(entries: ToolSchemaEntry[]): void {}
}
```

---

### F8: Message Format Standard (P1, 4h)

**Goal:** Enhanced message serialization that preserves tool calls, multimodal content, and metadata with round-trip fidelity. Migration support for format changes.

**Current state:** `SerializedMessage` in `agent-state.ts` has `role`, `content` (string only), `name`, and `toolCallId`. It loses tool_calls arrays on AI messages, multimodal content blocks, and all metadata.

#### Types (owner: `@dzipagent/agent`)

The `SerializedMessageV2` type is already defined in F6 (snapshot-types.ts). This feature focuses on the serialization/deserialization logic and migration.

```typescript
// file: packages/forgeagent-agent/src/messages/message-serializer.ts

import type { BaseMessage } from '@langchain/core/messages'
import type { SerializedMessageV2, SerializedToolCall, SerializedContentBlock } from '../snapshot/snapshot-types.js'

/**
 * Message format version.
 * v1: Original SerializedMessage (role, content string, name, toolCallId)
 * v2: SerializedMessageV2 (adds toolCalls, multimodal content, metadata, timestamp)
 */
export type MessageFormatVersion = 'v1' | 'v2'

export interface SerializeOptions {
  /** Format version to produce (default: 'v2') */
  version?: MessageFormatVersion
  /** Whether to include metadata (default: true) */
  includeMetadata?: boolean
  /** Whether to include timestamps (default: true) */
  includeTimestamps?: boolean
  /**
   * Whether to use compact format (omits undefined/null fields).
   * Reduces storage size by ~20-30%.
   * Default: false
   */
  compact?: boolean
}

/**
 * Serialize LangChain BaseMessage[] to the v2 format.
 *
 * Preserves:
 * - All four role types (system, human, ai, tool)
 * - String and array content (multimodal)
 * - Tool calls on AI messages (id, name, args)
 * - Tool call IDs on tool messages
 * - Message name fields
 * - Arbitrary metadata from additional_kwargs
 *
 * @example
 * ```ts
 * const serialized = serializeMessagesV2(messages, { compact: true })
 * const json = JSON.stringify(serialized)
 * // Later:
 * const restored = deserializeMessagesV2(JSON.parse(json))
 * ```
 */
export function serializeMessagesV2(
  messages: BaseMessage[],
  options?: SerializeOptions,
): SerializedMessageV2[] {
  // Implementation: extracts all fields including tool_calls,
  // handles MessageContentComplex arrays for multimodal
}

/**
 * Deserialize v2 messages back to LangChain BaseMessage[].
 *
 * Reconstructs:
 * - Correct message class instances (SystemMessage, HumanMessage, AIMessage, ToolMessage)
 * - tool_calls property on AIMessage
 * - Array content for multimodal messages
 * - additional_kwargs from metadata
 */
export function deserializeMessagesV2(
  serialized: SerializedMessageV2[],
): BaseMessage[] {
  // Implementation: type-dispatched reconstruction
}

/**
 * Detect the format version of serialized messages.
 */
export function detectMessageVersion(
  messages: Array<Record<string, unknown>>,
): MessageFormatVersion {
  // v2 has 'toolCalls' or 'metadata' fields; v1 does not
}

/**
 * Migrate messages from v1 to v2 format.
 *
 * Preserves all v1 data; new v2 fields are set to undefined/empty.
 */
export function migrateMessagesV1toV2(
  v1Messages: Array<{ role: string; content: string; name?: string; toolCallId?: string }>,
): SerializedMessageV2[] {
  // Maps old format to new, adding toolCalls: undefined, metadata: undefined
}

/**
 * Compute storage size metrics for a message array.
 */
export function messageStorageMetrics(messages: SerializedMessageV2[]): {
  /** Total serialized JSON size in bytes */
  totalBytes: number
  /** Average bytes per message */
  avgBytesPerMessage: number
  /** Number of messages with multimodal content */
  multimodalCount: number
  /** Number of messages with tool calls */
  toolCallCount: number
} {
  // Quick size estimation without full serialization
}
```

#### Backward Compatibility

The existing `serializeMessages` and `deserializeMessages` functions in `agent-state.ts` are NOT removed. They continue to work as-is for consumers who do not need v2 features. The v2 functions are exported alongside them from `@dzipagent/agent/index.ts`:

```typescript
// Addition to packages/forgeagent-agent/src/index.ts
export {
  serializeMessagesV2,
  deserializeMessagesV2,
  migrateMessagesV1toV2,
  detectMessageVersion,
  messageStorageMetrics,
} from './messages/message-serializer.js'
export type { SerializeOptions, MessageFormatVersion } from './messages/message-serializer.js'
```

---

## 3. Schema Specifications

### 3.1 Agent Card v2 JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forgeagent.dev/schemas/agent-card-v2.json",
  "title": "DzipAgent Agent Card v2",
  "description": "A2A-compatible agent discovery document",
  "type": "object",
  "required": ["@context", "@type", "id", "name", "description", "url", "version", "capabilities", "authentication", "defaultInputModes", "defaultOutputModes", "updatedAt"],
  "properties": {
    "@context": {
      "type": "string",
      "const": "https://schema.org/Agent"
    },
    "@type": {
      "type": "string",
      "const": "Agent"
    },
    "id": {
      "type": "string",
      "description": "Unique agent identifier (URI format)"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "description": {
      "type": "string",
      "maxLength": 2048
    },
    "url": {
      "type": "string",
      "format": "uri"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$"
    },
    "iconUrl": {
      "type": "string",
      "format": "uri"
    },
    "provider": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "url": { "type": "string", "format": "uri" }
      },
      "required": ["name"]
    },
    "capabilities": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "name", "description", "inputSchema"],
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "description": { "type": "string" },
          "inputSchema": { "type": "object" },
          "outputSchema": { "type": "object" },
          "endpoint": { "type": "string" },
          "streaming": { "type": "boolean" },
          "estimatedCostCents": { "type": "number", "minimum": 0 }
        }
      }
    },
    "skills": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "description"],
        "properties": {
          "name": { "type": "string" },
          "description": { "type": "string" },
          "tags": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "authentication": {
      "type": "object",
      "required": ["schemes"],
      "properties": {
        "schemes": {
          "type": "array",
          "minItems": 1,
          "items": {
            "oneOf": [
              { "type": "object", "properties": { "type": { "const": "none" } }, "required": ["type"] },
              { "type": "object", "properties": { "type": { "const": "bearer" }, "tokenUrl": { "type": "string" } }, "required": ["type"] },
              { "type": "object", "properties": { "type": { "const": "api-key" }, "headerName": { "type": "string" } }, "required": ["type"] },
              { "type": "object", "properties": { "type": { "const": "oauth2" }, "authorizationUrl": { "type": "string" }, "tokenUrl": { "type": "string" }, "scopes": { "type": "array", "items": { "type": "string" } } }, "required": ["type", "authorizationUrl", "tokenUrl"] }
            ]
          }
        }
      }
    },
    "defaultInputModes": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string" }
    },
    "defaultOutputModes": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string" }
    },
    "sla": {
      "type": "object",
      "properties": {
        "maxLatencyMs": { "type": "integer", "minimum": 0 },
        "maxCostCents": { "type": "number", "minimum": 0 },
        "availabilityPercent": { "type": "number", "minimum": 0, "maximum": 100 },
        "rateLimitRpm": { "type": "integer", "minimum": 0 },
        "maxConcurrency": { "type": "integer", "minimum": 1 }
      }
    },
    "protocolVersions": {
      "type": "array",
      "items": { "type": "string" }
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" }
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time"
    }
  },
  "additionalProperties": false
}
```

### 3.2 AGENTS.md YAML Front Matter Schema

```yaml
# YAML Schema for AGENTS.md front matter validation
# The body is free-form markdown; only the front matter is validated.

type: object
required: [name, description]
properties:
  name:
    type: string
    minLength: 1
    maxLength: 128
  description:
    type: string
    maxLength: 2048
  version:
    type: string
    pattern: '^\d+\.\d+\.\d+$'
  author:
    type: string
  tags:
    type: array
    items:
      type: string
  modelTier:
    type: string
    enum: [chat, reasoning, codegen, embedding]
  url:
    type: string
    format: uri
additionalProperties: false
```

### 3.3 Pipeline Definition JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forgeagent.dev/schemas/pipeline-definition-v1.json",
  "title": "DzipAgent Pipeline Definition",
  "type": "object",
  "required": ["id", "name", "version", "nodes", "edges"],
  "properties": {
    "id": { "type": "string" },
    "name": { "type": "string" },
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "description": { "type": "string" },
    "inputSchema": { "type": "object" },
    "outputSchema": { "type": "object" },
    "nodes": {
      "type": "array",
      "minItems": 2,
      "items": {
        "type": "object",
        "required": ["id", "type", "config"],
        "properties": {
          "id": { "type": "string", "pattern": "^[a-zA-Z0-9_-]+$" },
          "type": { "enum": ["agent", "tool", "transform", "gate", "fork", "join", "loop", "input", "output"] },
          "label": { "type": "string" },
          "config": { "type": "object" },
          "retry": {
            "type": "object",
            "properties": {
              "maxAttempts": { "type": "integer", "minimum": 1 },
              "backoffMs": { "type": "integer", "minimum": 0 }
            }
          },
          "timeoutMs": { "type": "integer", "minimum": 0 }
        }
      }
    },
    "edges": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["from", "to"],
        "properties": {
          "from": { "type": "string" },
          "to": { "type": "string" },
          "condition": {
            "oneOf": [
              { "type": "object", "required": ["type", "field", "value"], "properties": { "type": { "const": "field_equals" }, "field": { "type": "string" }, "value": {} } },
              { "type": "object", "required": ["type", "field"], "properties": { "type": { "const": "field_truthy" }, "field": { "type": "string" } } },
              { "type": "object", "required": ["type", "field"], "properties": { "type": { "const": "field_falsy" }, "field": { "type": "string" } } },
              { "type": "object", "required": ["type", "expr"], "properties": { "type": { "const": "expression" }, "expr": { "type": "string" } } }
            ]
          },
          "transform": {},
          "label": { "type": "string" },
          "priority": { "type": "integer" }
        }
      }
    },
    "metadata": {
      "type": "object",
      "properties": {
        "author": { "type": "string" },
        "createdAt": { "type": "string", "format": "date-time" },
        "updatedAt": { "type": "string", "format": "date-time" },
        "tags": { "type": "array", "items": { "type": "string" } },
        "estimatedCostCents": { "type": "number" },
        "estimatedDurationMs": { "type": "integer" }
      }
    }
  },
  "additionalProperties": false
}
```

### 3.4 Agent Snapshot JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forgeagent.dev/schemas/agent-snapshot-v1.json",
  "title": "DzipAgent Snapshot",
  "type": "object",
  "required": ["formatVersion", "createdAt", "agentConfig", "messages", "budgetState", "memory", "workingMemory", "runMetadata", "signature"],
  "properties": {
    "formatVersion": { "type": "string", "const": "1.0.0" },
    "createdAt": { "type": "string", "format": "date-time" },
    "agentConfig": {
      "type": "object",
      "required": ["id", "name", "description", "instructions", "modelId", "toolNames"],
      "properties": {
        "id": { "type": "string" },
        "name": { "type": "string" },
        "description": { "type": "string" },
        "instructions": { "type": "string" },
        "modelId": { "type": "string" },
        "toolNames": { "type": "array", "items": { "type": "string" } },
        "guardrails": { "type": "object" },
        "memoryNamespace": { "type": "string" },
        "memoryScope": { "type": "object" },
        "messageConfig": { "type": "object" }
      }
    },
    "messages": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["role", "content"],
        "properties": {
          "role": { "enum": ["system", "human", "ai", "tool"] },
          "content": {},
          "name": { "type": "string" },
          "toolCallId": { "type": "string" },
          "toolCalls": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["id", "name", "args"],
              "properties": {
                "id": { "type": "string" },
                "name": { "type": "string" },
                "args": { "type": "object" }
              }
            }
          },
          "metadata": { "type": "object" },
          "timestamp": { "type": "string", "format": "date-time" }
        }
      }
    },
    "conversationSummary": { "type": ["string", "null"] },
    "budgetState": {
      "type": "object",
      "required": ["totalInputTokens", "totalOutputTokens", "totalCostCents", "llmCalls", "iterations", "toolCallCount"],
      "properties": {
        "totalInputTokens": { "type": "integer" },
        "totalOutputTokens": { "type": "integer" },
        "totalCostCents": { "type": "number" },
        "llmCalls": { "type": "integer" },
        "iterations": { "type": "integer" },
        "toolCallCount": { "type": "integer" }
      }
    },
    "memory": {
      "type": "object",
      "required": ["entries", "totalEntries", "truncated"],
      "properties": {
        "entries": { "type": "object" },
        "totalEntries": { "type": "integer" },
        "truncated": { "type": "boolean" }
      }
    },
    "workingMemory": {
      "type": "object",
      "required": ["entries", "activeContextKeys"],
      "properties": {
        "entries": { "type": "object" },
        "activeContextKeys": { "type": "array", "items": { "type": "string" } }
      }
    },
    "runMetadata": {
      "type": "object",
      "properties": {
        "runId": { "type": "string" },
        "sessionId": { "type": "string" },
        "parentAgentId": { "type": "string" },
        "pipelinePhase": { "type": "string" },
        "custom": { "type": "object" }
      }
    },
    "signature": { "type": ["string", "null"] }
  },
  "additionalProperties": false
}
```

---

## 4. Compatibility Matrix

### 4.1 Structured Output by Model Provider

| Provider | Model Family | `withStructuredOutput` | `response_format` (json_schema) | Tool Use Forcing | Recommended Strategy |
|----------|-------------|----------------------|-------------------------------|-----------------|---------------------|
| Anthropic | Claude 3.5+ | Yes | No | Yes (tool_choice: any) | `anthropic_tool_use` |
| Anthropic | Claude 3 Haiku | Yes | No | Yes | `anthropic_tool_use` |
| OpenAI | GPT-4o | Yes | Yes (strict) | Yes | `openai_json_schema` |
| OpenAI | GPT-4 Turbo | Yes | No | Yes | `openai_function_call` |
| OpenAI | GPT-3.5 Turbo | Partial | No | Yes | `openai_function_call` |
| OpenRouter | Various | Depends on model | Depends on model | Depends on model | `generic_structured` |
| Google | Gemini 1.5+ | Yes | Yes | Yes | `generic_structured` |
| Local | Ollama | Partial | No | No | `generate_parse_validate` |

### 4.2 Tool Format by Framework

| Framework | Native Format | DzipAgent Adapter | Status |
|-----------|-------------|-------------------|--------|
| LangChain/LangGraph | `StructuredToolInterface` (Zod) | Native (no conversion) | Supported |
| OpenAI API | `tools[].function` (JSON Schema) | `toOpenAIFunction` / `fromOpenAIFunction` | Planned (F3) |
| Anthropic API | `tools[]` (JSON Schema) | Via LangChain ChatAnthropic | Supported |
| MCP | `Tool` (JSON Schema inputSchema) | `toMCPToolDescriptor` / `fromMCPToolDescriptor` | Planned (F3) |
| Mastra | `createTool` (Zod) | Same pattern as ForgeToolConfig | Compatible |
| Vercel AI SDK | `tool()` (Zod) | Schema-level compatible | Compatible |
| AutoGen | Python dict format | Not planned (Python ecosystem) | N/A |

### 4.3 Agent Card Protocol Versions

| Protocol | Version | DzipAgent Support | Notes |
|----------|---------|-------------------|-------|
| A2A Agent Card | Draft 2024-12 | Current: partial, Target: full | F1 deliverable |
| AGENTS.md (AAIF) | v0.1 | Current: read-only, Target: read+write | F2 deliverable |
| Agent File (.af) | Letta v0.1 | Not planned | Low adoption, niche use case |
| OpenAPI | 3.1 | Partial (tool docs generation) | F7 deliverable (auto-docs) |

---

## 5. File Structure

### 5.1 Changes to `@dzipagent/core`

```
packages/forgeagent-core/src/
  formats/                          # NEW directory
    agent-card-types.ts             # F1: AgentCardV2, JsonSchema, auth types
    agent-card-validator.ts         # F1: validateAgentCard()
    agents-md-types.ts              # F2: AgentsMdDocument, full AAIF types
    agents-md-parser-v2.ts          # F2: parseAgentsMdV2(), toLegacyConfig()
    agents-md-generator.ts          # F2: generateAgentsMd(), agentsMdFromDzipAgent()
    openai-function-types.ts        # F3: OpenAI function/tool type definitions
    tool-format-adapters.ts         # F3: zodToJsonSchema, toOpenAIFunction, fromMCPTool, etc.
    index.ts                        # Barrel export
```

New exports added to `packages/forgeagent-core/src/index.ts`:

```typescript
// --- Formats & Standards ---
export type {
  AgentCardV2, AgentCardCapability, AgentCardSkill,
  AgentCardAuthentication, AgentAuthScheme, ContentMode,
  AgentCardSLA, AgentProvider, JsonSchema,
} from './formats/index.js'
export type {
  AgentsMdDocument, AgentsMdMetadata, AgentsMdSection,
  AgentsMdToolConfig, AgentsMdCapability,
  AgentsMdMemoryConfig, AgentsMdSecurityConfig,
} from './formats/index.js'
export type {
  OpenAIFunctionDefinition, OpenAIToolDefinition,
  OpenAIFunctionParameters, OpenAIToolCall,
  ParallelFunctionConfig,
} from './formats/index.js'
export type { ToolSchemaDescriptor } from './formats/index.js'
export {
  zodToJsonSchema, jsonSchemaToZod,
  toOpenAIFunction, toOpenAITool, fromOpenAIFunction,
  toOpenAITools, fromOpenAIFunctions,
  toMCPToolDescriptor, fromMCPToolDescriptor,
  fromLangChainTool,
} from './formats/index.js'
export { parseAgentsMdV2, toLegacyConfig, generateAgentsMd, agentsMdFromDzipAgent } from './formats/index.js'
export { validateAgentCard } from './formats/index.js'
```

### 5.2 Changes to `@dzipagent/server`

```
packages/forgeagent-server/src/
  a2a/
    agent-card.ts                   # PRESERVED (deprecated, re-exports v1 types)
    agent-card-v2.ts                # F1: buildAgentCardV2(), agentCardFromDzipAgent()
    ...
  routes/
    a2a.ts                          # MODIFIED: adds /.well-known/agent-card.json route
```

### 5.3 Changes to `@dzipagent/agent`

```
packages/forgeagent-agent/src/
  structured/                       # NEW directory
    structured-output-types.ts      # F4: StructuredOutputConfig, StructuredOutputResult
    strategy-resolver.ts            # F4: detectModelCapabilities(), selectStrategy()
    structured-output-executor.ts   # F4: executeStructuredOutput()
    index.ts                        # Barrel export
  snapshot/                         # NEW directory
    snapshot-types.ts               # F6: DzipAgentSnapshot, SerializedMessageV2, etc.
    snapshot-operations.ts          # F6: createSnapshot, verifySnapshot, diffSnapshots, restoreFromSnapshot
    index.ts                        # Barrel export
  messages/                         # NEW directory
    message-serializer.ts           # F8: serializeMessagesV2, deserializeMessagesV2, migration
    index.ts                        # Barrel export
  tools/
    tool-schema-registry-types.ts   # F7: ToolSchemaEntry, CompatibilityResult
    tool-schema-registry.ts         # F7: ToolSchemaRegistry class
  agent/
    dzip-agent.ts                  # MODIFIED: generateStructured delegates to executor
```

### 5.4 Changes to `@dzipagent/codegen`

```
packages/forgeagent-codegen/src/
  pipeline/
    pipeline-definition-types.ts    # F5: PipelineDefinition, PipelineNodeDefinition, etc.
    pipeline-validator.ts           # F5: validatePipelineDefinition()
    pipeline-serializer.ts          # F5: exportPipelineDefinition(), importPipelineDefinition()
```

### 5.5 New Peer Dependency

`zod-to-json-schema` is added as a peer dependency of `@dzipagent/core` (used in F3 for `zodToJsonSchema`). It is a lightweight package (< 10KB) with no transitive dependencies beyond `zod`.

---

## 6. Testing Strategy

### 6.1 Schema Validation Tests

**Location:** `packages/forgeagent-core/src/__tests__/formats/`

```
agent-card-validator.test.ts
  - Valid card passes validation
  - Missing required fields produce errors
  - Invalid URL format produces error
  - Empty capabilities array produces warning
  - Invalid auth scheme produces error
  - Extra fields produce error (additionalProperties: false)

pipeline-validator.test.ts (in codegen)
  - Valid pipeline passes
  - Missing input node produces error
  - Missing output node produces error
  - Cycle in unconditional edges produces error
  - Conditional back-edge (for fix loops) is allowed
  - Unreachable node produces error
  - Duplicate node ID produces error
  - Fork without matching join produces warning
```

### 6.2 Round-Trip Serialization Tests

**Location:** `packages/forgeagent-agent/src/__tests__/messages/`

```
message-serializer.test.ts
  - System/Human/AI/Tool messages round-trip preserving role and content
  - AI message with tool_calls round-trips (id, name, args preserved)
  - Tool message with tool_call_id round-trips
  - Multimodal content (text + image blocks) round-trips
  - Metadata survives round-trip
  - Compact mode omits undefined fields but still round-trips
  - Empty message array round-trips
  - v1 format detected correctly
  - v2 format detected correctly
  - v1 -> v2 migration preserves all v1 data
  - Large message arrays (1000+) serialize within 100ms

snapshot-operations.test.ts
  - Snapshot creation includes all sections
  - Snapshot with signing produces valid HMAC
  - verifySnapshot returns true for unmodified snapshot
  - verifySnapshot returns false for tampered snapshot
  - diffSnapshots detects message additions
  - diffSnapshots detects memory changes
  - diffSnapshots detects config changes
  - restoreFromSnapshot returns correct message types
  - migrateSnapshot upgrades legacy AgentStateSnapshot to DzipAgentSnapshot
```

### 6.3 Cross-Format Conversion Tests

**Location:** `packages/forgeagent-core/src/__tests__/formats/`

```
tool-format-adapters.test.ts
  - zodToJsonSchema converts simple object schema
  - zodToJsonSchema with strict: true adds additionalProperties: false
  - zodToJsonSchema handles optional fields correctly
  - zodToJsonSchema handles enums, arrays, nested objects
  - jsonSchemaToZod converts basic JSON Schema to Zod
  - jsonSchemaToZod handles unsupported features gracefully (z.unknown)
  - toOpenAIFunction produces valid OpenAI function format
  - toOpenAIFunction validates name regex (a-zA-Z0-9_- only)
  - fromOpenAIFunction -> toOpenAIFunction round-trips
  - toMCPToolDescriptor produces valid MCP format
  - fromMCPToolDescriptor -> toMCPToolDescriptor round-trips
  - fromLangChainTool extracts name, description, and schema
  - Batch conversion: toOpenAITools / fromOpenAIFunctions

agents-md-parser-v2.test.ts
  - Parses YAML front matter
  - Parses capabilities section
  - Parses memory requirements
  - Parses security constraints
  - Backward compat: toLegacyConfig produces valid AgentsMdConfig
  - Handles missing front matter gracefully
  - Handles malformed YAML gracefully (non-fatal)

agents-md-generator.test.ts
  - Generates valid AGENTS.md from full document
  - Round-trip: parseAgentsMdV2(generateAgentsMd(doc)) deep-equals doc
  - agentsMdFromDzipAgent produces valid document
```

### 6.4 Compatibility Regression Tests

**Location:** `packages/forgeagent-agent/src/__tests__/tools/`

```
tool-schema-registry.test.ts
  - Register new tool succeeds
  - Register updated tool archives previous version
  - checkCompatibility detects added required field as breaking
  - checkCompatibility detects removed field as breaking
  - checkCompatibility detects type change as breaking
  - checkCompatibility allows added optional field as non-breaking
  - checkCompatibility allows description change as non-breaking
  - generateDocs('markdown') produces valid markdown
  - generateDocs('json') produces valid JSON
  - generateDocs('openapi') produces valid OpenAPI fragment
  - export/import round-trips all entries
  - Deprecated tool appears in listDeprecated()

structured-output.test.ts
  - detectModelCapabilities identifies Anthropic provider
  - detectModelCapabilities identifies OpenAI provider
  - detectModelCapabilities falls back to 'unknown' for unrecognized
  - selectStrategy returns anthropic_tool_use for Claude
  - selectStrategy returns openai_json_schema for GPT-4o
  - selectStrategy returns generate_parse_validate for unknown
  - executeStructuredOutput retries on validation failure (mock model)
  - executeStructuredOutput respects maxRetries limit
  - executeStructuredOutput uses forced strategy when specified
```

### 6.5 Test Infrastructure Notes

- All format tests are pure unit tests with no LLM calls.
- Structured output executor tests use a mock `BaseChatModel` that returns predetermined responses.
- Schema validation tests use fixture files (JSON/YAML) stored alongside test files.
- Round-trip tests use property-based testing where practical (generate random messages, verify round-trip).
- Performance tests (message serialization with 1000+ messages) use `performance.now()` assertions.

---

## Appendix A: Implementation Priority and Dependency Order

```
Week 1 (P0, 10h):
  F1: Agent Card v2 types (core) -> builder (server) -> route update (server)
  F3: Tool format adapters (core) — no dependencies
  F4: Structured output types + strategy resolver (agent) -> executor (agent)

Week 2 (P1, 20h):
  F2: AGENTS.md types (core) -> parser v2 (core) -> generator (core)
  F5: Pipeline definition types (codegen) -> validator (codegen) -> serializer (codegen)
  F8: Message serializer v2 (agent) -> migration (agent)

Week 3 (P1-P2, 8h):
  F6: Snapshot types (agent) -> operations (agent) -> signing + diff
  F7: Tool schema registry types (agent) -> registry class (agent)
```

## Appendix B: Breaking Changes and Migration

| Change | Affected Consumers | Migration Path |
|--------|-------------------|---------------|
| `AgentCard` type gains new required fields | Server `createA2ARoutes` callers | Use `buildAgentCardV2` instead of `buildAgentCard`; old builder preserved as deprecated |
| `DzipAgent.generateStructured` return shape | Direct `generateStructured` callers | Return shape unchanged; only internal strategy selection changes |
| New `@context` and `@type` fields on agent card JSON | External A2A consumers | Additive; existing parsers ignoring unknown fields are unaffected |
| `SerializedMessage` extended to `SerializedMessageV2` | Snapshot persistence consumers | v1 format auto-detected and migrated; no action needed for reads |

No existing public API signatures are removed. All changes are additive or provide a deprecated bridge.

## Appendix C: New Peer Dependencies

| Package | Version | Used By | Purpose |
|---------|---------|---------|---------|
| `zod-to-json-schema` | `^3.23` | `@dzipagent/core` | `zodToJsonSchema()` in F3 tool adapters |

This is the only new external dependency introduced by this plan. The `yaml` package is NOT required because AGENTS.md front matter parsing uses a minimal built-in parser (the front matter format is constrained enough to parse with regex + JSON.parse after simple key-value extraction). If full YAML support is later needed, `yaml` (the `yaml` npm package) can be added as an optional peer dependency.
