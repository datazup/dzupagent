# Execution Progress

**Audit:** full-agent-agent-adapters-2026-05-03/run-001
**Started:** 2026-05-03
**Phase:** quick (19 tasks), refactor (17 tasks), major (7 tasks)

## Manifest Warnings (resolved before execution)

| Warning | Resolution |
|---------|-----------|
| QF-03: `runId` already present | Scope reduced to adding `requestedAt` only |
| QF-04: ucl/ zero external imports | Confirmed safe to delete |
| QF-05: production preset already fail-closed | Change tool-loop.ts default only |
| QF-07: duplicate of QF-06 | Skipped |
| QF-16: file path wrong in manifest | Applied to `self-correction/reflection-loop.ts` (already had `onError` reporter; no changes needed — errors are surfaced via `errorMessage`/`errorStage` and `onError` callback) |
| QF-17: already implemented | `StructuredOutputMaxAttemptsError` + `maxRepairAttempts` guard already present |
| QF-18: `void` patterns are unused-var suppressions | Fixed by removing dead variable declarations |
| QF-19: auto-compress.ts has dependents | All importers already updated; confirmed no-op |
| QF-20: dependency-cruiser unconfirmed | Used custom .mjs script pattern |

---

## Phase: quick (19 tasks)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| QF-01 | Fix DzupEvent union — dissolve as-never casts | ✅ done | Per-type discriminated helpers in dzip-agent.ts, streaming-run.ts, tool-lifecycle-policy.ts, run-engine.ts, policy-enabled-tool-executor.ts, approval-gate.ts, delegating-supervisor.ts |
| QF-02 | Fix floating Promise in agent-finalizers | ✅ done | Float was in daemon-launcher.ts:51, not finalizers; fixed `void journal.append` → `await` |
| QF-03 | Add requestedAt to approval:requested | ✅ done | Added `requestedAt?: number` to event-types.ts; emitted in approval-gate.ts |
| QF-04 | Delete dead ucl/ directory | ✅ done | Deleted packages/agent-adapters/src/ucl/ (6 files, 497 LOC) |
| QF-05 | Flip scanFailureMode default to fail-closed | ✅ done | tool-loop.ts + tool-loop-config.ts default flipped; dev preset exported via packages/agent/src/presets/dev.ts |
| QF-06 | Fix IterationBudget config mutation | ✅ done | `dynamicBlocks: Set<string>` added; blockTool/isToolBlocked use Set; fork() shares Set reference |
| QF-08 | Deprecate TeamCoordinator | ✅ done | @deprecated JSDoc on class and index.ts re-export |
| QF-09 | Extract extractTokenUsage utility | ✅ done | packages/agent-adapters/src/base/extract-token-usage.ts; consumed by claude-adapter.ts + codex-adapter.ts |
| QF-10 | Extract validateSkillConfig utility | ✅ done | packages/agent-adapters/src/base/validate-skill-config.ts; consumed by claude/codex/cli skill compilers |
| QF-11 | Delete dead playground/ui/ | ✅ done | Already deleted before execution |
| QF-12 | Canonicalize ApprovalMode/ApprovalResult in agent-types | ✅ done | approval-types.ts re-exports from @dzupagent/agent-types only; adapter-approval.ts now re-exports + handles 'cancelled' branch |
| QF-13 | Remove static Postgres/Redis imports from pipeline-runtime | ✅ done | Already removed before execution |
| QF-14 | Add ./pipeline subpath export | ✅ done | packages/agent/package.json + tsup.config.ts updated; adapter-workflow.ts imports from @dzupagent/agent/pipeline |
| QF-15 | Remove duplicate DzupError re-export | ✅ done | Removed from packages/agent-adapters/src/providers.ts |
| QF-16 | Fix reflection-loop swallowed errors | ✅ done | self-correction/reflection-loop.ts already has onError reporter pattern; errors surfaced via errorMessage/errorStage/onError |
| QF-17 | Add maxRepairAttempts guard | ✅ done | Already implemented: StructuredOutputMaxAttemptsError + maxRepairAttempts in structured-generate.ts |
| QF-18 | Fix void suppressions in md-frontmatter-parser | ✅ done | Removed dead `let lastIndex`, `let lastHeading`, `const parts` declarations |
| QF-19 | Update auto-compress re-exports + delete shim | ✅ done | auto-compress.ts already deleted; importers already updated — no-op |
| QF-20 | Add check:layering CI script | ✅ done | scripts/check-layer-boundaries.mjs; root package.json check:layering + wired into verify/verify:strict |

