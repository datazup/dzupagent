# Full-Spectrum Audit: @dzupagent/agent + @dzupagent/agent-adapters
**Date:** 2026-05-03
**Run:** run-001
**Domains:** code, agent, architecture

---

## Risk Matrix

| Domain | Critical | High | Medium | Low | Total |
|--------|----------|------|--------|-----|-------|
| Code Quality | 5 | 10 | 9 | 4 | 28 |
| Architecture | 2 | 7 | 8 | 3 | 20 |
| Agent Patterns | 0 | 7 | 11 | 7 | 25 |
| **TOTAL** | **7** | **24** | **28** | **14** | **73** |

---

## Top 10 Priority Actions

1. **[Critical / Code]** `DzupEventBus.emit()` uses `as never` / `as unknown as X` casts throughout — fix the `DzupEvent` union in `@dzupagent/core` — `packages/core/src/event-bus.ts`
2. **[Critical / Code]** Floating Promise on journal write — `packages/agent/src/agent/agent-finalizers.ts`
3. **[Critical / Code]** `approval:requested` event missing `runId` field — `packages/agent/src/approval/approval-gate.ts:147`
4. **[Critical / Architecture]** `AdapterWorkflowBuilder` imports concrete `PipelineRuntime` — missing `PipelineExecutorPort` DI — `packages/agent-adapters/src/workflow/adapter-workflow.ts:42`
5. **[Critical / Architecture]** `ProviderExecutionPort` types belong in `@dzupagent/adapter-types` not `@dzupagent/agent` — `packages/agent-adapters/src/integration/provider-execution-port.ts:10`
6. **[High / Agent]** No prompt-injection scanning on user input (OWASP LLM-01) — `packages/agent/src/agent/run-engine.ts` (prepareRunState)
7. **[High / Agent]** Memory write-back has no PII scrubbing — `packages/agent/src/agent/agent-finalizers.ts`
8. **[High / Agent]** Approval gate not durable across process restart — `packages/agent/src/approval/approval-gate.ts:147`
9. **[High / Code]** `executeStreamingToolCall` — 396-line function, 7-level nesting, no direct unit tests — `packages/agent/src/agent/run-engine.ts:523`
10. **[High / Agent]** Anthropic prompt caching declared but never implemented — `packages/agent/src/agent/memory-context-loader.ts:88`

---

## Baseline Metrics

| Metric | `@dzupagent/agent` | `@dzupagent/agent-adapters` |
|--------|-------------------|-----------------------------|
| TypeScript source files | 385 | 268 |
| Test files | 179 | 134 |
| TypeScript errors | 0 | 0 |
| Lint warnings | 0 | 0 |
| Largest file (LOC) | `team-runtime.ts` ~1,281 | `recovery.ts` ~1,250 |
| Public barrel exports | ~750 symbols | ~300 symbols |

---

## Implementation Estimate

| Phase | Task Count | Total Effort |
|-------|-----------|-------------|
| Quick Fixes (≤2h each) | 20 | ~25 hours |
| Refactors (4–8h each) | 17 | ~85 hours |
| Major Changes (16h+) | 7 | ~120 hours |
| **Total** | **44** | **~230 hours** |

At 2 engineers: ~6 sprints (2-week each)
At 3 engineers: ~4 sprints

---

## Domain Highlights

### Code Quality
Both packages are TypeScript-clean (0 errors, 0 lint warnings) and have reasonable test coverage (179/385 = 46% test files in agent; 134/268 = 50% in agent-adapters). However:
- 5 critical-severity issues: unsafe `as never` event-bus casts (C-01, C-02), 396-line god function (C-03), 890-line duplicate recovery methods (C-04), floating promise on memory write (C-05)
- The largest untested code path is `policy-enabled-tool-executor.ts` (337 LOC), the central tool enforcement function
- `TeamRuntime` (1,281 LOC) and `AdapterRecoveryCopilot` (1,250 LOC) are god-file outliers

