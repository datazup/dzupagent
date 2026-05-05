# Full-Spectrum Audit: `@dzupagent/agent` + `@dzupagent/agent-adapters`

**Date:** 2026-05-05  
**Run:** run-001  
**Domains:** Code Quality, Architecture, Agent Patterns  
**Prior run:** `audit/full-agent-agent-adapters-2026-05-03/run-001`

---

## Risk Matrix

| Domain | Critical | High | Medium | Low | Total |
|--------|----------|------|--------|-----|-------|
| Code Quality | 0 | 4 | 14 | 9 | 27 |
| Architecture | 0 | 4 | 8 | 6 | 18 |
| Agent Patterns | 2 | 18 | 23 | 9 | 52 |
| **TOTAL** | **2** | **26** | **45** | **24** | **97** |

---

## Top 10 Priority Actions

1. **[Critical / Agent]** Prompt caching not implemented in Claude adapter — `claude-adapter.ts:632-693` — 50-90% cost savings foregone on every Claude-powered run. (C-01 / AGENT-020 / AGENT-050)

2. **[High / Agent]** `workspace-write` sandbox mode maps to `bypassPermissions` — `claude-adapter.ts:127-141` — security defect: scoped-write permission silently escalates to full bypass. (AGENT-054)

3. **[High / Architecture]** `agent` test imports `@dzupagent/server` (boundary violation, undeclared dep) — `workflow-durability-integration.test.ts:14`. (ARCH-001)

4. **[High / Code]** `executeStreamingToolCall` is 396 LOC with cyclomatic complexity ~25 — `run-engine.ts:634-1030`. (CODE-009)

5. **[High / Code]** `runToolLoop` outer `for` body is 268 LOC with 67 branches — `tool-loop.ts:524-792`. (CODE-010, AGENT-002)

6. **[High / Agent]** No LLM-call audit logging — compliance/audit trail missing across all runs. (AGENT-030)

7. **[High / Agent]** PII/prompt-injection scan does NOT cover tool results before they enter LLM context — `run-engine.ts:259-307`. (AGENT-032)

8. **[High / Agent]** Two parallel stuck-detection implementations (5 modes vs 3 modes) — drift risk. (AGENT-031)

9. **[High / Code]** `RecoveryAttemptHandler` is 658 LOC with zero direct unit tests — `recovery-attempt-handler.ts`. (CODE-015)

10. **[High / Architecture]** `PipelineRuntime` is 1,029 LOC monolith despite helper modules existing in `pipeline-runtime/` — same anti-pattern that OrchestratorFacade was just fixed for. (ARCH-006, AGENT-041)

---

## Baseline Metrics

| Metric | Value |
|--------|-------|
| TypeScript errors | 0 (all 55 packages pass typecheck) |
| Source files | 693 |
| Test files | 324 |
| Lint warnings | 0 |
| `@dzupagent/agent` tests | 3,768 passed / 1 todo (184 files) |
| `@dzupagent/agent-adapters` tests | 2,656 passed / 3 failing (140 files) |
| Failing tests | `adapter-registry.test.ts:1` (AGENT_ABORTED fallback), `codex-adapter.test.ts:2` (error item mapping) |

---

## Delta from 2026-05-03 Audit

**Resolved (MC sprint 2026-05-04):**
- ✅ OrchestratorFacade 909 LOC → 279 LOC (refactored)
- ✅ Security package added (95 tests)
- ✅ MemoryClient interface implemented
- ✅ Durable approvals implemented + `approval-gate-durable.test.ts`
- ✅ RecoveryCopilot 172 LOC extracted
- ✅ Subpath exports added
- ✅ Orchestration base contracts in `agent-types`

**Still open from prior audit:**
- ❌ Prompt caching (AGENT-020/AGENT-050) — Critical, unaddressed
- ❌ `as never` event casts (15 sites) — partially: OrchestratorFacade casts fixed, but 14 remain in tool-loop hot paths
- ❌ Floating promise / approval payload bug — not confirmed resolved
- ❌ PipelineRuntime DI gap — AGENT-046 still open
- ❌ No prompt-injection scan in `agent-adapters` guardrails

**New findings this run:** 61 net-new findings not in 2026-05-03 audit.

---

## Implementation Estimate

| Phase | Tasks | Total Effort |
|-------|-------|-------------|
| Quick Fixes (QF) | 17 tasks | ~20 hours |
| Refactors (RF) | 15 tasks | ~70 hours |
| Major Changes (MC) | 10 tasks | ~180 hours |
| **Total** | **42 tasks** | **~270 hours** |

**Recommended sprint sequence:**
1. **Sprint A (1 week):** QF-01 through QF-17 — all quick fixes (20h). Eliminates all Critical + most High quick items.
2. **Sprint B (2 weeks):** RF-03, RF-04, RF-05, RF-07, RF-08, RF-09, RF-11, RF-15 — core quality refactors (40h). Addresses tool-loop monolith, stuck detection unification, security scan gap.
3. **Sprint C (3 weeks):** MC-01 (prompt caching), MC-03 (TeamRuntime patterns), MC-04 (AdapterStreamRunner). These are the highest ROI major changes.
4. **Sprint D (ongoing):** MC-02 (memory consolidation), MC-07 (distributed budget), MC-08 (real tokenizer), MC-09 (DzupEvent extension typing).

---

## Output Files

```
run-001/
├── README.md                     ← this file
├── docs/
│   ├── CODE-AUDIT.md             ← 27 code quality findings
│   ├── ARCHITECTURE-AUDIT.md     ← 18 architecture findings
│   ├── AGENT-AUDIT.md            ← 52 agent pattern findings
│   ├── CROSS-DOMAIN-MATRIX.md    ← all 97 findings in one table
│   └── RECOMMENDATIONS.md        ← unified prioritised recommendations
├── prompts/
│   ├── quick-fixes.md            ← 17 self-contained QF prompts (1-2h each)
│   ├── refactors.md              ← 15 RF prompts (4-8h each)
│   └── major-changes.md         ← 10 MC prompts (16h+ each)
└── logs/
    └── baseline.log              ← metrics snapshot
```
