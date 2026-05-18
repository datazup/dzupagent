# Tools Module Architecture (`packages/core/src/tools`)

## Scope
This document describes the tools surface in `@dzupagent/core` as implemented in the current local checkout.

Primary implementation files:
- `src/tools/connector-contract.ts`
- `src/tools/create-tool.ts`
- `src/tools/permission-tier.ts`
- `src/tools/tool-governance.ts`
- `src/tools/tool-stats-tracker.ts`
- `src/tools/human-contact-types.ts`

Public entrypoints in this package:
- `src/tools.ts` (subpath barrel used by `@dzupagent/core/tools`)
- `src/index.ts` (root `@dzupagent/core` barrel that also re-exports tools APIs)

Validation and package context reviewed:
- `src/__tests__/tool-governance.test.ts`
- `src/__tests__/tool-stats-tracker.test.ts`
- `package.json` (subpath export, dependency and peer dependency surface)
- `README.md` and `docs/ARCHITECTURE.md` (package-level API positioning)

Out of scope:
- Tool execution loops and policy orchestration in other packages (for example `packages/agent` and `packages/codegen`)
- Connector-specific runtime implementations in `packages/connectors*` and `packages/scraper`
- Human-contact transport and persistence implementations outside this folder

## Responsibilities
The `src/tools` module owns shared, reusable primitives for tool definition and governance across the DzupAgent monorepo.

Current responsibilities:
- Define the canonical connector tool contract and normalization utilities.
- Provide a typed factory (`createForgeTool`) that builds LangChain structured tools from Zod input/output schemas.
- Define the canonical permission-tier vocabulary (`read-only`, `workspace-write`, `full-access`) and comparison helper.
- Enforce synchronous governance checks (block list, rate limit, validation, approval flag) and provide optional audit hooks.
- Track in-memory tool outcomes for ranking and prompt-hint generation.
- Define shared type contracts for human-in-the-loop contact requests, responses, and pending-state records.

## Structure
`src/tools/connector-contract.ts`:
- Exports `BaseConnectorTool`, `BaseConnectorToolLike`, and `BaseConnectorToolExecutionContext`.
- Exports `isBaseConnectorTool` structural guard.
- Exports normalization helpers: `normalizeBaseConnectorTool` and `normalizeBaseConnectorTools`.

`src/tools/create-tool.ts`:
- Exports `ForgeToolConfig<TInput, TOutput>`.
- Exports `ToolExecutionContext` (`signal: AbortSignal`).
- Exports `createForgeTool(...)` that wraps `@langchain/core/tools.tool(...)` and returns `StructuredToolInterface`.

`src/tools/permission-tier.ts`:
- Exports `PermissionTier` union type.
- Keeps numeric ordering private (`TIER_ORDER`).
- Exports `tierSatisfies(a, b)` for tier comparison.

`src/tools/tool-governance.ts`:
- Exports config and audit types for tool governance.
- Exports `ToolGovernance` class with in-memory rate-limit state.
- Supports result audit retention modes: `raw`, `metadata-only`, `redacted`.

`src/tools/tool-stats-tracker.ts`:
- Exports call/stat/ranking/config types.
- Exports `ToolStatsTracker` class using per-tool sliding windows.

`src/tools/human-contact-types.ts`:
- Exports request/response unions and pending-contact state.
- Defines extensible `ContactType` and `ContactChannel` unions via `(string & {})`.

Public barrels:
- `src/tools.ts` re-exports this module’s public API for `@dzupagent/core/tools`.
- `src/index.ts` mirrors the same tools exports from the root package import path.

Notable export detail:
- `BaseConnectorToolExecutionContext` is exported from `connector-contract.ts` but is not re-exported by `src/tools.ts` or `src/index.ts`.

## Runtime and Control Flow
`ToolGovernance.checkAccess(toolName, input)` runs in this fixed order:
1. Block list check (`blockedTools`).
2. Per-tool rate-limit check (`rateLimits`, tracked per minute in process memory).
3. Optional custom validator (`validator`).
4. Approval flag check (`approvalRequired`) that returns `{ allowed: true, requiresApproval: true }`.
5. Default allow.

