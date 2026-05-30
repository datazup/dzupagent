# MC-S01 — Token Budget Enforcement — VALIDATION

## Summary

Wired the existing `createResourceQuotaManager` (per-API-key sliding
window) into the run-creation pipeline and the run-worker completion
path. Quota-exceeded requests now receive HTTP 429; real token usage is
fed back so the sliding window stays current.

## Scope of change

### `packages/server/src/app.ts`
- Added `import type { ResourceQuotaManager } from './security/resource-quota.js'`.
- `ForgeServerConfig` gains an optional `resourceQuota?: ResourceQuotaManager`
  field with JSDoc covering the admission + record flow.
- Forwarded `resourceQuota` into `startRunWorker(...)` so the worker can
  record post-run usage.

### `packages/server/src/routes/runs.ts`
- `handleCreateRun` now extracts `maxTokensPerRun` + `maxRunsPerHour`
  from the authenticated `apiKey` record.
- If `config.resourceQuota` is configured, calls
  `resourceQuota.checkQuota(keyId, estimate, hourlyLimit)`. A denial
  maps to `{ status: 429, error.code: 'QUOTA_EXCEEDED', error.message: <reason> }`.
- On admission, projects the tighter of
  `metadata.guardrails.maxTokens` / `maxTokensPerRun` onto the run
  metadata so the executor enforces the same cap.
- Collapsed the older duplicate `getRequestingTenantId` definitions into
  a single helper that prefers `tenantId → ownerId → id → 'default'`.

### `packages/server/src/runtime/run-worker.ts`
- `StartRunWorkerOptions` gains `resourceQuota?: ResourceQuotaManager`.
- After a run transitions to `'completed'`/`'halted'`, the worker
  computes `totalTokens = (input ?? 0) + (output ?? 0)` and calls
  `resourceQuota.recordUsage(keyId, totalTokens)`. The key id is read
  from `job.metadata.ownerId` (stamped at run creation), falling back
  to `tenantId`. Failures are caught and surfaced as a `warn`-level run
  log under phase `quota` — never block completion.

### `packages/server/src/index.ts`
- Re-exports `createResourceQuotaManager` plus the per-key
  `ResourceQuotaManager`, `ResourceQuotaManagerConfig`, and
  `QuotaCheckResult` types under aliased names (`PerKeyResourceQuotaManager`
  et al.) so they coexist with the reservation-style manager already
  exported from `runtime/`.

## Acceptance criteria

```bash
yarn typecheck --filter @dzupagent/server
```
No new type errors introduced by the MC-S01 edits. The 17 pre-existing
errors (in `benchmark-run-store.ts`, `routes/approvals.ts`,
`services/prompt-feedback-loop.ts`) are unchanged.

```bash
yarn workspace @dzupagent/server test src/__tests__/resource-quota.test.ts
```
```
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

## Tests added / exercised

The existing `src/__tests__/resource-quota.test.ts` already covered the
task's three acceptance scenarios plus nine supporting cases:

| Requested scenario                                   | Test case                                                                        |
|------------------------------------------------------|----------------------------------------------------------------------------------|
| Request with quota exceeded → 429                    | `POST /api/runs … > rejects run creation with 429 when the key is over budget`   |
| Request within quota → 201                           | `POST /api/runs … > injects maxTokensPerRun into guardrails.maxTokens`           |
| Quota resets after window                            | `createResourceQuotaManager > resets the window once the sliding interval elapses` |

The fixture was extended with `role: 'operator'` so the default RBAC
middleware permits the mock caller to create runs.

## Files of record

- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts
- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts
- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/run-worker.ts
- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/security/resource-quota.ts (unchanged, already existed)
- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/__tests__/resource-quota.test.ts
- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/index.ts

## Notes / deviations from spec

- The original task description referenced `packages/server/src/runtime/resource-quota.ts`
  (reservation-style API: `check` / `reserve` / `release`). The actual
  existing test fixture and the function names called out in the task
  (`checkQuota`, `recordUsage`) match the simpler
  `packages/server/src/security/resource-quota.ts` implementation. We
  wired that one because it already matched the test contract and
  the API key's `maxRunsPerHour` / `maxTokensPerRun` fields 1:1.
- The config field is named `resourceQuota` (matching the existing test
  fixture) rather than `quotaManager` from the task draft.
- Tenant identification falls back through `tenantId → ownerId → id →
  'default'` so deployments that have not yet adopted MC-S02 tenant
  stamping still get consistent per-key buckets.
