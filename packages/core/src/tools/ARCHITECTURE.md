# Tools Module Architecture (`packages/core/src/tools`)

## Scope
This document covers the tools module implemented in `packages/core/src/tools`:
- `connector-contract.ts`
- `tool-stats-tracker.ts`
- `tool-governance.ts`
- `human-contact-types.ts`

The scope is limited to code in `packages/core` and its public exports from `src/index.ts`.

## Responsibilities
The module provides shared tool-layer primitives, not a full tool runtime:
- Define a canonical connector tool contract (`BaseConnectorTool`) plus normalization/type-guard helpers.
- Provide in-memory tool performance tracking and ranking (`ToolStatsTracker`).
- Provide policy gating and audit hooks around tool invocation decisions (`ToolGovernance`).
- Define typed request/response contracts for human-in-the-loop contact workflows (`human-contact-types`).

## Structure
| File | Purpose | Main exports |
| --- | --- | --- |
| `connector-contract.ts` | Canonical shape for connector tools and normalization helpers | `BaseConnectorTool`, `isBaseConnectorTool`, `normalizeBaseConnectorTool`, `normalizeBaseConnectorTools` |
| `tool-stats-tracker.ts` | In-memory tool outcome tracker with ranking and prompt-hint formatting | `ToolStatsTracker`, `ToolCallRecord`, `ToolStats`, `ToolRanking`, `ToolStatsTrackerConfig` |
| `tool-governance.ts` | Synchronous governance checks (blocklist, rate limit, validator, approval flag) and audit callbacks | `ToolGovernance`, `ToolGovernanceConfig`, `ToolValidationResult`, `ToolAuditHandler`, `ToolAuditEntry`, `ToolResultAuditEntry`, `ToolAccessResult` |
| `human-contact-types.ts` | Shared type contracts for approval/clarification/input/escalation flows | `ContactType`, `ContactChannel`, request/response unions, `PendingHumanContact` |

## Runtime and Control Flow
`ToolGovernance.checkAccess(toolName, input)` executes checks in fixed order:
1. Blocked tool check (`blockedTools`).
2. Per-tool rate limit check (`rateLimits`) using a 60-second window in `rateCounts`.
3. Custom validator check (`validator`).
4. Approval-required tagging (`approvalRequired`) with `requiresApproval: true`.
5. Default allow.

Audit flow is explicit and opt-in by caller:
1. Caller invokes `audit(entry)` before/around execution.
2. Caller invokes `auditResult(entry)` after execution.
3. Exceptions thrown by audit handlers are swallowed to keep auditing non-fatal.

`ToolStatsTracker` flow:
1. `recordCall(record)` appends to per-tool history.
2. Sliding window eviction trims oldest records beyond `windowSize` (default `200`).
3. `getStats(toolName)` computes aggregate metrics from retained history.
4. `getTopTools(limit?, intent?)` computes weighted ranking:
   - `score = successRate * successWeight + normalizedSpeed * latencyWeight`
   - `normalizedSpeed = clamp(1 - avgLatency / maxAvgLatency, 0..1)`
5. `formatAsPromptHint(limit?, intent?)` returns either `''` or a numbered list headed by `Preferred tools for this task:`.

`connector-contract` flow:
1. `isBaseConnectorTool(value)` validates shape (`id/name/description/schema/invoke`).
2. `normalizeBaseConnectorTool(tool)` fills `id` from `name` when missing/blank and preserves `toModelOutput` when provided.
3. `normalizeBaseConnectorTools(tools)` maps array normalization over all entries.

`human-contact-types` is type-only (no runtime implementation):
- Models request lifecycle (`HumanContactRequest`) and response lifecycle (`HumanContactResponse`) for contact modes such as `approval`, `clarification`, `input_request`, and `escalation`.

## Key APIs and Types
`BaseConnectorTool<Input, Output>`:
- Required: `id`, `name`, `description`, `schema`, `invoke(input)`.
- Optional: `toModelOutput(output)`.

