# CROSS-DOMAIN-MATRIX: @dzupagent/agent + @dzupagent/agent-adapters

**Date:** 2026-05-03 | **Run:** run-001 | **Domains:** code, agent, architecture

| ID | Domain | Severity | Title | File:Line | Phase |
|----|--------|----------|-------|-----------|-------|
| C-01 | Code | P1/Critical | `DzupEventBus.emit()` uses `as never` casts throughout | `packages/agent/src/agent/dzip-agent.ts` (multiple) | quick |
| C-02 | Code | P1/Critical | Double-cast `as unknown as X` in orchestration emit | `packages/agent/src/orchestration/orchestrator.ts` | quick |
| C-03 | Code | P1/Critical | `executeStreamingToolCall` — 396-line function, 7-level nesting, no tests | `packages/agent/src/agent/run-engine.ts:523` | refactor |
| C-04 | Code | P1/Critical | `executeWithRecovery` + `executeWithRecoveryStream` 441+449 LOC near-duplicate | `packages/agent-adapters/src/recovery/adapter-recovery.ts:1` | refactor |
| C-05 | Code | P1/Critical | Floating Promise on journal write in agent-finalizers | `packages/agent/src/agent/agent-finalizers.ts` | quick |
| A-01 | Architecture | Critical | `AdapterWorkflowBuilder` directly imports concrete `PipelineRuntime` | `packages/agent-adapters/src/workflow/adapter-workflow.ts:42` | major |
| A-02 | Architecture | Critical | `ProviderExecutionPort` types in `@dzupagent/agent` instead of `@dzupagent/adapter-types` | `packages/agent-adapters/src/integration/provider-execution-port.ts:10` | refactor |
| AG-09 | Agent | High | No prompt-injection scanning on user input | `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:217` | major |
| AG-15 | Agent | High | Approval gate not durable across process restart | `packages/agent/src/approval/approval-gate.ts:147` | major |
| AG-12 | Agent | High | Anthropic prompt caching mentioned but never implemented | `packages/agent/src/agent/memory-context-loader.ts:88` | refactor |
| AG-08 | Agent | High | Memory write-back has no PII scrubbing | `packages/agent/src/agent/agent-finalizers.ts` | refactor |
| AG-06 | Agent | High | No first-class `MemoryClient` IPC contract | `packages/agent/src/agent/memory-context-loader.ts:98` | major |
| AG-01 | Agent | High | No tool-output schema validation | `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:212` | refactor |
| A-03 | Architecture | High | Orchestration config types independently redefined in both packages | `packages/agent/src/orchestration/orchestrator.ts:23` | major |
| A-04 | Architecture | High | Two parallel UCL implementations, 497 LOC duplicated parser | `packages/agent-adapters/src/ucl/frontmatter-parser.ts` | quick |
| A-05 | Architecture | High | `AdapterStuckDetector` near-copy of `StuckDetector` | `packages/agent-adapters/src/guardrails/adapter-guardrails.ts:101` | refactor |
| A-06 | Architecture | High | `OrchestratorFacade` god object — 909 LOC, 9 concerns | `packages/agent-adapters/src/facade/orchestrator-facade.ts:251` | major |
| A-07 | Architecture | High | `MemoryServiceLike` defined in 4 separate locations | `packages/agent-adapters/src/middleware/memory-enrichment.ts:36` | refactor |
| A-08 | Architecture | High | `TeamRuntime` (1,281 LOC) — LLM stubs, no `@experimental` | `packages/agent/src/orchestration/team/team-runtime.ts:22` | refactor |
| A-09 | Architecture | High | `AdapterRecoveryCopilot` god object — 1,250 LOC | `packages/agent-adapters/src/recovery/adapter-recovery.ts:1` | major |
| H-01 | Code | P2/High | `DynamicToolRegistry` has 21 public methods | `packages/agent/src/agent/tool-registry.ts` | refactor |
| H-02 | Code | P2/High | Two exported `TeamCoordinator`/`TeamRuntime` implement same patterns | `packages/agent/src/playground/team-coordinator.ts` | quick |
| H-03 | Code | P2/High | Triplicate skill-validator boilerplate across 3 adapter files | `packages/agent-adapters/src/claude/claude-adapter.ts` | refactor |
| H-04 | Code | P2/High | Duplicated token-extraction logic in Claude + Codex adapters | `packages/agent-adapters/src/claude/claude-adapter.ts` | quick |
| H-05 | Code | P2/High | Dead `playground/ui/` module (zero imports) | `packages/agent/src/playground/` | quick |
| H-06 | Code | P2/High | `void` suppression on timing variables hides race conditions | `packages/agent/src/agent/dzip-agent.ts` | refactor |
| H-07 | Code | P2/High | Swallowed errors in mailbox message handler | `packages/agent/src/mailbox/mailbox.ts` | refactor |
| H-08 | Code | P2/High | Zero tests on `policy-enabled-tool-executor.ts` (337 LOC central enforcer) | `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts` | refactor |
| H-09 | Code | P2/High | Zero tests on `daemon-launcher.ts` and `mailbox/` module | `packages/agent/src/agent/daemon-launcher.ts` | major |
| H-10 | Code | P2/High | Zero tests on `ucl/skill-loader.ts` | `packages/agent-adapters/src/ucl/skill-loader.ts` | quick |
| AG-02 | Agent | Medium | No per-tool retry/backoff in tool loop | `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:194` | refactor |
| AG-03 | Agent | Medium | `tools/create-tool.ts` is an 8-line stub | `packages/agent/src/tools/create-tool.ts:1` | refactor |
| AG-04 | Agent | Medium | Tool argument validator hand-rolls JSON Schema subset | `packages/agent/src/agent/tool-arg-validator.ts:27` | refactor |
| AG-07 | Agent | Medium | Memory decay engine not wired into agent loop | `packages/agent/src/agent/memory-context-loader.ts:185` | refactor |
| AG-10 | Agent | Medium | No global LLM rate limiting | `packages/agent/src/agent/dzip-agent.ts:709` | refactor |
| AG-11 | Agent | Medium | Cost rate table stale + ignores cached tokens | `packages/agent-adapters/src/middleware/cost-tracking.ts:27` | refactor |
| AG-14 | Agent | Medium | Stuck detector purely syntactic — no semantic plateau detection | `packages/agent/src/guardrails/stuck-detector.ts:53` | refactor |
| AG-16 | Agent | Medium | No streaming back-pressure or chunk re-assembly | `packages/agent/src/streaming/streaming-run-handle.ts` | refactor |
| AG-17 | Agent | Medium | Structured-output extractor uses heuristic JSON repair | `packages/agent/src/agent/structured-generate.ts:285` | quick |
| AG-20 | Agent | Medium | `WorkflowBuilder` lacks failure-recovery edges | `packages/agent/src/workflow/workflow-builder.ts:69` | major |
| AG-21 | Agent | Medium | No orchestration-level stuck detector | `packages/agent/src/orchestration/orchestrator.ts:117` | refactor |
| AG-25 | Agent | Medium | No CI enforcement of agent-adapters layer boundary | repo root | quick |
| A-10 | Architecture | Medium | Duplicate structured-output implementations in both packages | `packages/agent-adapters/src/output/structured-output.ts:361` | refactor |
| A-11 | Architecture | Medium | `ConversationCompressor` duplicates `autoCompress` from `@dzupagent/context` | `packages/agent-adapters/src/session/conversation-compressor.ts:83` | refactor |
| A-12 | Architecture | Medium | Claude + Codex adapters don't extend `BaseCliAdapter` | `packages/agent-adapters/src/claude/claude-adapter.ts` | refactor |
| A-13 | Architecture | Medium | `AdapterHttpHandler` (794 LOC) HTTP layer in adapter package | `packages/agent-adapters/src/http/adapter-http-handler.ts:1` | major |
| A-14 | Architecture | Medium | `pipeline-runtime.ts` statically imports Postgres + Redis stores | `packages/agent/src/pipeline/pipeline-runtime.ts:19` | quick |
| A-15 | Architecture | Medium | `@dzupagent/agent` barrel exports 750+ symbols — internals leak | `packages/agent/src/index.ts:1` | major |
| A-16 | Architecture | Medium | `ApprovalMode`/`ApprovalResult` redeclared in both packages | `packages/agent/src/approval/approval-types.ts:4` | quick |
| A-17 | Architecture | Medium | 55 bare `console.*` calls — no structured logger | `packages/agent-adapters/src/codex/codex-adapter.ts:565` | refactor |
| M-01 | Code | P3/Medium | `team-runtime.ts` 1,281 LOC with stub LLM invocations, no `@experimental` | `packages/agent/src/orchestration/team/team-runtime.ts:22` | refactor |
| M-02 | Code | P3/Medium | Duplicated pipeline error tail in run-engine + pipeline-runtime | `packages/agent/src/agent/run-engine.ts` | quick |
| M-03 | Code | P3/Medium | Three `void` suppressions in `md-frontmatter-parser.ts` | `packages/agent-adapters/src/dzupagent/md-frontmatter-parser.ts` | quick |
| M-04 | Code | P3/Medium | Silently swallowed reflection-loop errors | `packages/agent/src/reflection/reflection-loop.ts` | quick |
| M-05 | Code | P3/Medium | Wrong `approval:requested` payload — missing `runId` | `packages/agent/src/approval/approval-gate.ts:147` | quick |
| M-06 | Code | P3/Medium | Untested UCL memory-loader and agent-loader (355+349 LOC) | `packages/agent-adapters/src/dzupagent/memory-loader.ts` | major |
| M-07 | Code | P3/Medium | `AgentOrchestrator.parallel` has no max-concurrency guard | `packages/agent/src/orchestration/orchestrator.ts` | refactor |
| M-08 | Code | P3/Medium | Structured output repair loop has no max-attempts guard | `packages/agent/src/agent/structured-generate.ts:285` | quick |
| M-09 | Code | P3/Medium | `OutputRefinementLoop` has no convergence check | `packages/agent/src/self-correction/output-refinement-loop.ts` | refactor |
| AG-22 | Agent | Low | `iteration-budget.ts` config mutation is unsafe | `packages/agent/src/guardrails/iteration-budget.ts:60` | quick |
| AG-23 | Agent | Low | `scanFailureMode` defaults to `fail-open` | `packages/agent/src/agent/tool-loop.ts:255` | quick |
| AG-18 | Agent | Low | Recovery strategy ignores cost budget state | `packages/agent-adapters/src/recovery/recovery-strategy.ts` | refactor |
| AG-19 | Agent | Low | Provider failover blocked after tool calls — no idempotent override | `packages/agent/src/agent/dzip-agent.ts:226` | refactor |
| AG-24 | Agent | Low | Checkpoint shape recognition hardcoded in tool executor | `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:392` | refactor |
| A-18 | Architecture | Low | `./workflow` subpath missing `PipelineRuntime` | `packages/agent/package.json` | quick |
| A-19 | Architecture | Low | `DzupError` re-exported twice in same package | `packages/agent-adapters/src/providers.ts:102` | quick |
| A-20 | Architecture | Low | `MemoryProfile` presets in wrong package | `packages/agent/src/agent/memory-profiles.ts` | refactor |
| L-01 | Code | P4/Low | Redundant `void` cast in Claude adapter cleanup | `packages/agent-adapters/src/claude/claude-adapter.ts` | quick |
| L-02 | Code | P4/Low | `void` cast in contract-net bidding path | `packages/agent/src/orchestration/contract-net/contract-net-types.ts` | quick |
| L-03 | Code | P4/Low | `void` cast in file-loader cleanup | `packages/agent-adapters/src/dzupagent/agent-loader.ts` | quick |
| L-04 | Code | P4/Low | Inconsistent `console.*` vs event-bus error reporting | `packages/agent-adapters/src/codex/codex-adapter.ts:565` | refactor |
| AG-05 | Agent | Low | OTel tracing disconnected between tool loop and adapter spans | `packages/agent/src/agent/tool-loop.ts:354` | major |
| AG-13 | Agent | Low | `auto-compress.ts` is a 6-line re-export shim | `packages/agent/src/context/auto-compress.ts:1` | quick |