### Architecture
The layer boundary is correctly maintained — `@dzupagent/agent` does not import from `@dzupagent/agent-adapters`. Two critical violations:
- `PipelineRuntime` (concrete class) used in `agent-adapters` without a DI port — should use `PipelineExecutorPort` in `@dzupagent/core`
- `ProviderExecutionPort` types defined in `@dzupagent/agent` instead of `@dzupagent/adapter-types`

Seven high-severity architecture issues center on: duplicate UCL implementations (497 LOC dead `ucl/` parser), `OrchestratorFacade` god object (909 LOC, 9 concerns), `AdapterRecoveryCopilot` god object (1,250 LOC), `MemoryServiceLike` interface in 4 places, and identical orchestration config types in both packages.

### Agent Patterns
Overall agent pattern quality is strong (scores 3-5/5 across all areas). Critical gaps:
- **Security**: No prompt-injection scanning on user input (OWASP LLM-01). `scanFailureMode` defaults to `fail-open` (inverted security default). No PII scrubbing on memory write-back.
- **LLM Integration**: Anthropic prompt caching never implemented despite being referenced in code comments (losing 10× cost discount on repeated context). Cost rate table is stale and ignores cached-token pricing.
- **Durability**: Approval gate is in-memory `setTimeout` — dies on process restart. No `WorkflowBuilder.onError()` for declarative recovery.
- **Existing strengths**: Excellent tool-loop architecture (policy gates, approval, safety scan, checkpoint detection). Strong orchestration patterns. Well-designed `BaseCliAdapter` for spawn-based adapters.

---

## Output Files

```
audit/full-agent-agent-adapters-2026-05-03/run-001/
├── README.md                        — this file
├── docs/
│   ├── CODE-AUDIT.md                — 28 findings (5 P1, 10 P2, 9 P3, 4 P4)
│   ├── ARCHITECTURE-AUDIT.md        — 20 findings (2 Critical, 7 High, 8 Medium, 3 Low)
│   ├── AGENT-AUDIT.md               — 25 findings (0 Critical, 7 High, 11 Medium, 7 Low)
│   ├── CROSS-DOMAIN-MATRIX.md       — 73 findings consolidated table
│   └── RECOMMENDATIONS.md           — 39 unified prioritised recommendations
├── prompts/
│   ├── quick-fixes.md               — 20 P1 tasks (≤2h each)
│   ├── refactors.md                 — 17 P2 tasks (4–8h each)
│   └── major-changes.md             — 7 P3 tasks (16h+ each)
└── logs/
    └── baseline.log                 — metrics before any changes
```

---

## Next Steps

Run `/analyze-implement audit/full-agent-agent-adapters-2026-05-03/run-001` to execute fixes using the agent matrix.

**Recommended sprint order:**
1. **Sprint 1 (Quick):** QF-01 through QF-20 — all quick fixes, ~25h total. Focus on C-01 (type safety), QF-05 (fail-closed), QF-06 (iteration budget), QF-03 (approval payload), QF-04 (delete UCL).
2. **Sprint 2 (Refactor A):** RF-03 (executor tests), RF-01 (extract streaming), RF-02 (dedup recovery), RF-08 (output validation), RF-13 (prompt caching)
3. **Sprint 3 (Refactor B):** RF-04 (port types), RF-05 (hash util), RF-06 (BaseSdkAdapter), RF-09 (per-tool retry), RF-11 (rate limiting)
4. **Sprint 4 (Major Security):** MC-01 (prompt injection defense) — requires its own sprint due to scope
5. **Sprint 5 (Major Architecture):** MC-04 (OrchestratorFacade), MC-05 (AdapterRecoveryCopilot), MC-02 (MemoryClient)
6. **Sprint 6 (Major Durability):** MC-03 (durable approval + workflow onError), MC-06 (API subpath exports), MC-07 (orchestration type unification)
