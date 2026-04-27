# Tools Module Architecture (`packages/core/src/tools`)

## Scope
This document covers the tool primitives implemented in `packages/core/src/tools`:
- `connector-contract.ts`
- `create-tool.ts`
- `tool-stats-tracker.ts`
- `tool-governance.ts`
- `human-contact-types.ts`

Scope is limited to `packages/core` and how these symbols are exported from `src/index.ts`.

## Responsibilities
The module is a shared tool foundation layer, not a full execution runtime. It provides:
- Canonical connector tool typing and normalization helpers (`BaseConnectorTool`, `isBaseConnectorTool`, `normalizeBaseConnectorTool`, `normalizeBaseConnectorTools`).
- A LangChain-compatible tool factory with Zod input/output validation (`createForgeTool`).
- In-memory tool performance tracking and ranking (`ToolStatsTracker`).
- Policy-style access checks plus audit hooks for tool calls (`ToolGovernance`).
- Shared request/response type contracts for human-in-the-loop contact workflows (`human-contact-types`).

## Structure
| File | Purpose | Main exports |
| --- | --- | --- |
| `connector-contract.ts` | Defines the canonical connector tool shape and structural helpers. | `BaseConnectorTool`, `isBaseConnectorTool`, `normalizeBaseConnectorTool`, `normalizeBaseConnectorTools` |
| `create-tool.ts` | Builds LangChain `StructuredToolInterface` tools from a typed config. | `createForgeTool`, `ForgeToolConfig` |
| `tool-stats-tracker.ts` | Tracks tool outcomes in memory and derives ranking/prompt hints. | `ToolStatsTracker`, `ToolCallRecord`, `ToolStats`, `ToolRanking`, `ToolStatsTrackerConfig` |
| `tool-governance.ts` | Synchronous access checks (blocklist, per-tool rate limit, validator, approval marker) plus optional audit callbacks. | `ToolGovernance`, `ToolGovernanceConfig`, `ToolValidationResult`, `ToolAuditHandler`, `ToolAuditEntry`, `ToolResultAuditEntry`, `ToolAccessResult` |
| `human-contact-types.ts` | Type-only contracts for human-contact request/response flows. | `ContactType`, `ContactChannel`, request/response unions, `PendingHumanContact` |

## Runtime and Control Flow
### `ToolGovernance`
`checkAccess(toolName, input)` applies checks in fixed order:
1. Blocklist check (`blockedTools`).
2. Rate-limit check (`rateLimits`) with per-tool in-memory counters and a 60-second window.
3. Custom validator (`validator`).
4. Approval marker (`approvalRequired`) returning `{ allowed: true, requiresApproval: true }`.
5. Default allow.

`audit(entry)` and `auditResult(entry)` forward to `auditHandler` when present. Handler errors are swallowed so auditing is non-fatal.

### `ToolStatsTracker`
1. `recordCall(record)` appends a call record by `toolName`.
2. Per-tool sliding-window eviction keeps only the latest `windowSize` records (default `200`).
3. `getStats(toolName)` computes aggregate metrics (counts, rates, avg/p95 latency, last-used, grouped top errors).
4. `getTopTools(limit?, intent?)` ranks tools using:
   - `score = successRate * successWeight + normalizedSpeed * latencyWeight`
   - `normalizedSpeed = clamp(1 - avgLatency / maxAvgLatency, 0..1)`
5. `formatAsPromptHint(limit?, intent?)` renders a ranked, numbered preference list or returns `''` when no data exists.

### `createForgeTool`
1. Accepts `ForgeToolConfig` with `id`, `description`, `inputSchema`, `execute`, and optional `outputSchema` / `toModelOutput`.
2. Builds a LangChain tool via `@langchain/core/tools.tool(...)`.
3. Runtime behavior on invocation:
   - Executes `config.execute(input)`.
   - Validates output with `outputSchema.parse(result)` when configured.
   - Returns `toModelOutput(result)` when provided.
   - Otherwise returns result as string, or `JSON.stringify(result)` for non-string outputs.
4. Returns as `StructuredToolInterface` using a compatibility cast documented in code comments.

### `connector-contract`
- `isBaseConnectorTool(value)` performs structural checks (`id`, `name`, `description`, `schema` key presence, `invoke` function).
- `normalizeBaseConnectorTool(tool)` defaults blank/missing `id` to `name` and conditionally keeps `toModelOutput`.
- `normalizeBaseConnectorTools(tools)` maps normalization over an array.

### `human-contact-types`
This file is type-only. It models request and response contracts for contact modes like `approval`, `clarification`, `input_request`, `escalation`, plus extensible string-based custom modes/channels.

