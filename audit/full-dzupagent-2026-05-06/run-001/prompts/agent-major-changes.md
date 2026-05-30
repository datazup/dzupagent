# Agent Audit — Major Changes (12-40h, multi-package, design impact)

These tasks change interfaces consumed across packages and require coordinated migration. Each is scoped as a single epic with a phased rollout.

---

## MC-AGT-01 — Tenant-scoped adapter learning loop (close SEC-02)
**ID:** MC-AGT-01
**Severity in audit:** AGT-001 (Critical)
**Target agent:** dzupagent-agent-dev (lead) + dzupagent-core-dev (review)
**Effort estimate:** 16h (interface + 3 stores + routing + tests + migration helper)

**Files (read):**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/learning/adapter-learning-loop.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/learning/learning-store.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/learning/in-memory-learning-store.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/learning/file-learning-store.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/registry/` (consumers of profiles)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/orchestration/` (routing decisions that use profiles)

**Files (modify):**
- All of `learning/*.ts`
- All callers of `recordExecution` / `getProfile` / `getFailurePatterns`
- `packages/agent-adapters/src/types.ts` to add `tenantId` to relevant context types

**Current state:** `ExecutionRecord` has no tenantId. Failure patterns and provider profiles aggregate globally. Cross-tenant signal leak; AdapterLearningLoop biases routing for tenant B based on tenant A's failures. Memory note claimed SEC-02 closed; verification re-opens it.

**Target state:**
1. Add required `tenantId: string` to `ExecutionRecord`.
2. Re-key `LearningStore` ops:
   ```ts
   saveRecord(tenantId: string, providerId: string, record: ExecutionRecord): void
   loadRecords(tenantId: string, providerId: string, limit: number): ExecutionRecord[]
   saveProfile(tenantId: string, providerId: string, profile: ProviderProfile): void
   getProfile(tenantId: string, providerId: string): ProviderProfile | undefined
   saveFailurePatterns(tenantId: string, providerId: string, patterns: FailurePattern[]): void
   getFailurePatterns(tenantId: string, providerId: string): FailurePattern[]
   ```
3. Add `getGlobalProfile(providerId): ProviderProfile` returning aggregate-across-tenants stats — clearly labeled as ops-dashboard read-only, NEVER consulted by routing.
4. Update `LearningSnapshot.records` from `Record<providerId, ExecutionRecord[]>` to `Record<tenantId, Record<providerId, ExecutionRecord[]>>` (version bump to 2; provide v1→v2 migration helper that requires the operator to specify a tenantId for the legacy data).
5. Update all routing/orchestration callers to thread tenantId through.
6. Add `AdapterLearningLoop.recordExecution(tenantId, record)` signature (require both); deprecate the existing 1-arg signature with a warning until the next major.

**Migration plan:**
- Phase 1: ship new optional `tenantId` field on `ExecutionRecord`; warn when missing.
- Phase 2: routing consults `getProfile(tenantId, providerId)` first, falls back to global only with explicit operator opt-in.
- Phase 3: required tenantId; remove fallback.

**Validation:**
- New vitest: 50 tenant-A failures + 50 tenant-B successes for the same providerId — assert `getProfile('A', 'claude').successRate === 0` and `getProfile('B', 'claude').successRate === 1`.
- Vitest: routing for tenant B does NOT consult tenant A's failure patterns.
- Migration vitest: load v1 snapshot with explicit tenantId arg → all records preserved under that tenant key.
- `yarn verify --filter @dzupagent/agent-adapters`
- Update `audit/full-dzupagent-2026-05-06/run-001/docs/AGENT-AUDIT.md` to mark AGT-001 closed; close SEC-02 in the project memory note.

---

## MC-AGT-02 — Unify the two security stacks under @dzupagent/security
**ID:** MC-AGT-02
**Severity in audit:** AGT-003 (High), closes AGT-010
**Target agent:** dzupagent-core-dev (lead) + dzupagent-agent-dev
**Effort estimate:** 16h

