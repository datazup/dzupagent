# AdapterRegistry → ProviderAdapterRegistry Cleanup Status

## Canonical name
`ProviderAdapterRegistry` (class) — `AdapterRegistry` is a deprecated re-export alias.

## Completed clusters

### Recovery cluster (2026-04-25)
- `adapter-recovery.test.ts` ✅
- `recovery-backoff.test.ts` ✅
- `recovery-events.test.ts` ✅
- `recovery-cancelled-integration.test.ts` ✅

### Parallel-executor cluster (2026-04-25)
- `parallel-executor.test.ts` ✅
- `parallel-executor.stress.test.ts` ✅
- `parallel-executor.contract.test.ts` ✅
- `parallel-executor-unhandled-rejection.test.ts` ✅

### Structured-output cluster (2026-04-25)
- `structured-output.test.ts` ✅
- `structured-output-parity.test.ts` ✅

### Supervisor (2026-04-25)
- `supervisor.test.ts` ✅

### Previously migrated
- `adapter-lifecycle.test.ts` ✅
- `adapter-registry.test.ts` ✅
- `adapter-registry-circuit-breaker-deep.test.ts` ✅
- `adapter-registry-production-gate.test.ts` ✅
- `agent-bridge.test.ts` ✅
- `adapter-workflow.test.ts` ✅
- `correlation-warmup.test.ts` ✅
- `gemini-sdk-adapter.test.ts` ✅
- `map-reduce.test.ts` ✅
- `orchestration-branches-2.test.ts` ✅
- `provider-execution-port-branches.test.ts` ✅
- `ab-test-runner.test.ts` ✅

### Final cluster (2026-04-25)
- `orchestration-branches.test.ts` ✅
- `workflow-branches.test.ts` ✅
- `workflow-versioning.test.ts` ✅
- `openrouter-adapter.test.ts` ✅
- `session-registry.test.ts` ✅ (typed `ProviderAdapterRegistry`; local vars `mockAdapterRegistry` are fine)

## Migration complete

All `src/__tests__` files use `ProviderAdapterRegistry` directly. Zero bare deprecated
`AdapterRegistry` references remain in tests. 2515/2515 tests pass. Typecheck clean.

## What remains (intentional compatibility surface)

The following deprecated aliases are intentional public-API shims. **Do not remove until
a deletion window is defined and all first-party consumers are migrated.**

| Symbol | Location | Reason |
|--------|----------|--------|
| `export { ProviderAdapterRegistry as AdapterRegistry }` | `src/registry/adapter-registry.ts:626` | deprecated re-export class alias |
| `export { AdapterRegistry }` | `src/registry/index.ts:8` | barrel re-export of the above |
| `export { AdapterRegistry }` | `src/index.ts:74` | public root re-export |
| `export type { DetailedHealthStatus }` | `src/registry/adapter-registry.ts:75` | deprecated type alias |
| `export type { DetailedHealthStatus }` | `src/registry/index.ts:13` | barrel re-export |
| `export type { DetailedHealthStatus }` | `src/index.ts:78` | public root re-export |

All six entries carry `@deprecated` JSDoc. No deletion window has been set.
Next action: define a semver minor target and scan first-party consumers before removal.