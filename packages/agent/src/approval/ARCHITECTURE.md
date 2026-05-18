# Approval Architecture (`packages/agent/src/approval`)

## Scope
This document covers the approval subsystem in `packages/agent/src/approval`:

- `approval-gate.ts`
- `approval-types.ts`
- `approval-errors.ts`
- `index.ts`

It describes the runtime behavior of `ApprovalGate`, durable approval suspension/resume contracts, webhook delivery behavior, and package integration points. It does not describe the tool-loop governance stop path in `src/agent/tool-loop/*`, which emits `approval:requested` independently and halts with `stopReason: 'approval_pending'`.

## Responsibilities
The approval module provides a human-in-the-loop gate with two execution styles:

- synchronous in-process wait (`waitForApproval`)
- durable suspension and out-of-process resume (`requestApproval` + `resume`)

Core responsibilities:

- define approval configuration, result, and durable state contracts
- emit approval request and terminal decision telemetry on `DzupEventBus`
- support approval-required gating modes: `auto`, `required`, `conditional`
- publish structured `ApprovalRequest` payloads for tracing and contact tooling
- optionally send signed approval webhooks with retry and dead-letter callback
- support abort-driven cancellation and bounded timeout behavior by default
- persist/load/delete pending approval state when durable resume is configured

## Structure
- `approval-types.ts`
- mode/result/config types (`ApprovalMode`, `ApprovalResult`, `ApprovalConfig`)
- timeout and durable constants (`DEFAULT_APPROVAL_TIMEOUT_MS`, `APPROVAL_PENDING_KEY`)
- durable state interfaces (`ApprovalPendingState`, `ApprovalCheckpointStore`)
- durable entrypoint payloads (`ApprovalRequestInput`, `ApprovalDecision`)
- `approval-errors.ts`
- `ApprovalSuspendedError` (carries `resumeToken` and `runId`)
- `approval-gate.ts`
- `ApprovalGate` class
- public methods: `waitForApproval`, `requestApproval`, `resume`, `loadPending`
- internal helpers: timeout selection, webhook delivery/signing, abort reason parsing
- `index.ts`
- local submodule barrel re-exporting `ApprovalGate` plus a minimal type subset (`DEFAULT_APPROVAL_TIMEOUT_MS`, `ApprovalConfig`, `ApprovalMode`, `ApprovalResult`, `ApprovalWaitOptions`)

Note: broader approval exports (durable types, `APPROVAL_PENDING_KEY`, and `ApprovalSuspendedError`) are exposed from the package root barrel (`src/index.ts`), not from `src/approval/index.ts`.

## Runtime and Control Flow
`ApprovalGate` has two runtime paths:

1. In-process wait path (`waitForApproval`).
2. Durable suspend/resume path (`requestApproval` + `resume`) when `durableResume === true` and `checkpointStore` is provided.

In-process path (`waitForApproval`):

1. Evaluate mode.
2. `auto` returns `'approved'` immediately.
3. `conditional` evaluates `condition(plan, ctx)` only if both `condition` and `ctx` exist; when condition resolves `false`, returns `'approved'`.
4. all other cases continue into approval request flow.
5. Build `ApprovalRequest`.
6. generate `contactId` via `randomUUID()`
7. set channel from config or default `'in-app'`
8. compute `timeoutAt` from effective timeout
9. map plan into request data:
10. string plan -> `data.question = plan`
11. non-string plan -> `data.question = 'Approve this action?'` and `data.context = safeJsonStringify(plan)`
12. If caller signal is already aborted, emit `approval:cancelled` and return `'cancelled'`.
13. Emit `approval:requested` with `runId`, original `plan`, `contactId`, `channel`, and `request`.
14. If `webhookUrl` exists, trigger asynchronous webhook notification.
15. Subscribe for matching decision events by `runId`.
16. `approval:granted` -> resolve `'approved'`
17. `approval:rejected` -> resolve `'rejected'`
18. Register abort listener (if signal provided).
19. on abort: cleanup listeners/timer, emit `approval:cancelled`, resolve `'cancelled'`
20. If timeout applies and expires first:
21. emit `approval:timed_out`
22. resolve `'timeout'`

