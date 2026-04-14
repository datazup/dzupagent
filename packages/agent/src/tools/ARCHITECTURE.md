# Tools Module Architecture (`packages/agent/src/tools`)

## 1. Scope

This folder contains two primitives that define how tool contracts are created and evolved in `@dzupagent/agent`:

- `create-tool.ts`
  - `createForgeTool(...)`: factory for LangChain `StructuredToolInterface` tools.
- `tool-schema-registry.ts`
  - `ToolSchemaRegistry`: in-memory registry for versioned JSON schemas, compatibility checks, and docs generation.

These utilities are exported from `packages/agent/src/index.ts` and are part of the public package API.

## 2. Design Goals

- Provide a simple way to create strongly typed, LangChain-compatible tools from Zod schemas.
- Keep tool execution contract explicit:
  - input validation (via LangChain + schema),
  - optional output validation,
  - deterministic model-facing output.
- Support schema lifecycle management for tools:
  - versioning,
  - backward-compat checks,
  - generated markdown docs.

## 3. Component A: `createForgeTool`

### 3.1 Public Contract

`createForgeTool<TInput, TOutput>(config: ForgeToolConfig<TInput, TOutput>): StructuredToolInterface`

`ForgeToolConfig` fields:

- `id`: tool name exposed to the model.
- `description`: capability description for tool selection/planning.
- `inputSchema`: Zod schema used as the LangChain tool schema.
- `outputSchema?`: optional Zod schema to validate runtime output.
- `execute(input)`: async implementation.
- `toModelOutput?(output)`: optional formatter for final model-visible string.

### 3.2 Runtime Flow

1. Caller defines `inputSchema` and `execute`.
2. `createForgeTool` wraps `execute` via LangChain `tool(...)`.
3. On invocation:
   - execute `config.execute(input)`,
   - if `outputSchema` exists, validate `result` with `outputSchema.parse(result)`,
   - if `toModelOutput` exists, return formatted string,
   - otherwise:
     - return raw string if result is already a string,
     - else return `JSON.stringify(result)`.

### 3.3 Behavior Notes

- Output validation is opt-in (`outputSchema`).
- Validation failure throws from Zod parse (no internal fallback).
- Default serialization is JSON for non-string outputs.
- `toModelOutput` lets tools hide large payloads from the model while still returning structured data internally.

### 3.4 Example: Typed Tool with Structured Output

```ts
import { createForgeTool } from '@dzupagent/agent'
import { z } from 'zod'

const searchTool = createForgeTool({
  id: 'search-docs',
  description: 'Search docs by query',
  inputSchema: z.object({
    query: z.string(),
    limit: z.number().int().positive().default(5),
  }),
  outputSchema: z.object({
    total: z.number(),
    hits: z.array(z.object({
      title: z.string(),
      url: z.string().url(),
    })),
  }),
  execute: async ({ query, limit }) => {
    const hits = await doSearch(query, limit)
    return { total: hits.length, hits }
  },
  toModelOutput: (output) => `${output.total} results found`,
})
```

## 4. Component B: `ToolSchemaRegistry`

### 4.1 Data Model

`ToolSchemaEntry`:

- `name`, `version`, `description`
- `inputSchema` (JSON Schema-like object)
- optional `outputSchema`
- `registeredAt` (ISO timestamp)

`CompatCheckResult`:

- `compatible: boolean`
- `breaking: string[]`

### 4.2 Registry Operations

1. `register(entry)`
   - stores first version,
   - replaces same-version entries,
   - sorts versions by a semver-like numeric comparator.
2. `get(name, version?)`
   - specific version if provided,
   - otherwise latest version.
3. `list()`
   - returns all entries across all tools.
4. `checkBackwardCompat(name, oldVersion, newVersion)`
   - loads both versions,
   - recursively checks input schema changes,
   - returns explicit breaking-change list.
5. `generateDocs()`
   - emits markdown with latest schema per tool plus version list.

### 4.3 Compatibility Rules Implemented

The compatibility checker reports breaking changes for:

- field removal,
- type changes,
- new required fields that did not exist previously,
- incompatible array item schema changes.

It allows:

- adding optional fields,
- adding fields without requiring them.

### 4.4 Example: Versioning and Compat Check