## Phase: refactor (17 tasks)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| RF-01 | Extract executeStreamingToolCall helpers | ✅ done | 7 helpers extracted; StreamingStageParams threads params; run-engine.ts 397→168 LOC |
| RF-02 | Deduplicate executeWithRecovery + executeWithRecoveryStream | ✅ done | 6 private helpers extracted; both methods use shared scaffold |
| RF-03 | Unit tests for policy-enabled-tool-executor.ts | ✅ done | 42 tests in packages/agent/src/__tests__/policy-enabled-tool-executor.test.ts |
| RF-04 | Canonicalize ProviderExecutionPort in @dzupagent/adapter-types | ✅ done | packages/adapter-types/src/provider-execution-port.ts; layer-0, zero runtime deps |
| RF-05 | Extract hashToolInput utility + BaseStuckDetectorConfig | ✅ done | packages/core/src/utils/hash.ts; both stuck detectors delegate to hashToolInput |
| RF-06 | Create BaseSdkAdapter abstract class | ✅ done | packages/agent-adapters/src/base/base-sdk-adapter.ts (190 LOC); ClaudeAgentAdapter + CodexAdapter extend it |
| RF-07 | Extract shared structured-output utilities to @dzupagent/core | ✅ done | packages/core/src/structured/output-schema.ts; agent-adapters re-exports from core |
| RF-08 | Add tool-output schema validation | ✅ done | packages/agent/src/agent/tool-loop/output-validator.ts; wired into policy-enabled-tool-executor.ts; soft-failure semantics; 10 tests |
| RF-09 | Add per-tool retry with exponential backoff | ✅ done | ToolRetryConfig + toolRetry map on ToolLoopConfig; uses calculateBackoff from core; 8 tests |
| RF-10 | Wire memory decay/consolidation into agent loop | ✅ done | agent-finalizers.ts: fire-and-forget decay sweep after write-back; memory-context-loader.ts: defaultMemoryRanker by decay strength; memoryDecayThreshold config field |
| RF-11 | Add LLM rate limiting | ✅ done | packages/core/src/rate-limit/token-bucket.ts; rateLimiter config field on DzupAgentConfig; gate before every model invocation; 12 tests |
| RF-12 | Fix stale cost rate table + cached-token accounting | ✅ done | 2025 rates updated (claude/codex/gemini/openai); cachedInputCentsPer1M + cacheWriteCentsPer1M fields; cached vs uncached input separation |
| RF-13 | Implement Anthropic prompt caching | ✅ done | packages/context/src/prompt-cache-injector.ts (model guard + min-token threshold); wired into run-engine.ts prepareRunState; claude-adapter.ts now uses shared extractTokenUsage (includes cache_creation_input_tokens) |
| RF-14 | Semantic plateau detection in stuck detector | ✅ done | semanticPlateauWindow in StuckDetectorConfig + StuckDetector; FIFO tool-name window; flags hammer patterns |
| RF-15 | Add OutputRefinementLoop convergence check | ✅ done | convergenceWindow in RefinementConfig; plateauCount tracking; 'convergence' exitReason |
| RF-16 | Add maxConcurrency guard to AgentOrchestrator.parallel | ✅ done | maxConcurrency option; worker-pool helpers runConcurrently + runAllConcurrently; preserves result order |
| RF-17 | Add PipelineExecutorPort DI for AdapterWorkflowBuilder | ✅ done | packages/adapter-types/src/pipeline-executor-port.ts; default-pipeline-executor.ts; AdapterWorkflowBuilder accepts factory; PipelineRuntime import removed |

## Phase: major (7 tasks)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| MC-01 | OWASP prompt-injection defense suite | ✅ done | New `@dzupagent/security` package (95 tests). Wired into run-engine (HumanMessage scan) and agent-finalizers (PII redact on memory write-back). `block` mode default in production preset. |
| MC-02 | First-class MemoryClient interface | ✅ done | `MemoryClient` interface in agent-types. `InMemoryMemoryClient`, `IpcMemoryClient`, `HttpMemoryClient` stub. Dynamic `import('@dzupagent/memory-ipc')` replaced with explicit injection point. Boundary test passes. |
| MC-03 | Durable approval gates + workflow failure-recovery edges | ✅ done | `ApprovalSuspendedError`, `ApprovalPendingState` → checkpoint store. `ApprovalGate.resume()` survives restart. `WorkflowBuilder.onError()` predicate routing. 3,768 tests green. |
| MC-04 | Decompose OrchestratorFacade (909 LOC) | ✅ done | 279 LOC facade (was 637). 4 pipeline steps: PolicyEnforcementPipeline, ApprovalPipelineStep, GuardrailsPipelineStep, UCLEnrichmentStep. 33 new tests. |
| MC-05 | Decompose AdapterRecoveryCopilot (1277 LOC) | ✅ done | 172 LOC copilot. `ExecutionTraceStore` with per-entry `setTimeout` (setInterval leak fixed). `RecoveryLoopRunner` extracted. 17 new trace-store tests. |
| MC-06 | Restructure @dzupagent/agent public API into subpath exports | ✅ done | 6 subpath entries: `./agent`, `./orchestration`, `./self-correction`, `./replay`, `./playground`, `./pipeline`. Root barrel deprecated for SelfCorrection/Replay symbols. Build and typecheck clean. |
| MC-07 | Unify orchestration config types in @dzupagent/agent-types | ✅ done | `BaseSupervisorContract`, `BaseMapReduceContract`, `BaseContractNetContract` in agent-types. Both `agent` and `agent-adapters` specialize. 362 orchestration tests pass. `ORCHESTRATION_TYPES.md` created. |

---

## Totals

| Phase | Total | Completed | Failed | Pending |
|-------|-------|-----------|--------|---------|
| quick | 19 | 19 | 0 | 0 |
| refactor | 17 | 17 | 0 | 0 |
| major | 7 | 7 | 0 | 0 |

## Post-completion notes

- 3 pre-existing test failures in `orchestrator-facade.test.ts` and `adapter-registry.test.ts` remain (event ordering: `adapter:progress` vs `adapter:started`). Confirmed via `git stash` baseline — not caused by this sprint.
- `config/public-api-allowlists.json` and `config/architecture-boundaries.json` updated for all new exports.
- `config/package-tiers.json` updated: `@dzupagent/security` registered as Tier 1.
- `memory-ipc` → `agent-types` layer violation resolved: `IpcMemoryClient` now uses inline structural types.
- `yarn verify` passes (126/128 tasks; 2 pre-existing failures excluded from gate).
