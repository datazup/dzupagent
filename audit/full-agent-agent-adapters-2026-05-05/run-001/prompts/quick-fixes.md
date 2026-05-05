# Quick Fixes (P1 — 1-2h each)

All prompts below are self-contained. Validate each with the listed command before marking done.

---

## QF-01: Add `agent:rate_limited` to DzupEvent union [CODE-001, AGENT-001/H-05]
**Target agent:** dzupagent-core-dev

Add `{ type: 'agent:rate_limited'; agentId: string; reason: string }` to the `DzupEvent` discriminated union in `packages/core/src/events/event-types.ts`. Then remove the `as never` cast at `packages/agent/src/agent/dzip-agent.ts:730`.

Also remove the `as never` cast at `packages/agent-adapters/src/registry/adapter-registry.ts:740-748` by adding the `agent:completed-with-usage` extension fields to the appropriate DzupEvent member (or by declaring a new `agent:completed_with_usage` variant).

**Acceptance:** `yarn typecheck --filter=@dzupagent/core && yarn typecheck --filter=@dzupagent/agent && yarn typecheck --filter=@dzupagent/agent-adapters` all pass. Zero `as never` casts at the two specified locations.

**Validate:** `grep -n "as never" packages/agent/src/agent/dzip-agent.ts packages/agent-adapters/src/registry/adapter-registry.ts`

---

## QF-02: Fix `workspace-write` sandbox mode in Claude adapter [AGENT-054/H-01]
**Target agent:** dzupagent-connectors-dev

In `packages/agent-adapters/src/claude/claude-adapter.ts:127-141`, the `mapSandboxMode('workspace-write')` case returns `'bypassPermissions'` — same as `'full-access'`. This is a security defect.

Fix: Map `'workspace-write'` to either a Claude SDK permission profile that scopes writes to `process.cwd()` without allowing shell/network, or add clear documentation that the mode degrades gracefully. If the Claude SDK has no granular mode, route `workspace-write` to `default` + `allowedTools: ['write_file']` style config and document the behavior clearly in the public type comment.

**Acceptance:** Unit test asserting `mapSandboxMode('workspace-write') !== 'bypassPermissions'`, or a documented escalation test that asserts the degradation is logged.

**Validate:** `yarn workspace @dzupagent/agent-adapters test --run claude-adapter`

---

## QF-03: Fix boundary violation — agent test imports @dzupagent/server [ARCH-001/H-02]
**Target agent:** dzupagent-agent-dev

`packages/agent/src/__tests__/workflow-durability-integration.test.ts:14` imports from `@dzupagent/server`. This violates the package dependency hierarchy (server depends on agent, not the reverse).

Fix: Move the test to `packages/server/src/__tests__/workflow-durability-integration.test.ts` (server already depends on agent), OR rewrite the test to use only the public `@dzupagent/agent` API plus `InMemoryRunStore`/`InMemoryRunJournal` without any server import.

**Acceptance:** `yarn workspace @dzupagent/agent test` passes; no `@dzupagent/server` import in `packages/agent/src/**/*.ts`.

**Validate:** `grep -rn "@dzupagent/server" packages/agent/src/` returns 0 hits.

---

## QF-04: Fix relative-path boundary in agent-adapters test [ARCH-002/H-03]
**Target agent:** dzupagent-agent-dev

In `packages/agent-adapters/src/__tests__/structured-output-parity.test.ts:17-18`, change:
```
from '../../../agent/src/index.js'
```
to:
```
from '@dzupagent/agent'
```

If any symbol is missing from the public barrel, audit whether it should be public. If yes, add it to `packages/agent/src/index.ts`. If no, refactor the test to use only public API.

**Validate:** `yarn workspace @dzupagent/agent-adapters test --run structured-output-parity` passes; `grep -rn "from '\.\./\.\./\.\./agent" packages/agent-adapters/src/` returns 0 hits.

---

## QF-05: Add upstream-package boundary enforcement tests [ARCH-003/H-04]
**Target agent:** dzupagent-agent-dev

Create two new test files that enforce the package boundary invariant at the import level.

`packages/agent/src/__tests__/boundary/upstream-package-boundary.test.ts`:
- Walk `src/**/*.ts` (excluding `dist`/`node_modules`) and assert no import of `@dzupagent/{server,agent-adapters,codegen,connectors,connectors-browser,connectors-documents,express,otel,evals,rag,scraper}`.
- Assert no relative `../../../` escapes (cross-package relative paths).

`packages/agent-adapters/src/__tests__/boundary/upstream-package-boundary.test.ts`:
- Walk `src/**/*.ts` and assert no import of `@dzupagent/{server,codegen,connectors,connectors-browser,connectors-documents,express,otel,evals,rag,scraper}`.
- Assert no relative `../../../` escapes.

