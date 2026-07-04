# SDD Progress: Runtime-Determinism Primitives (2026-07-03)

Plan: workspace-docs/repos/dzupagent/docs/plans/2026-07-03-runtime-determinism-primitives-implementation-plan.md
Branch: feat/runtime-determinism-primitives, base main@7a038abf
Worktree: /media/ninel/Third/code/datazup/ai-internal-dev/.worktrees-dzupagent/runtime-determinism-primitives

## Tasks (8 total, 3 phases)

- Task 1 (persistence barrel merge): pending
- Task 2 (RunStateApi): pending
- Task 3 (InterruptOutcome contract, adapter-types): pending
- Task 4 (hitl-kit ApprovalOutcome alias): pending
- Task 5 (SpawnGate migration): pending
- Task 6 (RunJournal flushPolicy + durability doc): pending
- Task 7 (ReplayController fork): pending
- Task 8 (whole-workspace verification): pending

## Log

Task 1: complete (commit 7a038abf..1d760ded, review clean — spec ✅, quality Approved). Barrel merge: persistence/index.ts now canonical superset (added InMemoryRunStore/InMemoryAgentStore, InMemoryEventLog/EventLogSink, InMemoryRunStateStore, InMemoryRunRecordStore, DeltaRunStateStore + types); persistence.ts reduced to single re-export line; core/src/index.ts untouched (confirmed). 2/2 barrel test, 4715/4715 full core suite, 58/58 dependent-package typecheck. Reviewer noted `versioned-context-backend.ts` remains unexposed by either barrel — OUT OF SCOPE by design (not named in brief/spec, is a separate "designed-but-not-adopted" module per original exploration) — not a gap, no follow-up needed.
Task 2: complete (commit 20536baa..dd643904, review clean — spec ✅, quality Approved). RunStateApi (getState/getStateHistory) over DzupRunStateStore+RunJournal in new run-state-api.ts. Implementer corrected 2 real bugs in the plan's sketched code (RunJournalQuery uses afterSeq not fromSeq/toSeq; resumeToken belongs to RunResumedEntry not RunPausedEntry) — both independently re-verified by reviewer against live run-journal-types.ts, confirmed accurate. summarizeEntry exhaustive over all 13 real entry types w/ never-check. 3/3 new tests, 4718/4718 full core suite.
Task 3: complete (commit dd643904..81cd0819, review clean — spec ✅, quality Approved). InterruptOutcome/InterruptGate/deriveInterruptId in new packages/adapter-types/src/contracts/interrupt.ts, barrel-exported. 2/2 new tests, 56/56 full package suite. MINOR(carry to final): test file placed at src/contracts/__tests__/interrupt.test.ts per brief's literal instruction, but package convention is flat src/__tests__/ importing from barrel — cosmetic, no functional impact, candidate normalize-later.
Task 4: complete (commit 16be83ac..9ce461b9, review clean — spec ✅, quality Approved). ApprovalOutcome aliased to shared InterruptOutcome. REAL BLOCKER hit + resolved: discriminated union broke 31 un-narrowed test assertions in hitl-approval-gate-deep.test.ts (runtime expect().toBe() isn't a TS type guard) — controller-authorized fix: add real if/throw narrowing before .response/.reason access at all 31 sites, zero assertion values changed, verified by reviewer against real InterruptOutcome union. package.json dependency pinned "0.2.0" matching subagents' convention (brief said "*", correctly deviated). 248/248 tests, typecheck 0 errors, 53/53 blast-radius tasks.
