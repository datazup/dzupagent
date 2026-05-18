# Tools Architecture (`packages/agent/src/tools`)

## Scope
This document describes the tool-related implementation under `packages/agent/src/tools` in `@dzupagent/agent`.

Covered files:
- `agent-as-tool.ts`
- `create-tool.ts`
- `human-contact-tool.ts`
- `tool-schema-registry.ts`
- `tool-tier-registry.ts`

Primary in-package consumers and exports:
- `src/index.ts` and `src/tools.ts` public exports for tool surfaces
- `src/agent/dzip-agent.ts` (`DzupAgent.asTool()` and runtime tool filtering)
- `src/agent/agent-construction.ts` (`agent:tools-filtered` audit emission)
- tests in `src/tools/*.test.ts` and `src/__tests__/*tool*`

## Responsibilities
The module provides five concrete responsibilities:

1. Compatibility re-export for forge tool creation.
- `create-tool.ts` re-exports `createForgeTool` and `ForgeToolConfig` from `@dzupagent/core/tools`.
- It is explicitly marked as a deprecated compatibility bridge.

2. Human-in-the-loop contact tool creation.
- `human-contact-tool.ts` builds a LangChain structured tool (`human_contact`) for approval, clarification, input request, escalation, and custom modes.
- It persists pending contacts via a pluggable store and can invoke an `onPause` callback.

3. Versioned schema registry for tools.
- `tool-schema-registry.ts` stores versioned input/output schemas, returns latest or explicit versions, checks backward compatibility, and generates markdown docs.

4. Permission-tier metadata and filtering for tools.
- `tool-tier-registry.ts` stores required permission tiers in a `WeakMap` keyed by tool instance.
- It provides default tier resolution and filtering logic (`filterToolsByTier`) using `tierSatisfies` from `@dzupagent/core/tools`.

5. Agent-to-tool adaptation.
- `agent-as-tool.ts` wraps a minimal agent surface (`id`, `description`, `generate`) into a LangChain structured tool named `agent-<id>`.

## Structure
| File | Role | Export Surface |
|---|---|---|
| `create-tool.ts` | Deprecated bridge to `@dzupagent/core/tools` forge tool APIs | Public via `src/index.ts` and `src/tools.ts` |
| `human-contact-tool.ts` | HITL contact tool factory + pending-contact store interfaces and in-memory store | Public via `src/index.ts` and `src/tools.ts` |
| `tool-schema-registry.ts` | In-memory versioned tool schema registry + compatibility checks + markdown docs generation | Public via `src/index.ts` and `src/tools.ts` |
| `tool-tier-registry.ts` | Sidecar permission-tier registry and tier-based filter helpers | Public via `src/index.ts` only |
| `agent-as-tool.ts` | Internal helper for `DzupAgent.asTool()` | Internal (imported by `src/agent/dzip-agent.ts`) |

## Runtime and Control Flow
### `createForgeTool` compatibility path
1. Caller imports `createForgeTool` from `@dzupagent/agent` or `@dzupagent/agent/tools`.
2. `src/tools/create-tool.ts` forwards directly to `@dzupagent/core/tools`.
3. Validation/execution semantics are owned by `@dzupagent/core/tools`, not this folder.

### `createHumanContactTool` flow
1. Factory resolves dependencies from config:
- `pendingStore` defaults to `InMemoryPendingContactStore`.
- `defaultChannel` defaults to `'in-app'`.
2. Tool invocation validates input through Zod schema (`mode`, optional `question`, `context`, `channel`, `timeoutHours`, `fallback`, `data`).
3. Runtime values are created:
- `contactId` via `randomUUID()`.
- `runId` currently hardcoded as `'unknown'`.
- channel resolved as `input.channel ?? defaultChannel`.
- `timeoutAt` computed from `timeoutHours` when present.
4. `buildRequest(...)` maps mode-specific request payloads (`approval`, `clarification`, `input_request`, `escalation`, or passthrough custom type).
5. A `PendingHumanContact` object is created with resume token and saved to store.
6. Optional `onPause(contactId, request)` callback is awaited.
7. Tool returns a JSON string with `contactId`, `status: 'pending'`, channel, message, and a resume endpoint template.

### Permission-tier filtering flow
1. Tools can be tagged with required tier via `setToolTier(tool, tier)`.
2. Required tiers are stored in a module-private `WeakMap` (no tool mutation).
3. Untagged tools resolve to `DEFAULT_TOOL_TIER` (`'read-only'`).
4. `filterToolsByTier(tools, agentTier)` keeps tools where `tierSatisfies(agentTier, requiredTier)`.
5. `DzupAgent` applies this filter in `getTools()` so both configured tools and middleware-provided tools are gated.
6. `emitToolFilterAudit(...)` in `agent-construction.ts` emits `agent:tools-filtered` telemetry (counts and filtered names) when an event bus is configured.

### `agentAsTool` flow
1. `DzupAgent.asTool()` passes `{ id, description, generate }` to `agentAsTool(...)`.
2. `agentAsTool` dynamically imports `zod`, `@langchain/core/tools`, and `HumanMessage`.
3. It creates a tool named `agent-<id>` with input schema `{ task, context? }`.
4. On invoke, it builds one `HumanMessage` from task plus optional context block.
5. It calls `ctx.generate(messages)` and returns `GenerateResult.content`.