**Files (read):**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/security/src/` (canonical)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/security/monitor/built-in-rules.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/security/monitor/safety-monitor.ts`

**Files (modify):**
- `core/src/security/monitor/safety-monitor.ts` — refactor to delegate
- `core/src/security/monitor/built-in-rules.ts` — remove duplicate injection + PII; keep tool_abuse + escalation
- All consumers of `SafetyMonitor.scanContent` to receive consolidated coverage transparently
- Add `@dzupagent/security` as a dep of `@dzupagent/core` (or invert: move the canonical scanner into core if dep direction prefers)

**Current state:** Two parallel stacks with diverging pattern sets. PII coverage in tool-result scan is asymmetric vs. memory write-back scan. Operator confusion. Silent JWT leak through tool results.

**Target state:**
1. Designate `@dzupagent/security` as the canonical scanner for prompt_injection and pii_leak categories.
2. Refactor `SafetyMonitor`:
   - Keep the rule-based architecture for `tool_abuse` + `escalation`.
   - Replace `prompt_injection` rule's regex with `PromptInjectionDetector.scan(content, mode)`.
   - Replace `pii_leak` rule's regex with `PiiDetector.scan(content)`.
3. Single `SecurityPolicyConfig` exported from `@dzupagent/security`:
   ```ts
   {
     promptInjection: 'off' | 'warn' | 'block',
     pii: 'off' | 'redact' | 'block',
     toolAbuse: { /* threshold config */ },
     escalation: 'off' | 'warn' | 'block',
   }
   ```
4. Single canonical pattern table: `INJECTION_PATTERNS` + `PII_PATTERNS` from `@dzupagent/security`. `built-in-rules.ts` no longer defines its own.
5. Tool-loop scans tool results via the consolidated path (closes AGT-010).
6. Document the decision in an ADR.

**Migration plan:**
- Phase 1: delegate inside `built-in-rules.ts`; existing public API unchanged.
- Phase 2: deprecate the old constants exported from `built-in-rules.ts`; redirect to `@dzupagent/security`.
- Phase 3 (next major): remove deprecated exports.

**Validation:**
- Existing tests in both packages pass against the unified set.
- New test: tool returning JWT is blocked with `category: 'pii_leak'`.
- New test: memory write-back of `'ignore previous instructions'` is detected with the same rule set.
- ADR added to `docs/adr/`.

---

## MC-AGT-03 — Run-engine-managed provider fallback on transient invocation errors
**ID:** MC-AGT-03
**Severity in audit:** AGT-013 (Low) but high product value
**Target agent:** dzupagent-core-dev + dzupagent-agent-dev
**Effort estimate:** 12h

**Files (read):**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/llm/model-registry.ts:338` (getModelWithFallback, getModelFallbackCandidates)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/llm/invoke.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/dzip-agent.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/provider-failover.ts`

**Current state:** Provider fallback is selection-time only. After invocation begins, transient errors (5xx, rate limit) on provider A do not transparently retry on provider B. Run engine has to opt-in via `getModelFallbackCandidates`.

**Target state:**
1. Introduce `ResilientModelInvoker` that:
   - Holds the candidate chain from `getModelFallbackCandidates(tier)`.
   - Walks the chain on `isTransientError` failures.
   - Records failure on the breaker for the failing provider.
   - Records success on the breaker for the succeeding provider.
   - Surfaces a `model:fallback` event indicating which provider was used.
2. Integrate into `dzip-agent.ts` so the default invocation path is fallback-aware.
3. Add `RegistryConfig.fallbackOnInvocationError: boolean` (default `true` — new behavior; document as a behavior change).
4. Existing manual `getModelWithFallback` callers are unaffected.

**Validation:**
- Vitest with three providers; provider A throws 503 → invocation transparently retries on B → succeeds.
- Vitest with all providers down → throws ALL_PROVIDERS_EXHAUSTED.
- Telemetry asserts `model:fallback` emitted exactly once per fallback hop.
- `yarn verify --filter @dzupagent/agent`