```ts
import { ToolSchemaRegistry } from '@dzupagent/agent'

const registry = new ToolSchemaRegistry()

registry.register({
  name: 'read_file',
  version: '1.0.0',
  description: 'Read a text file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  registeredAt: new Date().toISOString(),
})

registry.register({
  name: 'read_file',
  version: '1.1.0',
  description: 'Read a text file with optional encoding',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      encoding: { type: 'string' },
    },
    required: ['path'],
  },
  registeredAt: new Date().toISOString(),
})

const compat = registry.checkBackwardCompat('read_file', '1.0.0', '1.1.0')
// compat.compatible === true
// compat.breaking === []

const docs = registry.generateDocs()
```

## 5. End-to-End Flow with Agent Runtime

`createForgeTool` output integrates directly with `runToolLoop(...)` in `packages/agent/src/agent/tool-loop.ts`:

1. Tool is created with `name`, `description`, `schema`.
2. Agent loop receives tool calls from model.
3. If `validateToolArgs` is enabled:
   - tool-loop extracts JSON schema from `tool.schema`,
   - validates/repairs arguments before invocation.
4. Tool `invoke(...)` executes and returns model-visible content.

Important integration detail:

- `tool-loop.ts` accepts schema objects directly and also attempts Zod conversion (`jsonSchema()`), so tools created by `createForgeTool` align with arg-repair path used by the loop.

## 6. References in Other Packages

### 6.1 Direct Consumers of `createForgeTool`

- `packages/connectors-browser/src/browser-connector.ts`
  - builds 5 tools:
    - `browser-crawl-site`
    - `browser-capture-screenshot`
    - `browser-extract-forms`
    - `browser-extract-elements`
    - `browser-extract-a11y-tree`
  - uses `toModelOutput` selectively to compress large payload exposure.
- `packages/connectors-documents/src/document-connector.ts`
  - builds:
    - `parse-document`
    - `chunk-document`
  - uses model-facing summary output for chunking (`"N chunks created"`).

### 6.2 Related Pattern (Conceptual)

- `packages/scraper/src/scraper.ts`
  - does not import `createForgeTool`,
  - explicitly follows the same descriptor shape (`name`, `description`, `schema`, `invoke`) via `asTool()`.

### 6.3 `ToolSchemaRegistry` Usage Status

- No runtime usage in other packages was found in source code.
- Current usage is local to `@dzupagent/agent` tests and export surface.
- It is effectively an available utility API, not yet wired into connector registration pipelines.

## 7. Test Coverage Analysis

Executed targeted suites:

- `yarn workspace @dzupagent/agent test src/__tests__/tool-schema-registry.test.ts src/__tests__/parallel-tool-loop.test.ts`
- `yarn workspace @dzupagent/connectors-browser test src/__tests__/browser-connector.integration.test.ts`
- `yarn workspace @dzupagent/connectors-documents test src/__tests__/document-connector.integration.test.ts`

Observed passing tests:

- `tool-schema-registry.test.ts`: 12 tests
- `parallel-tool-loop.test.ts`: 11 tests
- `browser-connector.integration.test.ts`: 3 tests
- `document-connector.integration.test.ts`: 3 tests

### 7.1 Covered

- `ToolSchemaRegistry`:
  - register/get/list behavior,
  - latest-version resolution,
  - compatibility checks for optional addition, field removal, type change, missing versions,
  - markdown docs generation with multi-version listing.
- `createForgeTool` (indirectly via connector integration):
  - generated tools have expected names/descriptions,
  - generated tools are invokable through public connector APIs.
- Agent loop integration:
  - schema-driven argument repair and validation path works in sequential and parallel execution.

### 7.2 Gaps / Risks

- No direct unit test file for `createForgeTool` itself.
  - Missing explicit assertions for:
    - output schema parse failure behavior,
    - fallback `JSON.stringify` behavior for object outputs,
    - `toModelOutput` precedence over default serialization.
- Compatibility checker edge cases not explicitly tested:
  - optional field becoming required (existing property),
  - non-standard semver strings,
  - deeper nested mixed object/array schema transitions.

## 8. Typical Use Cases

- Build connector/tool packages with consistent LangChain-compatible contracts.
- Keep tool interfaces strongly typed in TypeScript using Zod inference.
- Gate tool response shape with output schema validation before model exposure.
- Version schemas for governance and release notes (`ToolSchemaRegistry.generateDocs()`).
- Detect breaking input schema changes before upgrading shared tools across packages.

## 9. Practical Recommendations

- Add dedicated tests for `createForgeTool` in `packages/agent/src/__tests__/create-tool.test.ts`.
- If schema governance becomes central, wire `ToolSchemaRegistry` into connector/tool registration lifecycle (build-time or startup-time checks).
- Consider extending compatibility rules to flag optional->required transitions as breaking.
