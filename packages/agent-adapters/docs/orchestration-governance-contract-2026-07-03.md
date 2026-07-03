# Orchestration Governance Contract - 2026-07-03

Source-backed inventory for DzupAgent orchestration governance controls used by MPCO-style adapter execution.

## Enforced Controls

| Control | Source | Status | Contract |
| --- | --- | --- | --- |
| AgentCircuitBreaker | `packages/agent/src/orchestration/circuit-breaker.ts` | enforced alias | Re-exports `KeyedCircuitBreaker` as `AgentCircuitBreaker`; tests cover open, half-open, cooldown, success reset, and key isolation in `packages/agent/src/orchestration/__tests__/circuit-breaker.test.ts`. |
| AdapterGuardrails | `packages/agent-adapters/src/guardrails/adapter-guardrails.ts` | enforced | Wraps adapter event streams, blocks forbidden tools, applies iteration/token/cost/duration limits, filters output, and emits guardrail failures. |
| AdapterStuckDetector | `packages/agent-adapters/src/guardrails/adapter-stuck-detector.ts` | enforced via core subclass | Preserves adapter-facing stuck detection API while delegating detection to `@dzupagent/core/utils` `StuckDetector`; tests cover repeated tool calls, error windows, idle iterations, and reset in `packages/agent-adapters/src/__tests__/adapter-guardrails.test.ts`. |
| Adapter budget tally | `packages/adapter-types/src/contracts/budget.ts` | enforced pure helper | `accrueUsage` returns a new tally, tolerates missing optional usage fields, and keeps cache read/write tokens in observed `totalTokens` without adding them to cap-enforced `budgetTokens`. |
| Approval pending idempotency | `packages/hitl-kit/src/approval-state-store.ts`; `packages/hitl-kit/src/postgres-approval-store.ts` | enforced | `createPending` is idempotent only while the approval is pending; terminal duplicate creates throw `DuplicateApprovalError`. In-memory and Postgres stores share that contract. |

## Documented Gaps

`DEFAULT_LIFECYCLE_POLICY` is not a source-enforced symbol in the packet's allowed packages. Current lifecycle behavior is distributed across registry/session/runtime modules and tests, but there is no single exported default lifecycle policy contract to consume. Do not document a production-enforced `DEFAULT_LIFECYCLE_POLICY` until a source symbol and focused tests exist.

## Boundaries

- DzupAgent owns structured governance records and validation outcomes.
- Scripts consumers should consume typed outcomes from DzupAgent packages; DzupAgent must not import scripts runtime modules.
- Provider raw output is not persisted by these contracts. Guardrail and approval records should retain structured summaries and status, not raw provider transcripts.
- Approval persistence schema changes remain high risk and require maintainer review before implementation.

## Telemetry

`dzupagent_governance_contract_gap_count=1`

The current counted gap is the missing source-enforced `DEFAULT_LIFECYCLE_POLICY` contract.
