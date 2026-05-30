# Refactors (P2, 4-12h each) — full-dzupagent 2026-05-06

Consolidated handoff for `/analyze-implement`. Per-domain prompt files with fuller context still live alongside (`{code,security,architecture,agent}-refactors.md`). Total: ~38 refactor tasks, ~210h aggregate.

## Live-check normalization notes

The first implementation tranche should not include already-fixed `SEC-010` or a from-scratch package-boundary CI task. The live checkout already has domain/boundary checks in `yarn verify`; remaining architecture-gate work is cycle detection and declared-vs-actual dependency completeness. Approval webhook work lives in `packages/agent/src/approval/approval-gate.ts`.

---

## SEC-001 + AGT-001 + SEC-009: Cross-tenant scoping on CRUD families [CRITICAL]
**Effort:** 24h combined · **Severity:** Critical
**Files:**
- `packages/server/src/routes/{agents,personas,triggers,schedules,prompts,marketplace,clusters}.ts`
- `packages/server/src/services/agent-definition-service.ts`
- `packages/agent/src/self-correction/learning-candidate-service.ts`
- `packages/agent-adapters/src/learning/{adapter-learning-loop,learning-store}.ts`
**Change:**
1. Add `tenantId` predicate to every Drizzle query for the 7 affected tables (or the column itself if missing).
2. Introduce `withTenantScope(c, repo)` middleware used uniformly.
3. AdapterLearningLoop ExecutionRecord/ProviderProfile keys must include tenantId.
4. LearningCandidateService methods take `(tenantId, …)` signature.
5. Add `cross-tenant-isolation.test.ts` enumerating every endpoint, asserting cross-tenant calls return 404 (not 403).
**Validation:** New boundary test green; existing tests still green; manual smoke with two tenants confirms isolation.
**Target agents:** dzupagent-server-dev (routes), dzupagent-agent-dev (services), dzupagent-test-dev (boundary tests)

---

## ARCH-022 + ARCH-015 + ARCH-016: Architecture gate completion
**Effort:** 6h · **Severity:** Medium
**Files:** `package.json`, `packages/testing/src/__tests__/boundary/architecture.test.ts`, `.github/workflows/*`
**Change:**
1. Keep existing `check:domain-boundaries` and machine-readable boundary test coverage.
2. Add `yarn arch:cycles` (madge → fail on new or unallowlisted cycles).
3. Add declared-vs-actual dependency completeness checks.
4. Wire the expanded checks into the existing `verify`/PR path after baseline allowlisting or fixes.
**Validation:** PR introducing a deliberate cycle fails CI.
**Target agent:** dzupagent-architect

---

## SEC-002 + AGT-002: Approval webhook outbound URL policy + HMAC signing
**Effort:** 4h · **Severity:** High
**Files:** `packages/agent/src/approval/approval-gate.ts:275-322`
**Change:** Reuse `fetchWithOutboundUrlPolicy`/outbound URL policy. Add HMAC SHA-256 signing with timestamp headers so receivers can reject stale or forged callbacks.
**Validation:** New tests assert (a) IMDS/localhost URL is rejected, (b) signature and timestamp headers are present, (c) retry and DLQ behavior still works.
**Target agent:** dzupagent-agent-dev

---

## SEC-006: Zod-validate all 207 user-input touch points
**Effort:** 12h · **Severity:** High
**Files:** `packages/server/src/routes/*.ts`
**Change:** Per-route Zod schema; `c.req.valid('json')`; `.strict()`; remove ad-hoc `typeof body['x']` checks. Add lint rule: every route handler must call a `valid…` getter.
**Validation:** Negative tests for `__proto__`, `constructor`, deep-nested payload depth-bomb.
**Target agent:** dzupagent-server-dev

## SEC-007: Hash webhook secrets at rest
**Effort:** 4h · **Severity:** High
**Files:** `packages/server/src/db/drizzle-schema.ts:214` + trigger CRUD
**Change:** Drizzle migration: rename `webhook_secret` → `webhook_secret_hash`. HMAC verify on inbound; never read plaintext back. Provide one-time rotation script.
**Target agent:** dzupagent-server-dev

