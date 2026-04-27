# Approval Architecture (`packages/agent/src/approval`)

## Scope
This document covers the approval subsystem in `packages/agent/src/approval`:

- `approval-types.ts`
- `approval-gate.ts`
- `index.ts`

It describes the runtime behavior of `ApprovalGate`, its event contract usage, and how this module is consumed inside `@dzupagent/agent`. This is not the same as tool-loop governance gating in `src/agent/tool-loop.ts`; that path emits approval events directly and does not invoke `ApprovalGate`.

## Responsibilities
The approval module provides a focused human-in-the-loop gate:

- define approval configuration and result types
- decide whether approval is needed (`auto`, `required`, `conditional`)
- publish a structured approval request event on `DzupEventBus`
- optionally notify an external webhook about the approval request
- wait for matching `approval:granted` or `approval:rejected` events
- enforce optional timeout behavior and emit timeout-driven rejection telemetry

## Structure
- `approval-types.ts`
  - `ApprovalMode = 'auto' | 'required' | 'conditional'`
  - `ApprovalConfig` with `mode`, optional `condition`, optional `timeoutMs`, optional `webhookUrl`, optional `channel`
  - `ApprovalResult = 'approved' | 'rejected' | 'timeout'`
- `approval-gate.ts`
  - `ApprovalGate` class
  - `waitForApproval(runId, plan, ctx?)`
  - internal `notifyWebhook(...)`
- `index.ts`
  - re-exports `ApprovalGate` and approval types

## Runtime and Control Flow
1. `waitForApproval` checks mode.
   - `auto`: returns `'approved'` immediately.
   - `required`: always continues to request/wait flow.
   - `conditional`: evaluates `condition(plan, ctx)` only when both `condition` and `ctx` are present. If it resolves `false`, returns `'approved'`; otherwise continues to request/wait flow.
2. For non-auto paths, it builds an `ApprovalRequest` payload:
   - generates `contactId` via `randomUUID()`
   - sets `channel` to configured value or `'in-app'`
   - computes `timeoutAt` from `timeoutMs` when configured
   - maps `plan` into request data:
     - string plan -> `data.question = <plan>`
     - non-string plan -> default question plus JSON-stringified context
3. Emits `approval:requested` with `{ runId, plan, contactId, channel, request }`.
4. If `webhookUrl` is configured, calls `notifyWebhook` in fire-and-forget mode.
   - failures are swallowed and never block approval flow
5. Subscribes to:
   - `approval:granted` with matching `runId` -> resolves `'approved'`
   - `approval:rejected` with matching `runId` -> resolves `'rejected'`
6. If `timeoutMs` is set and no decision arrives in time:
   - emits `approval:rejected` with timeout reason
   - resolves `'timeout'`
7. On resolve, listeners are unsubscribed for the current waiter.

## Key APIs and Types
- `ApprovalGate`
  - constructor: `(config: ApprovalConfig, eventBus: DzupEventBus)`
  - method: `waitForApproval(runId: string, plan: unknown, ctx?: HookContext): Promise<ApprovalResult>`
- `ApprovalConfig`
  - `mode: ApprovalMode`
  - `condition?: (plan: unknown, ctx: HookContext) => boolean | Promise<boolean>`
  - `timeoutMs?: number`
  - `webhookUrl?: string`
  - `channel?: ContactChannel`
- `ApprovalMode`
  - `'auto' | 'required' | 'conditional'`
- `ApprovalResult`
  - `'approved' | 'rejected' | 'timeout'`

Event payload expectations come from `@dzupagent/core` (`DzupEvent` union):

- `approval:requested` supports `runId`, `plan`, optional `contactId`, optional `channel`, optional `request`
- `approval:granted` supports `runId`, optional `approvedBy`
- `approval:rejected` supports `runId`, optional `reason`

## Dependencies
Direct dependencies in this module:

- Node built-in:
  - `node:crypto` (`randomUUID`)
- `@dzupagent/core` types:
  - `DzupEventBus`
  - `HookContext`
  - `ApprovalRequest`
  - `ContactChannel`
- Runtime global:
  - `fetch` for webhook notification

No additional libraries are imported directly by `src/approval/*`.

## Integration Points
Inside `@dzupagent/agent`:

- package root exports from `src/index.ts` expose `ApprovalGate`, `ApprovalConfig`, `ApprovalMode`, `ApprovalResult`
- `src/recovery/recovery-executor.ts` optionally uses `ApprovalGate` for high-risk recovery strategies when `requireApprovalForHighRisk` is enabled
- `src/recovery/recovery-copilot.ts` carries `approvalGate?: ApprovalGate` in its wiring

Related but separate approval path:

- `src/agent/tool-loop.ts` contains governance-level approval gating for tool calls
- this path emits `approval:requested` and halts with `stopReason: 'approval_pending'`
- it does not call `ApprovalGate.waitForApproval`; resume is managed by higher-level runtime control

## Testing and Observability
Primary tests in `packages/agent`:

- `src/__tests__/approval-gate.test.ts`
  - mode behavior (`auto`, `required`, `conditional`)
  - run-id matching and timeout handling
  - `approval:requested` emission
  - webhook invocation path
- `src/__tests__/approval-gate-deep.test.ts`
  - conditional edge cases (missing condition, missing context)
  - event payload shape (`contactId`, `channel`, `request`, `timeoutAt`)
  - timeout rejection event emission
  - webhook failure non-blocking behavior
  - concurrent approvals with run-id correlation
- `src/__tests__/recovery-executor.test.ts`
  - integration with recovery execution for high-risk strategy approvals

Observability characteristics:

- approval decisions are fully event-driven through `DzupEventBus`
- timeout emits a concrete `approval:rejected` event before returning `'timeout'`
- approval request payload includes `contactId` and optional structured request metadata for downstream tracing

## Risks and TODOs
- `conditional` mode currently requires `ctx` to evaluate `condition`; if callers omit `ctx`, flow falls through to full approval wait. This is intentional in code but easy to misconfigure.
- webhook delivery is best-effort:
  - no response status validation
  - no retry/backoff
  - no URL allowlist or SSRF guard at this layer
- this module and tool-loop governance both emit `approval:requested`; consumers must distinguish whether they expect a blocking waiter (`ApprovalGate`) or a suspended run (`approval_pending`) flow.
- timeout uses `setTimeout` per wait call; large concurrent waits can increase timer/listener volume.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: rewritten to reflect current `src/approval` runtime, event payloads, recovery integration, and approval-related test coverage.

