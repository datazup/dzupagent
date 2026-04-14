# Approval Module Architecture (`packages/agent/src/approval`)

## Scope

This folder implements a small, event-driven human-approval gate for agent workflows:

- `approval-types.ts`: public types (`ApprovalMode`, `ApprovalConfig`, `ApprovalResult`)
- `approval-gate.ts`: runtime gate implementation (`ApprovalGate`)
- `index.ts`: local barrel exports

The gate is designed to pause execution until a matching approval decision is received on `DzupEventBus`.

## Public API

### Types

- `ApprovalMode = 'auto' | 'required' | 'conditional'`
- `ApprovalResult = 'approved' | 'rejected' | 'timeout'`
- `ApprovalConfig`
  - `mode`: required mode selector
  - `condition?`: predicate used only in `conditional` mode
  - `timeoutMs?`: timeout before auto-rejecting
  - `webhookUrl?`: optional notification endpoint

### Class

- `ApprovalGate(config, eventBus)`
- `waitForApproval(runId, plan, ctx?) => Promise<ApprovalResult>`

## Features and Behavior

### 1) Mode-based decision policy

- `auto`: immediately returns `'approved'`
- `required`: always emits `approval:requested` and waits
- `conditional`: evaluates `config.condition(plan, ctx)` when both `condition` and `ctx` are provided
  - returns `'approved'` if condition resolves `false`
  - otherwise enters the same waiting flow as `required`

### 2) Event-driven handshake

For non-auto paths, the gate:

1. emits `approval:requested` with `{ runId, plan }`
2. waits for:
   - `approval:granted` for the same `runId` -> resolves `'approved'`
   - `approval:rejected` for the same `runId` -> resolves `'rejected'`
3. ignores events for other runs

### 3) Timeout and auto-rejection

If `timeoutMs` is configured and no decision arrives in time:

- emits `approval:rejected` with timeout reason
- resolves `'timeout'`

### 4) Optional webhook notification

If `webhookUrl` is configured:

- non-blocking `fetch()` `POST` is fired with payload:
  - `{ type: 'approval_requested', runId, plan }`
- webhook failures are intentionally swallowed (best effort)

## Control Flow

```text
waitForApproval(runId, plan, ctx?)
  -> mode === auto ? approved : continue
  -> mode === conditional && condition && ctx
       -> needsApproval = await condition(plan, ctx)
       -> !needsApproval ? approved : continue
  -> emit approval:requested(runId, plan)
  -> fire-and-forget webhook (optional)
  -> subscribe to approval:granted + approval:rejected
  -> resolve on matching runId event
  -> or timeout => emit approval:rejected(timeout reason), resolve timeout
```

## Usage Examples

### Example A: Required approval around a sensitive step

```ts
import { createEventBus } from '@dzupagent/core'
import { ApprovalGate } from '@dzupagent/agent'

const eventBus = createEventBus()
const gate = new ApprovalGate({ mode: 'required', timeoutMs: 60_000 }, eventBus)

// Somewhere else (UI/API/admin worker), publish decision:
setTimeout(() => {
  eventBus.emit({ type: 'approval:granted', runId: 'run-42', approvedBy: 'operator-1' })
}, 500)

const result = await gate.waitForApproval('run-42', { action: 'deploy', target: 'prod' })
if (result !== 'approved') throw new Error(`Blocked by approval gate: ${result}`)
```

### Example B: Conditional policy from hook context metadata

```ts
import type { HookContext } from '@dzupagent/core'
import { ApprovalGate } from '@dzupagent/agent'

const gate = new ApprovalGate(
  {
    mode: 'conditional',
    timeoutMs: 30_000,
    condition: async (plan, ctx: HookContext) => {
      const meta = ctx.metadata as Record<string, unknown>
      const risk = typeof meta['risk'] === 'string' ? meta['risk'] : 'low'
      return risk === 'high'
    },
  },
  eventBus,
)
```

### Example C: Recovery copilot integration (already implemented)

`RecoveryExecutor` uses `ApprovalGate` for high-risk strategies only, when:

- `strategy.risk === 'high'`
- `copilotConfig.requireApprovalForHighRisk === true`
- `approvalGate` is configured

See:

- `packages/agent/src/recovery/recovery-executor.ts`
- `packages/agent/src/recovery/recovery-copilot.ts`

## References in Other Packages and Usage

## Direct code reuse

- There are no direct imports of `ApprovalGate` from `@dzupagent/agent` in other packages in this monorepo.
- Cross-package interoperability is primarily through the shared event contract (`approval:*` events in `@dzupagent/core`).

## Event-contract consumers

- `packages/core/src/events/event-types.ts`
  - defines canonical approval events:
    - `approval:requested`
    - `approval:granted`
    - `approval:rejected`

- `packages/server/src/runtime/run-worker.ts`
  - implements a run-level approval wait loop for agents configured with `approval: 'required'`
  - emits `approval:requested`
  - waits for `approval:granted` / `approval:rejected`

- `packages/server/src/routes/approval.ts`
  - HTTP endpoints emit `approval:granted` and `approval:rejected`
  - practical bridge from user/API action to event bus decisions

- `packages/otel/src/event-metric-map/approval.ts`
  - maps approval events to metric `forge_approval_requests_total` with status label

- `packages/otel/src/audit-trail.ts`
  - maps approval events into audit category `approval_action`

- `packages/server/src/notifications/notifier.ts`
  - classifies `approval:requested` as `human-required` + `critical`

- `packages/server/src/cli/trace-printer.ts`
  - renders approval events in CLI traces/log output

- `packages/agent-adapters/src/recovery/adapter-recovery.ts`
  - emits `approval:requested` for adapter recovery escalation scenarios

## Related but separate implementation

- `packages/agent-adapters/src/approval/adapter-approval.ts`
  - has its own `AdapterApprovalGate` with richer features (audit store, cost-based auto-approval, SSRF-aware URL validation)
  - uses the same `approval:*` event vocabulary, but is not this module

## Test Coverage

## Unit and integration tests directly validating this module behavior

- `packages/agent/src/__tests__/approval-gate.test.ts` (9 tests)
  - auto mode immediate approval
  - required mode grant/reject waits
  - ignores unrelated run IDs
  - timeout behavior
  - conditional mode pass/require behavior
  - `approval:requested` emission
  - webhook invocation

- `packages/agent/src/__tests__/recovery-executor.test.ts` (approval-related scenarios)
  - high-risk strategy waits for approval
  - rejection skips execution
  - low/medium risk bypasses approval gate

## Cross-package tests validating event compatibility

- `packages/server/src/__tests__/run-worker.test.ts`
  - required-approval run completes on grant
  - required-approval run moves to rejected on reject

- `packages/otel/src/__tests__/otel-bridge.test.ts`
  - approval metrics counters for requested/granted/rejected

- `packages/otel/src/__tests__/audit-trail.test.ts`
  - approval events mapped into audit trail entries

- `packages/otel/src/__tests__/event-metric-map.test.ts`
  - validates extractors include approval event shapes

## Measured file-level coverage (targeted run)

Executed:

- `yarn workspace @dzupagent/agent test:coverage src/__tests__/approval-gate.test.ts src/__tests__/recovery-executor.test.ts`

Observed for this module:

- `packages/agent/src/approval/approval-gate.ts`
  - statements: `99.06%`
  - branches: `95.23%`
  - functions: `100%`
  - lines: `99.06%`
  - uncovered line reported: line 52 (webhook failure catch path)

Note:

- the coverage command exited non-zero due package-level global thresholds against untouched files, but module-local approval coverage is effectively complete.

## Operational Notes and Nuances

- `conditional` mode only evaluates `condition` when both `condition` and `ctx` are present. If `ctx` is omitted, it falls through to full approval wait.
- Timeout emits `approval:rejected` for observability parity and then returns `'timeout'`.
- Webhook is best-effort and does not currently validate URL, enforce allowlists, or verify HTTP response status before proceeding.