`ToolGovernance.audit(entry)`:
- Calls `auditHandler.onToolCall(entry)` when configured.
- Swallows audit handler exceptions (non-fatal by design).

`ToolGovernance.auditResult(entry)`:
- Applies retention behavior through `prepareResultAuditEntry`.
- Calls `auditHandler.onToolResult(...)` if present.
- Swallows audit handler exceptions.

Result audit retention behavior:
- `raw` (default): forwards original output unchanged.
- `metadata-only`: sets `output` to `undefined` and attaches metadata (type, object keys, or length).
- `redacted`: replaces `output` with custom redactor output or `"[REDACTED]"`, and attaches metadata.

`ToolStatsTracker` flow:
1. `recordCall(record)` appends a call for `toolName`.
2. If list length exceeds `windowSize` (default `200`), oldest entries are evicted.
3. `getStats(toolName)` computes totals, success rate, avg latency, p95 latency, last used timestamp, and grouped top errors.
4. `getTopTools(limit?, intent?)` ranks tools using weighted score:
   - success component (`successWeight`, default `0.7`)
   - normalized speed component (`latencyWeight`, default `0.3`)
5. `formatAsPromptHint(...)` renders a numbered list string for prompt injection.

`createForgeTool(config)` flow:
1. Builds a LangChain tool with `name`, `description`, and input `schema` from config.
2. Executes `config.execute(input, { signal })` with runtime signal fallback (`new AbortController().signal`).
3. Validates output with `outputSchema.parse(result)` when configured.
4. Returns model output string in this order:
   - `config.toModelOutput(result)` if provided,
   - raw string result if already a string,
   - otherwise `JSON.stringify(result)`.

Connector contract flow:
- `isBaseConnectorTool` performs structural checks (non-empty `id`, `name`, `description`, presence of `schema`, function `invoke`).
- `normalizeBaseConnectorTool` ensures `id` is non-empty (`tool.id` or fallback to `tool.name`).
- `normalizeBaseConnectorTools` maps normalization over arrays.

Human-contact module behavior:
- `human-contact-types.ts` is type-only and has no runtime logic.

## Key APIs and Types
Connector contract:
- `BaseConnectorTool<Input, Output>`
- `BaseConnectorToolLike<Input, Output>`
- `BaseConnectorToolExecutionContext`
- `isBaseConnectorTool(value)`
- `normalizeBaseConnectorTool(tool)`
- `normalizeBaseConnectorTools(tools)`

Tool factory:
- `ForgeToolConfig<TInput, TOutput>`
- `ToolExecutionContext`
- `createForgeTool(config): StructuredToolInterface`

Permission tiers:
- `PermissionTier`
- `tierSatisfies(currentTier, requiredTier)`

Governance:
- `ToolGovernanceConfig`
- `ToolValidationResult`
- `ToolAuditHandler`
- `ToolAuditEntry`
- `ToolResultAuditEntry`
- `ToolResultAuditMetadata`
- `ToolResultAuditRetention`
- `ToolAccessResult`
- `ToolGovernance` methods: `checkAccess`, `audit`, `auditResult`, `resetRateLimits`

Stats:
- `ToolCallRecord`
- `ToolStats`
- `ToolRanking`
- `ToolStatsTrackerConfig`
- `ToolStatsTracker` methods: `recordCall`, `getStats`, `getTopTools`, `getTrackedTools`, `formatAsPromptHint`, `reset`

Human contact contracts:
- `ContactType`, `ContactChannel`
- `HumanContactRequest` union (+ concrete request variants)
- `HumanContactResponse` union (+ concrete response variants)
- `PendingHumanContact`

## Dependencies
Direct imports in the module:
- `@langchain/core/tools` (runtime, in `create-tool.ts`)
- `zod` type import (`create-tool.ts`)
- All other files use TypeScript/JS runtime primitives only.

