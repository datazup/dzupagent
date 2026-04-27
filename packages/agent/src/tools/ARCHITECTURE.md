# Tools Architecture (`packages/agent/src/tools`)

## Scope
This document covers the tool-related code in `packages/agent/src/tools` within `@dzupagent/agent`:

- `create-tool.ts`
- `tool-schema-registry.ts`
- `human-contact-tool.ts`
- `agent-as-tool.ts`

It also references direct in-package integrations that consume this folder:

- public exports in `src/index.ts`
- `DzupAgent.asTool()` in `src/agent/dzip-agent.ts`
- tool argument validation hooks in `src/agent/tool-loop.ts`
- tests under `src/__tests__` and `src/tools/*.test.ts`

## Responsibilities
The tools module currently provides four distinct responsibilities:

1. Preserve backward compatibility for tool creation APIs.
- `create-tool.ts` re-exports `createForgeTool` and `ForgeToolConfig` from `@dzupagent/core` and is marked deprecated for direct imports from this package.

2. Provide a built-in human-in-the-loop tool.
- `human-contact-tool.ts` builds a LangChain `StructuredToolInterface` named `human_contact`.
- It standardizes request payloads for approval, clarification, input request, escalation, and custom modes.
- It persists pending requests via a pluggable store interface and optionally triggers a pause callback.

3. Provide a versioned schema registry utility.
- `tool-schema-registry.ts` stores per-tool versioned schema entries, resolves latest versions, performs backward-compatibility checks, and can generate markdown docs from current registry state.

4. Adapt an agent instance into a callable tool.
- `agent-as-tool.ts` wraps a minimal agent surface (`id`, `description`, `generate`) into a structured tool that accepts `{ task, context? }` and returns the agent response text.
- This helper is used by `DzupAgent.asTool()` rather than being exported publicly from `src/index.ts`.

## Structure
| File | Role | Public Export |
|---|---|---|
| `create-tool.ts` | Deprecated compatibility re-export of `createForgeTool` from `@dzupagent/core` | Yes (via `src/index.ts`) |
| `human-contact-tool.ts` | Built-in human-contact tool factory plus pending-contact store abstractions | Yes (via `src/index.ts`) |
| `tool-schema-registry.ts` | In-memory schema registry with compatibility and docs generation | Yes (via `src/index.ts`) |
| `agent-as-tool.ts` | Internal helper used by `DzupAgent.asTool()` | No direct package-root export |

Related tests:

- `src/__tests__/create-tool-deep.test.ts`
- `src/__tests__/tool-schema-registry.test.ts`
- `src/__tests__/tool-schema-registry-deep.test.ts`
- `src/tools/human-contact-tool.test.ts`
- `src/__tests__/dzip-agent.test.ts` (`asTool()` coverage)
- `src/__tests__/orchestrator-patterns.test.ts` and `src/__tests__/supervisor.test.ts` (supervisor usage of `asTool()`)

## Runtime and Control Flow
### `createForgeTool` compatibility path
1. Consumers import `createForgeTool` from `@dzupagent/agent`.
2. `src/tools/create-tool.ts` forwards directly to `@dzupagent/core`.
3. Runtime behavior (validation/serialization) is owned by `@dzupagent/core`, not this folder.

### Human contact tool flow (`createHumanContactTool`)
1. Caller creates the tool with optional `defaultChannel`, `pendingStore`, and `onPause`.
2. Tool invocation validates input against the Zod schema (`mode`, optional `question/context/channel/timeoutHours/fallback/data`).
3. A `contactId` is generated (`randomUUID`), channel is resolved (`input.channel` -> `defaultChannel` -> `'in-app'`), and timeout is converted into an ISO timestamp when set.
4. `buildRequest(...)` maps mode-specific fields into a `HumanContactRequest`.
5. A `PendingHumanContact` is saved through `PendingContactStore`.
6. `onPause` is called when provided.
7. Tool returns a JSON string containing `contactId`, `status: "pending"`, channel, and a `resumeWith` URL template.

Current implementation details:

- `runId` is currently hardcoded as `'unknown'` inside the tool.
- User-profile channel preference resolution is documented as a future step and is not implemented.

### Agent-as-tool flow (`agentAsTool`)
1. `DzupAgent.asTool()` calls `agentAsTool({ id, description, generate })`.
2. `agentAsTool` dynamically imports `zod`, `@langchain/core/tools`, and `HumanMessage`.
3. The produced tool name is `agent-${id}`.
4. On invoke, it builds one `HumanMessage` with `task` and optional formatted context block, calls `generate(...)`, and returns `GenerateResult.content`.

### Schema registry flow (`ToolSchemaRegistry`)
1. `register(entry)` inserts or replaces an entry by `(name, version)` and sorts versions with numeric dot-split comparison.
2. `get(name, version?)` returns a specific version or latest version.
3. `checkBackwardCompat(name, oldVersion, newVersion)` compares `inputSchema` trees and reports breaking changes.
4. `generateDocs()` emits markdown with latest schema per tool and lists all versions when multiple exist.