### `ToolSchemaRegistry` flow
1. `register(entry)` inserts/replaces by `(name, version)` and sorts versions via numeric dot-split semver comparison.
2. `get(name, version?)` returns explicit version or latest.
3. `list()` flattens all stored entries.
4. `checkBackwardCompat(name, oldVersion, newVersion)` recursively checks input schema compatibility and reports breaking changes.
5. `generateDocs()` renders markdown with latest schema and version list per tool.

## Key APIs and Types
`create-tool.ts`:
- `createForgeTool` (re-export)
- `ForgeToolConfig` (re-exported type)

`human-contact-tool.ts`:
- `createHumanContactTool(config?: HumanContactToolConfig): StructuredToolInterface`
- `HumanContactInput`
- `HumanContactToolConfig`
- `PendingContactStore`
- `InMemoryPendingContactStore`

`tool-schema-registry.ts`:
- `ToolSchemaRegistry`
- `ToolSchemaEntry`
- `CompatCheckResult`

`tool-tier-registry.ts`:
- `DEFAULT_TOOL_TIER`
- `setToolTier(tool, tier)`
- `getToolTier(tool)`
- `filterToolsByTier(tools, agentTier)`

`agent-as-tool.ts` (internal):
- `AgentAsToolContext`
- `agentAsTool(ctx): Promise<StructuredToolInterface>`

## Dependencies
Direct dependencies used in this folder:
- `@langchain/core/tools` (`tool`, `StructuredToolInterface`)
- `@langchain/core/messages` (`HumanMessage` in `agent-as-tool.ts` dynamic import)
- `zod` (input schemas and inferred types)
- `node:crypto` (`randomUUID`)
- `@dzupagent/core/tools`
  - `createForgeTool` and `ForgeToolConfig`
  - contact-domain types (`ContactType`, `ContactChannel`, `HumanContactRequest`, `PendingHumanContact`)
  - permission-tier helpers/types (`PermissionTier`, `tierSatisfies`)
- internal utility `../utils/exact-optional.js` (`omitUndefined`)

Package-level contract (`packages/agent/package.json`):
- direct dependency on `@dzupagent/core`
- peer dependencies include `@langchain/core`, `@langchain/langgraph`, and `zod`

## Integration Points
1. Public package exports.
- `src/index.ts` exports all public tools from this folder, including the tier registry.
- `src/tools.ts` exports `createForgeTool`, human-contact tool/store/types, and `ToolSchemaRegistry` (does not export tier-registry helpers).

2. `DzupAgent` runtime.
- `asTool()` delegates to `agentAsTool`.
- private `getTools()` applies `filterToolsByTier(...)` against resolved tool list.

3. Agent constructor audit telemetry.
- `emitToolFilterAudit(...)` computes allowed vs filtered tools and emits `agent:tools-filtered` on configured event bus.

4. Orchestration layer usage.
- supervisor/orchestrator paths use `specialist.asTool()`; resulting tools flow through the same adaptation logic in this module.

5. Mailbox tool design alignment.
- `src/mailbox/mail-tools.ts` follows the same structured-tool factory style and references `createHumanContactTool` in comments, but remains a separate subsystem.

## Testing and Observability
Test coverage in this package includes:

1. `src/tools/human-contact-tool.test.ts`.
- mode shaping for approval/clarification/input_request/escalation/custom
- channel fallback behavior
- timeout/expiresAt handling
- pending store save/get/delete behavior
- `onPause` success/failure behavior
- response payload shape (`status`, `contactId`, `resumeWith`, etc.)

2. `src/__tests__/tool-schema-registry.test.ts` and `src/__tests__/tool-schema-registry-deep.test.ts`.
- register/get/list semantics
- version replacement and ordering
- compatibility failure cases (field removal, type changes, required additions, arrays)
- docs generation behavior

3. `src/__tests__/tool-tier-filtering.test.ts`.
- default tier behavior for untagged tools
- non-mutation guarantee (no `requiredTier` property on tool instance)
- filtering behavior across `read-only`, `workspace-write`, `full-access`
- `DzupAgent` integration and `agent:tools-filtered` event payload assertions
- middleware-provided tool filtering coverage

4. `src/__tests__/create-tool-deep.test.ts` and `src/__tests__/dzip-agent.test.ts`.
- `createForgeTool` behavior through re-export path
- `DzupAgent.asTool()` behavior via internal adapter path

Observability characteristics:
- module itself does not emit logs/metrics directly
- `human_contact` returns structured JSON suitable for external telemetry capture
- permission-tier filtering has explicit audit event integration via `emitToolFilterAudit`
- registry/store implementations in this folder are in-memory only by default

## Risks and TODOs
1. `runId` placeholder in human contact tool.
- `human-contact-tool.ts` currently uses `runId = 'unknown'`; resume endpoint text therefore contains placeholder run IDs unless upstream wiring injects context.

2. Channel preference chain is intentionally incomplete.
- file comments mention user-profile preference resolution, but implementation currently resolves only `input.channel` then `defaultChannel`.

3. Default pending store is process-local and non-durable.
- `InMemoryPendingContactStore` has no persistence, TTL sweeper, or cross-process synchronization.

4. Schema compatibility is limited to input schema and simplified semver parsing.
- `checkBackwardCompat(...)` ignores output schema.
- version ordering uses numeric dot-split logic and does not model prerelease/build semver semantics.

5. Tool tier metadata is process-local.
- tier tags exist only in runtime memory (`WeakMap`) and are not serialized or persisted across process boundaries.

6. `createForgeTool` implementation ownership is external.
- behavior can change via `@dzupagent/core/tools` updates without edits inside `packages/agent/src/tools`.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