`ToolGovernanceConfig`:
- `blockedTools?: string[]`
- `approvalRequired?: string[]`
- `rateLimits?: Record<string, number>`
- `maxExecutionMs?: number` (declared in config, not enforced by current class)
- `validator?: (toolName, input) => ToolValidationResult`
- `auditHandler?: ToolAuditHandler`

`ToolAccessResult`:
- `allowed: boolean`
- `reason?: string`
- `requiresApproval?: boolean`

`ToolCallRecord`:
- `toolName`, `success`, `durationMs`, `timestamp`
- Optional: `intent`, `errorType`

`ToolStats`:
- `totalCalls`, `successCount`, `failureCount`, `successRate`
- `avgDurationMs`, `p95DurationMs`, `lastUsed`
- `topErrors` grouped by `errorType`

`ToolStatsTrackerConfig` defaults:
- `windowSize = 200`
- `successWeight = 0.7`
- `latencyWeight = 0.3`

`human-contact-types` contracts:
- Extensible unions via `(string & {})` for `ContactType` and `ContactChannel`.
- Request union: `ApprovalRequest | ClarificationRequest | InputRequest | EscalationRequest | GenericContactRequest`.
- Response union: `ApprovalResponse | ClarificationResponse | InputResponse | EscalationResponse | TimeoutResponse | LateResponse | GenericContactResponse`.
- `PendingHumanContact` captures stored pending state plus delivery status.

## Dependencies
Direct dependencies in `src/tools/*.ts`:
- No runtime external package imports.
- Uses built-in JS/TS primitives (`Map`, arrays, `Date.now`, object checks, string checks).

Package-level context from `package.json`:
- Build/test toolchain includes `typescript`, `tsup`, `vitest`.
- Public shipping surface is generated from entrypoints in `tsup.config.ts`; tools are surfaced through `src/index.ts` and therefore available in root and `advanced` entrypoints.

## Integration Points
In-package integration points:
- Root export barrel re-exports all tools symbols from `src/index.ts`.
- `src/advanced.ts` re-exports `src/index.ts`, so tools are also available via `@dzupagent/core/advanced`.
- `src/stable.ts` exports only facades; tools symbols are not exposed through the stable facade-only entrypoint.

Observed usage in `packages/core`:
- Runtime usage outside `src/tools` is not present in non-test code.
- Primary in-repo consumption is through direct unit tests.

Documentation linkage:
- `packages/core/docs/ARCHITECTURE.md` references `ToolGovernance` as an extensibility point.

## Testing and Observability
Direct tests for this module:
- `src/__tests__/tool-governance.test.ts`
- `src/__tests__/tool-stats-tracker.test.ts`

What is covered:
- Governance default allow path, blocklist, approval flagging, per-tool rate limits, validator behavior, audit callback invocation, non-fatal audit errors, and rate-limit reset behavior.
- Stats tracker empty-state behavior, aggregate metrics, ranking, intent filtering, window eviction, prompt formatting, error aggregation, and reset/config behavior.

Current gaps:
- No dedicated tests in `packages/core/src/__tests__` for `connector-contract.ts`.
- No dedicated tests in `packages/core/src/__tests__` for `human-contact-types.ts` (type-only declarations).

Observability characteristics:
- `ToolGovernance` provides callback hooks (`auditHandler`) for external audit/telemetry sinks.
- `ToolStatsTracker` provides pull-based analytics (`getStats`, `getTopTools`, `formatAsPromptHint`) but does not emit events or metrics itself.

## Risks and TODOs
- `ToolGovernanceConfig.maxExecutionMs` is currently declarative only; execution timeout enforcement must be implemented by callers.
- Rate-limit counters are in-memory process state and reset on restart.
- `checkAccess` applies rate-limit checks before custom validation, so denied validations still consume rate-limit budget.
- `ToolStatsTracker` is in-memory only and has no built-in persistence/export mechanism.
- Ranking does not enforce weight normalization; unusual `successWeight`/`latencyWeight` values can produce non-intuitive scores.
- `connector-contract` uses structural checks only; `schema` is accepted as `unknown` and not validated.
- `human-contact-types` defines contracts but no runtime resolver/transport implementation in this folder.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js