## SEC-008 + AGT-010 + AGT-014: PII guard at all sensitive boundaries
**Effort:** 8h · **Severity:** High
**Files:** `packages/memory/src/sanitizer/*`, `packages/agent/src/orchestration/tool-loop/result-pipeline.ts`, `MemoryStore.put` boundary
**Change:** Single `piiGuard(text, context)` helper. Apply at: (a) tool-result emit, (b) learning-candidate ingest, (c) MemoryStore.put. Remove duplicate scanner in core/security/monitor/built-in-rules (after AGT-003 consolidation).
**Validation:** Test with fixture containing JWT, CC, IBAN, email, phone, SSN — must redact at all three boundaries.
**Target agent:** dzupagent-agent-dev

## SEC-021: JSON depth/size cap on metadata fields
**Effort:** 4h · **Severity:** Low
**Files:** drizzle schemas with `metadata` columns
**Change:** Schema-level Zod `.refine(json => measureDepth(json) <= 4 && JSON.stringify(json).length < 8192)`.
**Target agent:** dzupagent-server-dev

## SEC-011 + SEC-012: Replace `new Function` paths with controlled evaluator
**Effort:** 10h combined · **Severity:** Medium
**Files:** `packages/flow-compiler/src/semantic.ts`, `packages/codegen/src/sandbox/wasm-sandbox.ts`
**Change:** Use a sandboxed expression evaluator (e.g. `expr-eval` with allowlisted operators) for flow-compiler. For wasm-sandbox dynamic import, restrict to a static allowlist of pre-resolved module paths.
**Target agent:** dzupagent-architect (flow), dzupagent-codegen-dev (sandbox)

---

## AGT-003 + ARCH-004: Consolidate two security stacks
**Effort:** 12h (refactor leg; full migration is 24h major) · **Severity:** High
**Files:** `packages/core/src/security/*` (3,094 LOC), `packages/security/src/*` (464 LOC)
**Change:** Move PII patterns + prompt-injection rules + output filters from core/security to packages/security. Make core/security a thin re-export shim until the next major. Single ContentScanner — all consumers go through it.
**Validation:** All security tests green; AGT-010 consumers now use ContentScanner; verify identical PII coverage.
**Target agent:** dzupagent-core-dev

---

## ARCH-001: Invert agent-adapters/workflow → agent layering
**Effort:** 8h · **Severity:** High
**Files:** `packages/agent-adapters/src/workflow/{default-pipeline-executor,adapter-workflow,pipeline-assembler}.ts`
**Change:** Move `PipelineRuntime` interface + `PipelineRuntimeEvent` from agent → `runtime-contracts`. Both packages depend on the contract; neither on the other.
**Validation:** `yarn arch:layering` returns 0; agent-adapters tests green.
**Target agent:** dzupagent-architect