Compatibility checks currently enforce:

- field removals are breaking
- type changes are breaking
- newly added required fields are breaking when the field did not exist in the old schema
- array item incompatibilities are breaking

## Key APIs and Types
### `create-tool.ts`
- `createForgeTool` (re-export from `@dzupagent/core`)
- `ForgeToolConfig` (re-exported type)

### `human-contact-tool.ts`
- `createHumanContactTool(config?: HumanContactToolConfig): StructuredToolInterface`
- `HumanContactInput` (inferred from Zod input schema)
- `HumanContactToolConfig`
- `PendingContactStore`
- `InMemoryPendingContactStore`

### `tool-schema-registry.ts`
- `ToolSchemaRegistry`
- `ToolSchemaEntry`
- `CompatCheckResult`

### `agent-as-tool.ts` (internal)
- `agentAsTool(ctx: AgentAsToolContext): Promise<StructuredToolInterface>`
- `AgentAsToolContext`

## Dependencies
Direct dependencies used by this folder:

- `@langchain/core/tools` (`tool`, `StructuredToolInterface`)
- `@langchain/core/messages` (`HumanMessage` via dynamic import in `agent-as-tool.ts`)
- `zod` (schema definitions)
- `node:crypto` (`randomUUID` for contact and resume tokens)
- `@dzupagent/core`
  - `createForgeTool` and `ForgeToolConfig` re-export source
  - human-contact domain types (`ContactType`, `ContactChannel`, `HumanContactRequest`, `PendingHumanContact`)

Package-level context (`packages/agent/package.json`):

- peer deps include `@langchain/core`, `@langchain/langgraph`, and `zod`
- `@dzupagent/core` is a direct dependency, which is required for `createForgeTool` re-export and human-contact types

## Integration Points
1. Package root exports.
- `src/index.ts` exports `createForgeTool`, `createHumanContactTool`, `InMemoryPendingContactStore`, and `ToolSchemaRegistry` from this folder.

2. Agent runtime exposure.
- `DzupAgent.asTool()` delegates to `agentAsTool(...)` in this folder.
- Supervisor orchestration paths rely on `asTool()` to expose specialist agents as tools.

3. Tool loop argument validation.
- `src/agent/tool-loop.ts` attempts to extract JSON-schema-like shapes from tool schemas for validation/repair.
- Commented behavior explicitly accounts for schemas from `createForgeTool` or raw JSON-schema-like objects.

4. Mailbox tool design alignment.
- `src/mailbox/mail-tools.ts` follows the same LangChain structured tool factory pattern and references `createHumanContactTool` in comments, but is a separate module.

## Testing and Observability
Current tests in this package exercise tool behavior as follows:

1. `createForgeTool` behavior (`src/__tests__/create-tool-deep.test.ts`).
- string passthrough
- JSON serialization of object outputs
- output schema validation success/failure
- `toModelOutput` override
- error propagation

2. `ToolSchemaRegistry` behavior (`tool-schema-registry.test.ts`, `tool-schema-registry-deep.test.ts`).
- register/get/list semantics
- version sorting and replacement
- compatibility outcomes for removals, type changes, required-field additions, and arrays
- docs generation content and ordering

3. `createHumanContactTool` behavior (`src/tools/human-contact-tool.test.ts`).
- mode-specific request shaping
- channel fallback behavior
- timeout/default handling
- pending-store CRUD behavior
- `onPause` invocation and error propagation
- response payload metadata (`status`, `resumeWith`, etc.)

4. `agentAsTool` behavior through `DzupAgent.asTool()` tests (`src/__tests__/dzip-agent.test.ts`) and supervisor orchestration tests.

Observability characteristics:

- No dedicated logger/metrics hooks are emitted from this folder.
- `human_contact` returns structured JSON payloads suitable for external telemetry pipelines.
- `ToolSchemaRegistry` is in-memory only; no persistence or event stream is emitted by default.

## Risks and TODOs
1. `human-contact-tool.ts` currently hardcodes `runId = 'unknown'`.
- Resume URLs include this placeholder, so production wiring must inject real run identity outside this module or extend the API.

2. Human channel preference step is not implemented.
- The comments describe a user-profile preference stage, but channel resolution currently only uses input override and config default.

3. Default pending-contact store is process-local memory.
- `InMemoryPendingContactStore` has no TTL sweeper, durability, or cross-process coordination.

4. `ToolSchemaRegistry` version ordering is simple numeric dot-split.
- It does not implement full semver prerelease/build semantics.

5. Compatibility checks target input schemas only.
- `checkBackwardCompat` does not evaluate output schema compatibility.

6. `createForgeTool` behavior is delegated.
- This package’s tests cover the behavior through the re-export, but implementation ownership is in `@dzupagent/core`; changes there can alter behavior without edits in this folder.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