Package-level dependency context (`packages/core/package.json`):
- Runtime dependencies: `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`, `@dzupagent/security`
- Peer dependencies relevant to this module:
  - `@langchain/core` (for `tool`/`StructuredToolInterface`)
  - `zod` (schema typing and validation)
- Build/test tooling used for this module: `typescript`, `tsup`, `vitest`

Export surface:
- Subpath export exists at `./tools` (`dist/tools.js`, `dist/tools.d.ts`).
- Equivalent tools symbols are also exposed on the root `@dzupagent/core` export path.

## Integration Points
Inside `packages/core`:
- `src/tools.ts` defines the public `@dzupagent/core/tools` entrypoint.
- `src/index.ts` mirrors tools exports for root imports.
- `src/events/event-types-agent.ts` imports `PermissionTier` for event typing (`agent:tools-filtered`).

Observed consumers in other workspace packages:
- `packages/agent`:
  - Uses `ToolGovernance` in tool-loop and policy flows.
  - Uses `PermissionTier` and `tierSatisfies` for tier filtering.
  - Uses human-contact types in approval and contact-tool flows.
  - Maintains a deprecated bridge re-export for `createForgeTool`.
- `packages/connectors`, `packages/connectors-browser`, `packages/connectors-documents`, `packages/scraper`:
  - Depend on the canonical connector contract types and normalization helpers.
  - Use `createForgeTool` to construct tool instances.
- `packages/codegen`:
  - Re-exports/consumes canonical `PermissionTier` from `@dzupagent/core/tools`.
  - Uses `ToolGovernance` via governance adapter types.
- `packages/testing`:
  - Includes export checks for `@dzupagent/core/tools` subpath availability.

## Testing and Observability
Direct test coverage in `packages/core`:
- `src/__tests__/tool-governance.test.ts` covers:
  - default allow behavior
  - blocked tools
  - approval-required flagging
  - rate-limit enforcement and reset
  - custom validator integration
  - audit callback invocation
  - result retention modes (`raw`, `metadata-only`, `redacted`)
  - non-fatal audit handler failures
  - per-tool rate-limit isolation
- `src/__tests__/tool-stats-tracker.test.ts` covers:
  - empty-state behavior
  - stats aggregation and success/failure accounting
  - p95 and average latency calculations
  - ranking and weighting behavior
  - `limit` and `intent` filtering
  - sliding-window eviction
  - prompt-hint formatting
  - error-type aggregation
  - reset semantics

No direct tests in `packages/core/src/__tests__` currently target:
- `connector-contract.ts`
- `create-tool.ts`
- `permission-tier.ts`
- `human-contact-types.ts` (type-only)

Observability hooks provided by this module:
- `ToolGovernance.audit(...)` and `ToolGovernance.auditResult(...)` callback hooks.
- Audit-result metadata projection through `ToolResultAuditMetadata`.
- `ToolStatsTracker` as pull-based in-memory telemetry (no built-in persistence or event emitter).

## Risks and TODOs
- `ToolGovernanceConfig.maxExecutionMs` exists but `ToolGovernance` does not enforce execution timeouts; enforcement is delegated to callers.
- Rate-limit counters are process-local memory and reset on restart.
- Rate-limit checks occur before custom validator checks, so invalid attempts can still consume rate budget.
- `isBaseConnectorTool` performs structural checks only; it does not validate schema semantics.
- `createForgeTool` uses `JSON.stringify` fallback for non-string outputs, which may flatten structured content unless `toModelOutput` is supplied.
- `ToolStatsTracker` state is memory-only and not persisted across runs.
- Human-contact contracts are type-level only; channel delivery, timeout handling, and run-resume lifecycle behavior are implemented elsewhere.
- `BaseConnectorToolExecutionContext` is not exposed from the public barrels (`@dzupagent/core/tools` or root `@dzupagent/core`).

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js