## ARCH-002 + ARCH-013 + CODE-013 + CODE-012: Shrink core + agent barrels
**Effort:** 8h · **Severity:** High
**Files:** `packages/core/src/index.ts` (877 LOC, 225 exports), `packages/agent/src/index.ts` (821 LOC, 210 exports)
**Change:** Curate to ~50 stable exports. Move advanced/internal symbols to subpath imports. Add removal milestone to 40 deprecated agent shims.
**Validation:** Public API surface diff documented; no consumer in apps/* breaks.
**Target agents:** dzupagent-core-dev + dzupagent-agent-dev

## ARCH-005: Eliminate 28 intra-package circular deps
**Effort:** 16h · **Severity:** High
**Files:** distribution: agent-adapters 10, server 8, agent 6, core 2, adapter-types 1
**Change:** Most agent-adapters cycles trace to mutual `provider-profile` imports — break with a contract file. Server cycles trace to `composition/types.ts` — also break here (REC-M-09).
**Validation:** `npx madge --circular` returns 0.
**Target agent:** dzupagent-architect

## CODE-002 / REC-H-12: Decompose `runToolLoop` (362 LOC, depth 10)
**Effort:** 6h · **Severity:** High
**Files:** `packages/agent/src/orchestration/run-tool-loop.ts`
**Change:** Extract pipeline stages: PreToolGuards → ToolDispatch → PostToolValidation → StuckCheck → BudgetCheck. Each is a pure function. Test each independently.
**Target agent:** dzupagent-agent-dev

## CODE-006: Backfill server zero-test files (5 files)
**Effort:** 12h · **Severity:** High
**Files:** `packages/server/src/routes/{deploy,scorecard}*.ts`
**Target agent:** dzupagent-test-dev

---

## AGT-005: Use @anthropic-ai/tokenizer for Claude
**Effort:** 4h · **Severity:** Medium
**Files:** `packages/context/src/tokenizer/tiktoken-counter.ts`
**Change:** Add provider-aware tokenizer routing. Use `@anthropic-ai/tokenizer` for Claude models, `tiktoken` cl100k_base for OpenAI, sentencepiece-equivalent for Gemini.
**Target agent:** dzupagent-core-dev

## AGT-006: Stuck detector idle counter race
**Effort:** 4h · **Severity:** Medium
**Files:** `packages/agent/src/orchestration/stuck-detector.ts`
**Change:** Reset idle counter on resume after parallel-mode approval pause. Add explicit `onResume()` callback.
**Target agent:** dzupagent-agent-dev

## AGT-007: Persist approval timeout decision
**Effort:** 4h · **Severity:** Medium
**Files:** `packages/agent/src/approval/approval-gate.ts`
**Change:** Before cancelling on timeout, write `decision: 'timeout'` to durable approval store with timestamp.
**Target agent:** dzupagent-agent-dev

## AGT-009: Enrich LLM audit log
**Effort:** 6h · **Severity:** Medium
**Files:** `packages/agent/src/observability/audit-log.ts`
**Change:** Include `tenantId`, `runId`, `prompt` (hashed if sensitive), `response` (hashed), `model`, `provider`, `tokens`, `cost`. Single canonical event.
**Target agent:** dzupagent-agent-dev

## AGT-012: Permission tier check at write-tool issuance
**Effort:** 6h · **Severity:** Medium
**Files:** `packages/codegen/src/permissions/*`
**Change:** Validate tier on tool registration (issuance), not at sandbox layer. Catch mis-tier before any sandbox execution.
**Target agent:** dzupagent-codegen-dev

## AGT-013: Retry on invocation error in ModelRegistry
**Effort:** 4h · **Severity:** Low
**Files:** `packages/core/src/model-registry/registry.ts`
**Change:** Currently fallback only triggers on model-creation error. Extend to retry-then-fallback on transient invocation errors with classification.
**Target agent:** dzupagent-core-dev

---

## ARCH-007 / REC-M-07: Decompose 9 god files
**Effort:** 32h (sprint) · **Severity:** Medium → see major-changes.md (this effort spills to a major)

## ARCH-011: Replace `composition/types.ts` kitchen-sink module
**Effort:** 4h · **Severity:** Medium
**Files:** `packages/server/src/composition/types.ts`
**Change:** Split into per-feature ambient files. Verify cycles drop from server count.
**Target agent:** dzupagent-server-dev

## ARCH-012 / CODE-018: Split `server/routes/runs.ts` (969 LOC)
**Effort:** 8h · **Severity:** Medium
**Files:** `packages/server/src/routes/runs.ts`
**Change:** Split into `runs/list.ts`, `runs/detail.ts`, `runs/stream.ts`, `runs/control.ts`. Top-level barrel re-exports.
**Target agent:** dzupagent-server-dev

## ARCH-019: Add subpath exports to memory package
**Effort:** 4h · **Severity:** Low
**Files:** `packages/memory/src/index.ts`, `packages/memory/package.json` exports
**Change:** Define `decay`, `consolidation`, `store`, `sanitizer`, `mcp`, `ipc` subpaths.
**Target agent:** dzupagent-core-dev

## ARCH-020: Split optional-dep adapters into separate packages
**Effort:** 8h · **Severity:** Low
**Files:** `packages/agent-adapters/src/{claude,codex}/*` → new packages or subpath
**Change:** Allow tree-shake of `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` when only one provider is used.
**Target agent:** dzupagent-connectors-dev

## ARCH-021: Split event-types.ts (774 LOC, growing)
**Effort:** 4h · **Severity:** Medium
**Files:** `packages/core/src/events/event-types.ts`
**Change:** Per-domain event modules under `events/` (run, tool, approval, memory, learning), each ≤200 LOC. Re-export the union from a top file.
**Target agent:** dzupagent-core-dev

---

## CODE-003: Dedup mtime-cache loaders
**Effort:** 4h · **Severity:** Medium
**Files:** dzupagent loader trio
**Change:** Extract shared `MtimeCache` to dzupagent-kit (or core).
**Target agent:** dzupagent-core-dev

## CODE-004: Resolve `MemoryEntry` interface name collision
**Effort:** 4h · **Severity:** Medium
**Files:** `packages/{memory,core,agent}/...`
**Change:** Rename to context-specific names; keep one canonical `MemoryEntry` in memory package.
**Target agent:** dzupagent-core-dev

## CODE-007: flow-ast/parse.ts per-node parser tests
**Effort:** 8h · **Severity:** Medium
**Files:** `packages/flow-ast/src/parse.ts`
**Change:** 16 untested per-node parsers — add fixture-driven tests per node kind.
**Target agent:** dzupagent-test-dev

## CODE-008: hitl-kit test backfill
**Effort:** 6h · **Severity:** Medium
**Files:** `packages/hitl-kit/src/*` (4 prod files, 1 test, 531 LOC)
**Target agent:** dzupagent-test-dev

## CODE-009: Replace ~50 `console.*` calls with defaultLogger
**Effort:** 4h · **Severity:** Medium
**Files:** various non-test files
**Change:** Find replacements; ensure CLI entry points still print to stdout via the logger's appropriate level.
**Target agent:** dzupagent-core-dev

## CODE-014 + CODE-021: Replace 173 `as never` test casts
**Effort:** 10h combined · **Severity:** Low
**Files:** `packages/agent/src/__tests__/*` (132), `packages/connectors-browser/src/__tests__/*` (41)
**Change:** Build typed test-utils factories; remove `as never` once factories return correct types.
**Target agent:** dzupagent-test-dev

## CODE-015: codex-adapter.ts runStreamedThread depth-9 nesting
**Effort:** 6h · **Severity:** Medium
**Files:** `packages/agent-adapters/src/codex/codex-adapter.ts`
**Change:** Extract `parseEvent` / `dispatch` / `recover` stage helpers; flatten nesting to ≤4.
**Target agent:** dzupagent-connectors-dev

## CODE-016: pipeline-runtime.ts recovery block depth 9
**Effort:** 4h · **Severity:** Medium
**Files:** `packages/agent/src/pipelines/pipeline-runtime.ts`
**Change:** Extract recovery sub-state machine.
**Target agent:** dzupagent-agent-dev

## CODE-017: validate.ts:validateDefaults triple-nested accumulator
**Effort:** 2h · **Severity:** Low
**Files:** `packages/flow-ast/src/validate.ts`
**Change:** Replace nested forEach with flat reduce over composed predicate list.
**Target agent:** dzupagent-architect

## CODE-022: security/prompt-injection/patterns.ts dedicated coverage
**Effort:** 4h · **Severity:** Medium
**Files:** `packages/security/src/prompt-injection/patterns.ts`
**Change:** Pattern-by-pattern positive + negative test fixtures.
**Target agent:** dzupagent-test-dev

## CODE-023: eval-contracts + agent-types test ratio
**Effort:** 4h · **Severity:** Low
**Target agent:** dzupagent-test-dev

## CODE-024: event-types.ts test coverage / dedup with ARCH-021
**Effort:** 2h · **Severity:** Low (folded into ARCH-021)
**Target agent:** dzupagent-core-dev

---

## Per-domain detail

- `code-refactors.md` (11 P2 from Code domain)
- `security-refactors.md` (7 RFs from Security)
- `architecture-refactors.md` (11 ARCH refactors)
- `agent-refactors.md` (8 AGT refactors)