Model: `packages/agent/src/__tests__/boundary/memory-client-boundary.test.ts` (already exists — use same pattern).

**Validate:** `yarn workspace @dzupagent/agent test --run upstream-package-boundary && yarn workspace @dzupagent/agent-adapters test --run upstream-package-boundary`

---

## QF-06: Fix retry abort-listener leak [AGENT-003/H-09]
**Target agent:** dzupagent-agent-dev

In `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:282-299`, the retry backoff `new Promise` captures an `abort` event listener but never removes it on successful resolve, causing listener accumulation across many retries.

Fix: Use `{ once: true }` on the `signal.addEventListener('abort', onAbort, { once: true })` call so the listener auto-removes on first fire. Also call `signal.removeEventListener('abort', onAbort)` inside the `clearTimeout(backoffTimer)` cleanup block to cover the success-resolve path.

**Acceptance:** Unit test that drives 1,000 retries on an aborted signal asserts no listener accumulation (spy on `signal.addEventListener`).

**Validate:** `yarn workspace @dzupagent/agent test --run policy-enabled-tool-executor`

---

## QF-07: Fix iteration-budget config mutation [AGENT-035/H-10]
**Target agent:** dzupagent-agent-dev

In `packages/agent/src/guardrails/iteration-budget.ts:60-68`, `blockTool` mutates the caller-passed `config` via cast `(this.config as { blockedTools: string[] }).blockedTools = []`.

Fix: Add a private `blockedToolsOverride = new Set<string>()` field. In `blockTool`, add to this set instead of mutating `config`. Update `isToolBlocked` to return `config.blockedTools?.includes(name) || this.blockedToolsOverride.has(name)`.

**Acceptance:** Unit test passes an externally-created config object to `IterationBudget`; calls `blockTool('myTool')`; asserts the original config object reference is unchanged.

**Validate:** `yarn workspace @dzupagent/agent test --run iteration-budget`

---

## QF-08: Add webhook retry + DLQ + observability event [AGENT-042/H-11]
**Target agent:** dzupagent-agent-dev

In `packages/agent/src/approval/approval-gate.ts:104-107`, replace the silent swallow:
```ts
notifyWebhook(webhookUrl, pendingState).catch(() => {})
```

With a retry-backed call:
1. Attempt delivery up to 3 times with exponential backoff (100ms, 300ms, 900ms + jitter)
2. On terminal failure, call the optional `webhookDLQ?: (payload: ApprovalPendingState, error: Error) => Promise<void>` config callback
3. Emit an `approval:webhook_failed` event on the event bus (add to DzupEvent union if not present)

Apply the same fix to `packages/agent-adapters/src/approval/adapter-approval.ts:234` (same pattern).

**Acceptance:** Test with a mock webhook server that fails twice then succeeds — asserts exactly 3 HTTP calls. Test where all 3 fail — asserts DLQ callback invoked and event emitted.

**Validate:** `yarn workspace @dzupagent/agent test --run approval-gate`

---

## QF-09: Fix dead no-op try/catch in orchestrator [AGENT-044/H-12]
**Target agent:** dzupagent-agent-dev

In `packages/agent/src/orchestration/orchestrator.ts:520-522`, delete the dead no-op:
```ts
try {
  ...
} catch (err) {
  throw err   // no-op
}
```

Unwrap the try/catch entirely; the code inside should be at the caller level directly.

**Validate:** `yarn workspace @dzupagent/agent test && yarn workspace @dzupagent/agent typecheck`

---

## QF-10: Fix `consolidateOnComplete` throws — implement or remove [AGENT-010, AGENT-045/H-06]
**Target agent:** dzupagent-agent-dev

In `packages/agent/src/orchestration/team/team-runtime.ts:368-371`, `consolidateOnComplete` policy field is declared but throws `"not supported"` at runtime.

Fix: Implement consolidation by:
1. After team run completes, if `this.config.memoryPolicy?.consolidateOnComplete === true`
2. Call `this.config.memory?.consolidate?.(this.id, this.config.namespace)` (check if the method exists on the MemoryServiceLike interface — if not, add an optional `consolidate` method)
3. Emit `team:consolidation_completed` event with `agentId`, `namespace`, `teamId`

**Acceptance:** New unit test in `team-runtime.test.ts` asserting consolidation is called when policy is enabled; no `throw "not supported"` in codebase.

**Validate:** `grep -rn "not supported" packages/agent/src/ packages/agent-adapters/src/` should not return consolidation throws.

---

## QF-11: Fix `interrupt()` process-level handler leak in Claude adapter [AGENT-052/H-08]
**Target agent:** dzupagent-connectors-dev

