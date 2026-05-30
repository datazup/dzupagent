# Cross-Domain Finding Matrix

**Date:** 2026-05-05  
**Scope:** `@dzupagent/agent` + `@dzupagent/agent-adapters`  
**Domains:** Code Quality (CODE), Architecture (ARCH), Agent Patterns (AGENT)

| ID | Domain | Severity | Title | File:Line | Phase | Agent |
|----|--------|----------|-------|-----------|-------|-------|
| AGENT-020 | Agent / Context | Critical | Prompt caching not implemented in Claude adapter | `claude-adapter.ts:632-693` | refactor | dzupagent-connectors-dev |
| AGENT-050 | Agent / LLM | Critical | Prompt caching not implemented (adapter side) | `claude-adapter.ts:632-693` | refactor | dzupagent-connectors-dev |
| AGENT-054 | Agent / LLM | High | workspace-write maps to bypassPermissions (security) | `claude-adapter.ts:127-141` | quick | dzupagent-connectors-dev |
| ARCH-001 | Architecture | P1/High | `agent` test imports `@dzupagent/server` (boundary violation) | `workflow-durability-integration.test.ts:14` | quick | dzupagent-agent-dev |
| ARCH-002 | Architecture | P1/High | `agent-adapters` test uses sibling relative path | `structured-output-parity.test.ts:17-18` | quick | dzupagent-agent-dev |
| ARCH-003 | Architecture | P1/High | No automated boundary enforcement test | `packages/agent/__tests__/boundary/` | quick | dzupagent-agent-dev |
| ARCH-004 | Architecture | P1/High | flow-compiler ownership undeclared in deps | `adapter-workflow.ts:8-12` | quick | dzupagent-architect |
| CODE-001 | Code | P1/High | `agent:rate_limited` missing from DzupEvent union | `dzip-agent.ts:730` | quick | dzupagent-core-dev |
| CODE-009 | Code | P1/High | `executeStreamingToolCall` is 396 LOC (~25 cyclomatic) | `run-engine.ts:634-1030` | refactor | dzupagent-agent-dev |
| CODE-010 | Code | P1/High | `runToolLoop` is 336 LOC with 67 branches | `tool-loop.ts:489-825` | refactor | dzupagent-agent-dev |
| CODE-015 | Code | P1/High | `RecoveryAttemptHandler` 658 LOC zero unit tests | `recovery-attempt-handler.ts` | refactor | dzupagent-connectors-dev |
| AGENT-001 | Agent / Tool Loop | High | 14 `as never` event casts in tool-loop hot paths | `policy-enabled-tool-executor.ts:148,353,398` + 11 sites | quick | dzupagent-core-dev |
| AGENT-002 | Agent / Tool Loop | High | `runToolLoop` outer `for` body is 268 LOC | `tool-loop.ts:524-792` | refactor | dzupagent-agent-dev |
| AGENT-010 | Agent / Memory | High | `consolidateOnComplete` throws — declared but not implemented | `team-runtime.ts:368-371` | quick | dzupagent-agent-dev |
| AGENT-011 | Agent / Memory | High | No periodic memory pruning — unbounded growth | n/a | major | dzupagent-core-dev |
| AGENT-021 | Agent / Context | High | Token estimation uses heuristic char/4 (imprecise) | `dzip-agent.ts:626-628` | major | dzupagent-agent-dev |
| AGENT-030 | Agent / Guardrails | High | No LLM-call audit logging | n/a | refactor | dzupagent-agent-dev |
| AGENT-031 | Agent / Guardrails | High | Two parallel stuck-detection implementations (5 vs 3 modes) | `adapter-guardrails.ts`, `stuck-detector.ts` | refactor | dzupagent-agent-dev |
| AGENT-032 | Agent / Guardrails | High | PII/prompt-injection scan misses tool results → LLM context | `agent-finalizers.ts`, `run-engine.ts:259-307` | refactor | dzupagent-agent-dev |
| AGENT-033 | Agent / Guardrails | High | Rate limiter is per-process only — not distributed | `dzip-agent.ts:719-733` | major | dzupagent-core-dev |
| AGENT-040 | Agent / Orchestration | High | Supervisor re-creates `DzupAgent` on every call (no cache) | `orchestrator.ts:480-501` | refactor | dzupagent-agent-dev |
| AGENT-041 | Agent / Orchestration | High | `PipelineRuntime` 1029 LOC monolith | `pipeline-runtime.ts` | refactor | dzupagent-agent-dev |
| AGENT-042 | Agent / Orchestration | High | Webhook delivery swallows failures silently | `approval-gate.ts:104-107` | quick | dzupagent-agent-dev |
| AGENT-051 | Agent / LLM | High | `adapter-registry.ts` event-bus cast union violation | `adapter-registry.ts:740-748` | quick | dzupagent-core-dev |
| AGENT-052 | Agent / LLM | High | `interrupt()` installs process-level unhandledRejection handler | `claude-adapter.ts:444-485` | quick | dzupagent-connectors-dev |
| AGENT-053 | Agent / LLM | High | OpenAI adapter declares `supportsToolCalls: false` (unimplemented) | `openai-adapter.ts:74-88` | major | dzupagent-connectors-dev |
| AGENT-070 | Agent / Tests | High | No `openai-adapter.test.ts` | `packages/agent-adapters/src/__tests__/` | quick | dzupagent-test-dev |
| AGENT-071 | Agent / Tests | High | No durable approval E2E test across restart | n/a | refactor | dzupagent-test-dev |
| ARCH-005 | Architecture | P2/Med | `TeamRuntime` god class 1281 LOC × 5 patterns | `team-runtime.ts` | major | dzupagent-agent-dev |
| ARCH-006 | Architecture | P2/Med | `PipelineRuntime` 1029 LOC monolith | `pipeline-runtime.ts` | major | dzupagent-agent-dev |
| ARCH-007 | Architecture | P2/Med | Workflow builder DSL duplicated in both packages | `workflow-builder.ts`, `adapter-workflow.ts` | major | dzupagent-architect |
| ARCH-008 | Architecture | P2/Med | Orchestration primitives duplicated in both packages | `orchestration/*` in both pkgs | major | dzupagent-architect |
| ARCH-009 | Architecture | P2/Med | `BaseCLIAdapter` 821 LOC bundles 4 concerns | `base-cli-adapter.ts` | refactor | dzupagent-connectors-dev |
| ARCH-010 | Architecture | P2/Med | Stream-iteration re-implemented in every adapter | `claude-adapter.ts`, `codex-adapter.ts` + 6 others | refactor | dzupagent-connectors-dev |
| ARCH-011 | Architecture | P2/Med | `AdapterRegistry` 750 LOC blends 3 subsystems | `adapter-registry.ts` | major | dzupagent-connectors-dev |
| ARCH-012 | Architecture | P2/Med | `exact-optional` and `event-record` utilities not in core | `utils/exact-optional.ts`, `utils/event-record.ts` | quick | dzupagent-core-dev |
| CODE-002 | Code | P2/Med | 15 `as never` spread-narrowing casts | `dzip-agent.ts`, `streaming-run.ts` + 13 sites | refactor | dzupagent-core-dev |
| CODE-003 | Code | P2/Med | 10 `as unknown as X` double casts | `mailbox.ts:91`, `delegating-supervisor.ts:552` + 8 sites | refactor | dzupagent-agent-dev |
| CODE-004 | Code | P2/Med | `codex-adapter.ts` unsafe config double-cast for timeoutMs | `codex-adapter.ts:508` | quick | dzupagent-connectors-dev |
| CODE-006 | Code | P2/Med | Provider failover loop duplicated; streaming path missing `recordProviderSuccess` | `dzip-agent.ts:766-815`, `streaming-run.ts:148-207` | refactor | dzupagent-agent-dev |
| CODE-007 | Code | P2/Med | `sha256` helper duplicated in syncer + importer | `syncer.ts:127`, `importer.ts:132,182` | quick | dzupagent-connectors-dev |
| CODE-011 | Code | P2/Med | `TeamRuntime` 1281 LOC / 24 methods | `team-runtime.ts` | major | dzupagent-agent-dev |
| CODE-012 | Code | P2/Med | `BaseCliAdapter.execute` 234 LOC | `base-cli-adapter.ts:324-558` | refactor | dzupagent-connectors-dev |
| CODE-013 | Code | P2/Med | `CodexAdapter.runStreamedThread` 291 LOC | `codex-adapter.ts:494-785` | refactor | dzupagent-connectors-dev |
| CODE-014 | Code | P2/Med | `AdapterWorkflowBuilder` 1128 LOC with no decomposition | `adapter-workflow.ts` | refactor | dzupagent-connectors-dev |
| CODE-016 | Code | P2/Med | `runToolLoop` tested only via full integration | `tool-loop.ts:489` | refactor | dzupagent-test-dev |
| CODE-017 | Code | P2/Med | `openStreamWithProviderFailover` has no path-level test | `streaming-run.ts:148` | refactor | dzupagent-test-dev |
| CODE-018 | Code | P2/Med | `BaseCliAdapter.execute` tested only via artifact-watcher | `base-cli-adapter.ts:324` | refactor | dzupagent-test-dev |
| CODE-023 | Code | P2/Med | `console.log`/`debug` in 8+ production files | `codex-adapter.ts`, `orchestration-telemetry.ts` + 4 files | quick | dzupagent-connectors-dev |
| AGENT-003 | Agent / Tool Loop | Med | Retry abort-listener leak across many retries | `policy-enabled-tool-executor.ts:282-299` | quick | dzupagent-agent-dev |
| AGENT-004 | Agent / Tool Loop | Med | `tool:retry` telemetry swallowed (event not in union) | `policy-enabled-tool-executor.ts:226-303` | refactor | dzupagent-core-dev |
| AGENT-005 | Agent / Tool Loop | Med | Parallel tool results dropped on first error | `tool-scheduler-kernel.ts:128-160` | refactor | dzupagent-agent-dev |
| AGENT-012 | Agent / Memory | Med | Memory limits hardcoded (max items, budget) | `memory-context-loader.ts:43-51` | refactor | dzupagent-agent-dev |
| AGENT-013 | Agent / Memory | Med | PII scan misses tool-result-to-memory path | `agent-finalizers.ts:140-144` | refactor | dzupagent-agent-dev |
| AGENT-022 | Agent / Context | Med | Compression failure silently swallowed | `tool-loop.ts:608-624` | quick | dzupagent-agent-dev |
| AGENT-023 | Agent / Context | Med | Frozen-snapshot prompt-cache has no lifecycle | `memory-context-loader.ts` | major | dzupagent-agent-dev |
| AGENT-034 | Agent / Guardrails | Med | `looksLikeError` ad-hoc string matching | `adapter-guardrails.ts:700-712` | major | dzupagent-connectors-dev |
| AGENT-035 | Agent / Guardrails | Med | `blockTool` mutates caller-passed config object | `iteration-budget.ts:60-68` | quick | dzupagent-agent-dev |
| AGENT-036 | Agent / Guardrails | Med | Output filter is single function, not pluggable chain | `adapter-guardrails.ts` | major | dzupagent-connectors-dev |
| AGENT-043 | Agent / Orchestration | Med | `instrumentSpecialistTool` mutates shared tool.invoke | `orchestrator.ts:103-114` | quick | dzupagent-agent-dev |
| AGENT-044 | Agent / Orchestration | Med | Dead no-op `try/catch (err) { throw err }` | `orchestrator.ts:520-522` | quick | dzupagent-agent-dev |
| AGENT-045 | Agent / Orchestration | Med | `consolidateOnComplete` throws (half-baked feature) | `team-runtime.ts:368-371` | quick | dzupagent-agent-dev |
| AGENT-046 | Agent / Orchestration | Med | Checkpoint store not verified on startup | `pipeline-runtime.ts:99-110` | refactor | dzupagent-agent-dev |
| AGENT-055 | Agent / LLM | Med | `resumeSession` throws unconditionally (dead code) | `openai-adapter.ts:308-318` | quick | dzupagent-connectors-dev |
| AGENT-056 | Agent / LLM | Med | `executeWithFallback` 215 LOC — extract helpers | `adapter-registry.ts:251-466` | refactor | dzupagent-connectors-dev |
| AGENT-057 | Agent / LLM | Med | `recovery-attempt-handler.ts` 658 LOC monolith | `recovery-attempt-handler.ts` | major | dzupagent-connectors-dev |
| AGENT-058 | Agent / LLM | Med | SSE parser duplicated across OpenAI + OpenRouter adapters | `openai-adapter.ts`, `openrouter-adapter.ts` | refactor | dzupagent-connectors-dev |
| AGENT-059 | Agent / LLM | Med | Recovery policies static — no runtime weighting | `recovery-policies.ts:65-103` | major | dzupagent-connectors-dev |
| AGENT-072 | Agent / Tests | Med | Stuck detection lacks realistic-scenario integration test | n/a | refactor | dzupagent-test-dev |
| AGENT-073 | Agent / Tests | Med | No property test on `validateAndRepairToolArgs` | `tool-arg-validator.ts` | refactor | dzupagent-test-dev |
| AGENT-074 | Agent / Tests | Med | Zero tests for prompt-injection on tool results | n/a | refactor | dzupagent-test-dev |
| AGENT-075 | Agent / Tests | Med | `recovery-attempt-handler.ts` thin coverage | n/a | refactor | dzupagent-test-dev |
| CODE-008 | Code | P3/Low | Retry-with-backoff loop repeated in 5 locations | `pipeline-runtime.ts`, `skill-chain-executor.ts` + 3 more | major | dzupagent-agent-dev |
| CODE-021 | Code | P3/Low | 8 eslint-disable suppressions without justification | `failure-analyzer.ts:43` + 7 sites | quick | general-purpose |
| CODE-022 | Code | P3/Low | `any` suppression in test file | `edge-resolution-branches.test.ts:88` | quick | general-purpose |
| CODE-024 | Code | P3/Low | `AgentPlayground` triple-export with no consumers | `src/index.ts:392`, `src/playground.ts:10` | quick | general-purpose |
| CODE-025 | Code | P3/Low | `memoryFrame: unknown` untyped escape hatch | `run-engine.ts:77` | refactor | dzupagent-agent-dev |
| CODE-026 | Code | P3/Low | Circuit-breaker state mutable across runs in TeamRuntime | `team-runtime.ts:284` | quick | dzupagent-agent-dev |
| ARCH-013 | Architecture | P3/Low | 27/30 `agent-adapters` subdirs missing barrels | `packages/agent-adapters/src/*/` | refactor | dzupagent-connectors-dev |
| ARCH-014 | Architecture | P3/Low | Several `agent` subdirs missing barrels | `packages/agent/src/*/` | refactor | dzupagent-agent-dev |
| ARCH-015 | Architecture | P3/Low | `playground/` 1556 LOC still in `agent` (marked as moved) | `packages/agent/src/playground/` | major | dzupagent-agent-dev |
| ARCH-016 | Architecture | P3/Low | `compat.ts` has no sunset date | `packages/agent/src/compat.ts` | quick | dzupagent-architect |
| ARCH-017 | Architecture | P3/Low | Root `index.ts` sprawl (813 + 587 LOC) | both root `index.ts` | refactor | general-purpose |
| ARCH-018 | Architecture | P3/Low | `MergeStrategy` type name collision across packages | `workflow-types.ts`, `parallel-executor.ts` | quick | dzupagent-architect |
| AGENT-006 | Agent / Tool Loop | Low | Stuck error mutable strings can be reset mid-iteration | `tool-loop.ts:519-522,807-813` | refactor | dzupagent-agent-dev |
| AGENT-007 | Agent / Tool Loop | Low | Auto-repair tool args with no LLM feedback signal | `tool-arg-validator.ts:19-77` | refactor | dzupagent-agent-dev |
| AGENT-008 | Agent / Tool Loop | Low | Tool-stats hint injection is O(n) per iteration | `tool-loop.ts:556-575` | refactor | dzupagent-agent-dev |
| AGENT-014 | Agent / Memory | Low | `ArrowRuntimeNotInjectedError` swallowed as generic failure | `memory-context-loader.ts:19-26` | quick | dzupagent-agent-dev |
| AGENT-037 | Agent / Guardrails | Low | Three near-identical threshold check blocks | `iteration-budget.ts:83-142` | quick | dzupagent-agent-dev |
| AGENT-047 | Agent / Orchestration | Low | Approval timeout not `unref`'d — keeps event loop alive | `approval-gate.ts:153-164` | quick | dzupagent-agent-dev |
| AGENT-060 | Agent / LLM | Low | O(n²) indexOf in health check list | `adapter-registry.ts:535` | quick | dzupagent-connectors-dev |
| AGENT-061 | Agent / LLM | Low | `loadSDK` alias preserved for test spy compat | `claude-adapter.ts:619` | quick | dzupagent-connectors-dev |
| AGENT-076 | Agent / Tests | Low | No chaos test for OrchestratorFacade mid-stream bridge throw | n/a | major | dzupagent-test-dev |
| CODE-019 | Code | P3/Low | Routing strategies lack failure/edge-case tests | `routing-policy.test.ts` | quick | dzupagent-test-dev |
| CODE-020 | Code | P3/Low | `tool-lifecycle-policy.ts` (359 LOC) untested directly | `tool-lifecycle-policy.ts` | refactor | dzupagent-test-dev |