## Key APIs and Types
### Connector contract
- `BaseConnectorTool<Input, Output>`: `{ id, name, description, schema, invoke, toModelOutput? }`.
- `isBaseConnectorTool(value)`: type guard for structural conformance.
- `normalizeBaseConnectorTool(...)` / `normalizeBaseConnectorTools(...)`: normalization helpers with `id` fallback.

### Tool factory
- `ForgeToolConfig<TInput, TOutput>`:
  - `id`, `description`, `inputSchema`, `execute` required.
  - `outputSchema`, `toModelOutput` optional.
- `createForgeTool(config)`: creates a LangChain structured tool wrapper with input/output handling.

### Governance
- `ToolGovernanceConfig`:
  - `blockedTools?: string[]`
  - `approvalRequired?: string[]`
  - `rateLimits?: Record<string, number>`
  - `maxExecutionMs?: number` (declared only; not enforced in this class)
  - `validator?: (toolName, input) => ToolValidationResult`
  - `auditHandler?: ToolAuditHandler`
- `ToolAccessResult`: `{ allowed, reason?, requiresApproval? }`.
- `ToolAuditHandler`: `onToolCall(...)` and optional `onToolResult(...)`.

### Stats
- `ToolCallRecord`: `{ toolName, success, durationMs, timestamp, intent?, errorType? }`.
- `ToolStats`: includes `successRate`, `avgDurationMs`, `p95DurationMs`, `lastUsed`, and `topErrors`.
- `ToolStatsTrackerConfig` defaults:
  - `windowSize = 200`
  - `successWeight = 0.7`
  - `latencyWeight = 0.3`

### Human contact contracts
- `ContactType` and `ContactChannel` are open unions using `(string & {})` extensibility.
- `HumanContactRequest` union includes approval/clarification/input/escalation plus generic request.
- `HumanContactResponse` union includes primary response types plus `timeout`, `late_response`, and generic response.
- `PendingHumanContact` represents persisted pending state and delivery status.

## Dependencies
Direct dependencies from `src/tools`:
- `create-tool.ts` imports:
  - `@langchain/core/tools` (`tool`, `StructuredToolInterface`)
  - `zod` types (`z`)
- Other files (`connector-contract.ts`, `tool-stats-tracker.ts`, `tool-governance.ts`, `human-contact-types.ts`) use only language/runtime primitives.

Package context (`packages/core/package.json`):
- `@langchain/core` and `zod` are declared as peer dependencies.
- Build/test uses `tsup`, `typescript`, and `vitest`.

## Integration Points
- `src/index.ts` re-exports all tool module symbols in the main package entrypoint.
- `src/advanced.ts` re-exports `src/index.ts`, so tools are available from `@dzupagent/core/advanced`.
- `src/stable.ts` re-exports only facades, so tools are not available from `@dzupagent/core/stable`.
- Inside `packages/core`, tool primitives are currently framework building blocks with test-driven usage; there are no additional in-package runtime consumers beyond the module itself and export surface.

## Testing and Observability
Test coverage present:
- `src/__tests__/tool-governance.test.ts`
- `src/__tests__/tool-stats-tracker.test.ts`

Covered behavior:
- Governance allow/block/approval/rate-limit/validator paths.
- Audit invocation and non-fatal audit failure behavior.
- Rate-limit reset and per-tool separation.
- Stats empty-state, aggregate metrics, ranking, intent filtering, sliding-window eviction, prompt-hint formatting, error aggregation, reset, and custom weighting.

Not directly tested in dedicated files:
- `src/tools/create-tool.ts`
- `src/tools/connector-contract.ts`
- `src/tools/human-contact-types.ts` (type-only module)

Observability characteristics:
- `ToolGovernance` exposes push-style audit hooks (`ToolAuditHandler`) but does not own persistence/transport.
- `ToolStatsTracker` exposes pull-style stats/ranking APIs and emits no events or metrics by itself.

## Risks and TODOs
- `ToolGovernanceConfig.maxExecutionMs` is declared but not enforced in `ToolGovernance`; callers must enforce execution timeouts separately.
- Governance rate limits are process-local in-memory counters and reset on restart.
- `checkAccess` consumes rate-limit budget before running custom validator logic.
- `ToolStatsTracker` has no built-in persistence/export; all telemetry is ephemeral unless callers persist snapshots.
- Ranking weights are not normalized, so extreme/custom weights can produce unintuitive composite scores.
- `connector-contract` validates shape, not schema semantics (`schema` is `unknown`).
- `createForgeTool` stringifies non-string outputs by default, which may lose structure unless consumers provide `toModelOutput`.
- Human-contact support in this folder is contract-only; delivery/resume/runtime orchestration is implemented elsewhere.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