Effective timeout behavior:

- uses explicit `config.timeoutMs` when provided
- when `timeoutMs` is omitted and `durableResume` is `false` or unset, defaults to `DEFAULT_APPROVAL_TIMEOUT_MS` (`300_000`)
- when `timeoutMs` is omitted and `durableResume` is `true`, no in-process timeout is applied

Durable path (`requestApproval` + `resume`):

1. `requestApproval` checks for durable configuration (`durableResume === true` and `checkpointStore` present).
2. If enabled:
3. creates `ApprovalPendingState` with `runId`, `contactId`, `plan`, `channel`, `requestedAt`, `timeoutAt`, `resumeToken`
4. saves it under key `APPROVAL_PENDING_KEY`
5. emits `approval:requested` (without blocking in-process wait)
6. throws `ApprovalSuspendedError(resumeToken, runId)` so outer runtime can pause
7. If not enabled, falls back to `waitForApproval`.
8. `resume(runId, decision)`:
9. loads pending state from store; throws if missing
10. deletes pending state
11. emits `approval:granted` or `approval:rejected` (with optional reason)
12. `loadPending(runId)` is a read-only helper for external resumers.

Webhook delivery behavior (`notifyWebhook`):

- outbound request uses `fetchWithOutboundUrlPolicy` with optional `webhookOutboundUrlPolicy`
- request body includes `type`, `runId`, `plan`, `contactId`, and `channel`
- retries up to 3 attempts with jittered backoff (`100ms`, `300ms`, `900ms`)
- optional signature headers when `webhookSigningSecret` is configured:
- `X-DzupAgent-Timestamp`
- `X-DzupAgent-Signature` as `sha256=<hex>` over `${timestamp}.${body}`
- after terminal failure:
- emits `approval:webhook_failed`
- invokes optional `webhookDLQ(runId, webhookUrl, error)` and suppresses DLQ callback errors

## Key APIs and Types
Primary class:

- `ApprovalGate(config: ApprovalConfig, eventBus: DzupEventBus)`
- `waitForApproval(runId: string, plan: unknown, ctx?: HookContext, options?: ApprovalWaitOptions): Promise<ApprovalResult>`
- `requestApproval(input: ApprovalRequestInput, ctx?: HookContext, options?: ApprovalWaitOptions): Promise<ApprovalResult>`
- `resume(runId: string, decision: ApprovalDecision): Promise<void>`
- `loadPending(runId: string): Promise<ApprovalPendingState | null>`

Durable and config contracts:

- `ApprovalConfig`
- `mode: 'auto' | 'required' | 'conditional'`
- `condition?: (plan, ctx) => boolean | Promise<boolean>`
- `timeoutMs?: number`
- `durableResume?: boolean`
- `checkpointStore?: ApprovalCheckpointStore`
- `webhookUrl?: string`
- `webhookSigningSecret?: string`
- `webhookOutboundUrlPolicy?: OutboundUrlSecurityPolicy`
- `webhookDLQ?: (runId, webhookUrl, error) => void | Promise<void>`
- `channel?: ContactChannel`
- `ApprovalCheckpointStore`
- `save(runId, key, state)`
- `load(runId, key)`
- `delete(runId, key)`
- `ApprovalPendingState`
- persisted payload for suspended approvals, including `resumeToken` and optional `timeoutAt`
- `ApprovalRequestInput`
- `{ runId, plan, contactId?, channel? }`
- `ApprovalDecision`
- `{ decision: 'approved' | 'rejected', reason? }`
- `ApprovalSuspendedError`
- thrown by durable path to force explicit run suspension/resume

Event contract used by this module:

- emitted: `approval:requested`, `approval:timed_out`, `approval:cancelled`, `approval:webhook_failed`
- consumed: `approval:granted`, `approval:rejected`

## Dependencies
Direct imports used by `src/approval/*`:

- Node built-ins
- `node:crypto` (`randomUUID`, `createHmac`)
- `@dzupagent/core`
- events/types: `DzupEventBus`, `HookContext`
- security: `fetchWithOutboundUrlPolicy`, `OutboundUrlSecurityPolicy`
- tool types: `ApprovalRequest`, `ContactChannel`
- local helper
- `../utils/exact-optional.js` (`omitUndefined`)

Package-level context:

- module is part of `@dzupagent/agent` and has no external runtime dependency beyond package dependencies already declared in `packages/agent/package.json`

## Integration Points
Runtime integrations inside `packages/agent`:

- `src/recovery/recovery-executor.ts`
- optional `approvalGate` is used to gate high-risk recovery strategies via `waitForApproval`
- `src/recovery/recovery-copilot.ts`
- wires optional `approvalGate` into `RecoveryExecutor`
- `src/agent/run-engine.ts`
- catches `ApprovalSuspendedError` and converts it to `GenerateResult` with `stopReason: 'approval_pending'` and `suspended: { runId, resumeToken }`
- persists run snapshot with `terminalReason: 'approval_pending'` when `runStateStore` exists

Export surfaces:

- package root (`src/index.ts`) exports full approval API, including durable types and `ApprovalSuspendedError`
- `@dzupagent/agent/agent` subpath currently exports only the basic approval surface (`ApprovalGate`, `ApprovalConfig`, `ApprovalMode`, `ApprovalResult`, `ApprovalWaitOptions`, `DEFAULT_APPROVAL_TIMEOUT_MS`)

Separate but related flow:

- tool governance (`src/agent/tool-loop/policy-checks.ts`) emits `approval:requested` and returns `approvalPending` without invoking `ApprovalGate`
- consumers must distinguish:
- blocking wait semantics from `ApprovalGate`
- loop halt semantics (`stopReason: 'approval_pending'`) from tool governance

## Testing and Observability
Test coverage in scope:

- `src/__tests__/approval-gate.test.ts`
- core mode semantics, grant/reject/timeout paths
- webhook invocation, webhook signing headers
- retry behavior and `approval:webhook_failed` emission
- `webhookDLQ` callback on terminal failure
- `src/__tests__/approval-gate-deep.test.ts`
- conditional edge cases and context requirements
- request payload shape (`contactId`, `channel`, `request`, `timeoutAt`)
- cancellation via `AbortSignal`
- default timeout behavior and durable no-timeout behavior
- concurrent runId correlation behavior
- `src/__tests__/approval-gate-durable.test.ts`
- durable checkpoint persistence
- suspension via `ApprovalSuspendedError`
- resume and pending-state cleanup for approve/reject decisions
- fallback to legacy wait path when no checkpoint store exists
- `src/__tests__/recovery-executor.test.ts`
- recovery integration with high-risk approval gating

Observability characteristics:

- all approval decisions and lifecycle milestones are event-bus driven
- emitted telemetry includes cancellation reason, timeout duration, and webhook failure metadata (`webhookUrl`, `attempts`, `error`)
- durable suspension emits a typed error (`ApprovalSuspendedError`) that upstream runtimes convert into resumable run state

## Risks and TODOs
- `conditional` mode skips condition evaluation when `ctx` is missing, which can unintentionally force approval waits if callers forget to pass context.
- Durable mode depends on caller-provided `ApprovalCheckpointStore`; this module does not provide a production store implementation.
- `resume()` does not enforce `resumeToken` validation; authorization and replay protection must be handled by the caller-facing resume endpoint/service.
- Durable `requestApproval` emits `approval:requested` without including a structured `request` payload (unlike `waitForApproval`), so downstream consumers must tolerate that shape difference.
- Both `ApprovalGate` and tool governance emit `approval:requested`; mixed consumers need explicit correlation and source-aware handling.
- Each in-process wait allocates timer/listener state; very high concurrency can increase event/listener pressure.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: rewritten to match current `approval-gate` durable suspend/resume API, signed webhook retry behavior, expanded exports, and test coverage.