---

## MC-AGT-04 — Unified durable run state (approval + stuck + checkpoint)
**ID:** MC-AGT-04
**Severity in audit:** AGT-006, AGT-007 follow-up; longer-term simplification
**Target agent:** dzupagent-agent-dev (lead, large)
**Effort estimate:** 32h

**Files (read):**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/approval-types.ts` (CheckpointStore)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/persistence/run-journal.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/persistence/checkpointer.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/guardrails/stuck-detector.ts`

**Current state:** Three semi-overlapping persistence surfaces:
- `ApprovalGate.checkpointStore` (per-key blob)
- `core/persistence/run-journal` (event log)
- `core/persistence/checkpointer` (LangGraph-style)

A run that pauses for approval keeps state in checkpointStore but its tool-loop in-memory state (stuck detector, iteration budget, message history) is NOT persisted. Cross-process resume rebuilds state from the journal at best.

**Target state:** Single `DzupRunState` snapshot interface:
```ts
interface DzupRunState {
  runId: string
  tenantId?: string
  agentId: string
  messages: BaseMessage[]
  budget: BudgetState
  stuckDetector: StuckDetectorSnapshot
  approval?: ApprovalPendingState
  iteration: number
  cumulativeUsage: TokenUsage[]
  version: 1
}
```

1. Implement `DzupRunStateStore` interface (in core).
2. Run engine writes a snapshot at: every iteration boundary, on suspend (approval, checkpoint, stuck), on terminal.
3. Resume from any snapshot rebuilds the full agent state including stuck detector and budget.
4. Reuses existing `BaseStore` adapters (Postgres, Redis, in-memory).
5. Approval gate's `checkpointStore` becomes a view on this store with a key prefix.
6. Stuck detector snapshots flow naturally (closes AGT-006).
7. Approval timeout writes terminal decision (closes AGT-007).

**Migration plan:**
- Phase 1: introduce `DzupRunStateStore` alongside existing stores; opt-in.
- Phase 2: deprecate per-subsystem stores; route through DzupRunStateStore.
- Phase 3 (next major): remove deprecated stores.

**Validation:**
- Run engine integration test: pause for approval at iteration 7, kill process, resume in new process, complete run normally.
- Stuck detector state preserved across restart.
- Budget state preserved.

---

## MC-AGT-05 — Permission tier as first-class agent capability
**ID:** MC-AGT-05
**Severity in audit:** AGT-012 (Medium)
**Target agent:** dzupagent-agent-dev + codegen-dev
**Effort estimate:** 16h

**Files (read):**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/sandbox/permission-tiers.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/tools/`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/agent-types.ts` (DzupAgentConfig)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/tools/`

**Current state:** Permission tiers exist as types in codegen; enforcement is at the sandbox layer; tools are not tagged with required tier.

**Target state:**
1. Move `PermissionTier` type up to `@dzupagent/core` (it's a universal concept).
2. Add `requiredTier?: PermissionTier` to `StructuredTool` metadata or to a tool-registry adjacent record.
3. Tag all codegen write/edit tools with `requiredTier: 'workspace-write'`.
4. Tag full-access tools (shell, network) with `requiredTier: 'full-access'`.
5. At agent construction in `dzip-agent.ts`:
   - Compute the agent's effective tier from `DzupAgentConfig.permissionTier ?? 'read-only'`.
   - Filter the bound tool list to those whose `requiredTier <= effectiveTier`.
   - Document that the model NEVER sees tools above its tier.
6. Sandbox layer remains as defense-in-depth.
7. Add `agent:tools-filtered` event surfacing the filter decision for ops.

**Validation:**
- Vitest: agent on `read-only` with `write_file` registered — `agent.boundTools` excludes `write_file`.
- Vitest: model invocation transcript on `read-only` agent shows zero write-tool calls (the model can't see them).
- Sandbox enforcement tests still pass (defense-in-depth).
- `yarn verify`

---