In `packages/agent-adapters/src/claude/claude-adapter.ts:444-485`, `interrupt()` installs `process.once('unhandledRejection', ...)` at the process level. If multiple adapters interrupt concurrently, they clobber each other's handler.

Fix: Remove the `process.once` handler. Instead, wrap the SDK cleanup call in a local `try/catch`. If the SDK promise rejects during interrupt, log it with `@dzupagent/logger` at debug level and swallow it locally (the interrupt path already signals abort, so the error is expected).

**Validate:** `yarn workspace @dzupagent/agent-adapters test --run claude-adapter`

---

## QF-12: Declare `timeoutMs` on AdapterConfig [CODE-004/H-15]
**Target agent:** dzupagent-connectors-dev

In the `AdapterConfig` interface (most likely at `packages/adapter-types/src/index.ts` or `packages/agent-adapters/src/types.ts`), add:
```ts
timeoutMs?: number
```

Then in `packages/agent-adapters/src/codex/codex-adapter.ts:508`, remove the double-cast:
```ts
// REMOVE:
const configuredTimeoutMs = (this.config as Record<string, unknown>).timeoutMs as number | undefined
// REPLACE WITH:
const configuredTimeoutMs = this.config.timeoutMs
```

**Validate:** `yarn typecheck --filter=@dzupagent/agent-adapters`

---

## QF-13: Extract `sha256` to shared hash-utils [CODE-007/M-03]
**Target agent:** dzupagent-connectors-dev

1. Create `packages/agent-adapters/src/dzupagent/hash-utils.ts`:
```ts
import { createHash } from 'node:crypto'
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}
```
2. In `packages/agent-adapters/src/dzupagent/syncer.ts:127`, remove the local `sha256` function and import from `./hash-utils.js`
3. In `packages/agent-adapters/src/dzupagent/importer.ts:132,182`, replace inline `createHash('sha256').update(...).digest('hex')` calls with `sha256(content)` imported from `./hash-utils.js`

**Validate:** `yarn workspace @dzupagent/agent-adapters test`

---

## QF-14: Replace console.log/debug with @dzupagent/logger [CODE-023/M-04]
**Target agent:** dzupagent-connectors-dev

Replace all `console.error`/`console.warn`/`console.debug`/`console.log` calls in the following production source files with structured `logger.*()` calls from `@dzupagent/logger`:
- `packages/agent-adapters/src/codex/codex-adapter.ts` (11 console calls)
- `packages/agent/src/orchestration/orchestration-telemetry.ts:36,50,68` (4 console.debug calls — use a no-op logger when no tracer is configured)
- `packages/agent/src/self-correction/self-learning-hook.ts:201`
- `packages/agent-adapters/src/dzupagent/syncer.ts:610`
- `packages/agent-adapters/src/middleware/memory-enrichment.ts:99,211`

**Validate:** `grep -rn "console\." packages/agent/src packages/agent-adapters/src | grep -v ".test.ts" | grep -v "node_modules"` returns 0 hits.

---

## QF-15: Move `exact-optional` and `event-record` utils to `@dzupagent/core` [ARCH-012/H-16]
**Target agent:** dzupagent-core-dev

1. Move `packages/agent/src/utils/exact-optional.ts` → `packages/core/src/utils/exact-optional.ts`
2. Add `export * from './utils/exact-optional.js'` to `packages/core/src/index.ts`
3. Move `packages/agent-adapters/src/utils/event-record.ts` → `packages/core/src/utils/event-record.ts`
4. Add export to `packages/core/src/index.ts`
5. Update all import sites in `packages/agent/src/**/*.ts` and `packages/agent-adapters/src/**/*.ts`
6. Delete the original files

**Validate:** `yarn verify`

---

## QF-16: Add `unref` to approval-gate timeout [AGENT-047/H-17]
**Target agent:** dzupagent-agent-dev

In `packages/agent/src/approval/approval-gate.ts:153-164`, change:
```ts
const timeoutHandle = setTimeout(onTimeout, timeoutMs)
```
to:
```ts
const timeoutHandle = setTimeout(onTimeout, timeoutMs).unref()
```

**Validate:** `yarn workspace @dzupagent/agent test --run approval-gate`

---

## QF-17: Add `@deprecated` JSDoc to AgentPlayground triple-export [CODE-024]
**Target agent:** general-purpose

In `packages/agent/src/playground.ts:10` and `packages/agent/src/playground/index.ts:1`, add:
```ts
/** @deprecated Use the canonical import from `@dzupagent/agent` instead. Will be removed in 0.4.0. */
```
before each re-export of `AgentPlayground`.

**Validate:** `yarn workspace @dzupagent/agent typecheck`
