# Cross-Domain Issue Matrix

All findings from CODE / SECURITY / ARCHITECTURE / AGENT audits in one table.
Sort: severity desc → phase asc.

| ID | Domain | Severity | Title | File:Line | Phase | Expert |
|----|--------|----------|-------|-----------|-------|--------|
| SEC-01 | Security | Critical | Approval bypass — no ownership check | `server/src/routes/approvals.ts:36-78` | quick | dzupagent-server-dev |
| SEC-02 | Security | Critical | Cross-tenant learning data — unset `tenantId` | `server/src/routes/learning.ts:120-126` | quick | dzupagent-server-dev |
| SEC-03 | Security | High | Scraper SSRF — no private-IP / metadata-IP guard | `scraper/src/http-fetcher.ts:55-85` | major | dzupagent-connectors-dev |
| SEC-04 | Security | High | Express adapter — no Zod, no body cap, no rate limit, leaks errors | `express/src/agent-router.ts:65-172` | refactor | dzupagent-server-dev |
| SEC-05 | Security | High | 19+ Hono routes use type-cast instead of Zod | `server/src/routes/{agents,benchmarks,clusters,deploy,human-contact,learning,mailbox,mcp,personas,presets,prompts,registry,schedules}.ts` | major | dzupagent-server-dev |
| SEC-06 | Security | High | Connectors HTTP — no IP-literal block when allowedHosts matches a hostname | `connectors/src/http/http-connector.ts:62-110` | refactor | dzupagent-connectors-dev |
| SEC-07 | Security | High | `LocalWorkspace.runCommand` allowlist bypassed when undefined | `codegen/src/workspace/local-workspace.ts:210-218` | refactor | dzupagent-codegen-dev |
| SEC-08 | Security | High | Default `maxIterations=10` w/ no cost ceiling for un-guardrailed runs | `agent/src/agent/run-engine.ts:186-193` | refactor | dzupagent-agent-dev |
| AGENT-101 | Agent | High | `ComplianceAuditLogger` not wired at LLM-call boundary | `core/security/audit/index.ts` + `agent/run-engine.ts:517` | refactor | dzupagent-core-dev |
| AGENT-102 | Agent | High | OpenAI adapter `supportsToolCalls: false` + zero tests | `agent-adapters/src/openai/openai-adapter.ts:84` | major | dzupagent-connectors-dev |
| AGENT-103 | Agent | High | `pipeline-runtime.ts` 1044 LOC monolith | `agent/src/pipeline/pipeline-runtime.ts` | major | dzupagent-agent-dev |
| AGENT-104 | Agent | High | `delegating-supervisor.ts` 847 LOC monolith | `agent/src/orchestration/delegating-supervisor.ts` | major | dzupagent-agent-dev |
| AGENT-105 | Agent | High | `recovery-attempt-handler.ts` 658 LOC | `agent-adapters/src/recovery/recovery-attempt-handler.ts` | refactor | dzupagent-connectors-dev |
| AGENT-106 | Agent | High | `codex-adapter.ts` 1125 LOC monolith | `agent-adapters/src/codex/codex-adapter.ts` | refactor | dzupagent-connectors-dev |
| AGENT-107 | Agent | High | No regression gate in evals | `evals/src/orchestrator/benchmark-orchestrator.ts` | refactor | dzupagent-test-dev |
| ARCH-01 | Architecture | High (P1) | Phantom dep `server → @dzupagent/memory` | `server/src/routes/memory-sync.ts:13-20` + `server/package.json` | quick | dzupagent-architect |
| ARCH-05 | Architecture | High (P1) | Two divergent PII detectors | `core/src/security/pii-detector.ts` + `security/src/pii/detector.ts` | refactor | dzupagent-architect |
| CODE-01 | Code | High (P1) | 33 stale `as never` Hono casts; `AppEnv` exists but unadopted | `server/src/routes/{runs,run-guard,api-keys,memory-tenant-scope,...}.ts` (~14 files) | refactor | dzupagent-server-dev |
| CODE-02 | Code | High (P1) | `executeStreamingToolCall` 397 LOC | `agent/src/agent/run-engine.ts:700` | refactor | dzupagent-agent-dev |
| CODE-03 | Code | High (P1) | `planSync` 324 LOC w/ inlined provider branches | `agent-adapters/src/dzupagent/syncer.ts:261` | refactor | dzupagent-connectors-dev |
| CODE-04 | Code | High (P1) | 6/13 memory retrieval files have **no** matching `.test.ts` | `memory/src/retrieval/{cross-encoder-rerank,fts-search,graph-search,rrf-fusion,vector-search,vector-store-search}.ts` | major | dzupagent-test-dev |
| CODE-05 | Code | High (P1) | 5/6 `security/src/*` files lack per-file tests | `security/src/{pii,prompt-injection}/*.ts` | refactor | dzupagent-test-dev |
| SEC-09 | Security | Medium | Server global error handler logs raw `err.message` | `server/src/composition/middleware.ts:386-396` | quick | dzupagent-server-dev |
| SEC-10 | Security | Medium | API key compare not constant-time | `server/src/middleware/auth.ts:52-69` | refactor | dzupagent-server-dev |
| SEC-11 | Security | Medium | Git ref args lack `--end-of-options` | `codegen/src/git/git-executor.ts:285-336` | refactor | dzupagent-codegen-dev |
| SEC-12 | Security | Medium | Git worktree branch/merge args also unprotected | `codegen/src/git/git-worktree.ts:52-66` | refactor | dzupagent-codegen-dev |
| SEC-13 | Security | Medium | High-cardinality / PII-bearing metric labels | `server/src/composition/middleware.ts:369-383` | quick | dzupagent-server-dev |
| SEC-14 | Security | Medium | `learning.ts` body parsed via casts | `server/src/routes/learning.ts:355-380,440,548` | refactor | dzupagent-server-dev |
| SEC-15 | Security | Medium | Memory at-rest encryption is opt-in (no warning) | `memory/src/encryption/*` + `MemoryServiceFactory` | major | dzupagent-core-dev |
| SEC-16 | Security | Medium | MCP stdio child has no SIGKILL escalation | `core/src/mcp/mcp-client.ts:432-479` | refactor | dzupagent-core-dev |
| SEC-17 | Security | Medium | MCP PATCH does not re-validate executable URL | `server/src/routes/mcp.ts:196-222` | quick | dzupagent-server-dev |
| ARCH-02 | Architecture | Medium (P2) | `adapter-rules` is `0.1.0` while siblings are `0.2.0` | `packages/adapter-rules/package.json` | quick | dzupagent-architect |
| ARCH-03 | Architecture | Medium (P2) | 70 cross-deps pinned exact `0.2.0` not `workspace:^` | every package.json | refactor | dzupagent-architect |
| ARCH-04 | Architecture | Medium (P2) | God public surface: `core` 223, `agent` 210 exports | `core/src/index.ts`, `agent/src/index.ts` | refactor | dzupagent-architect |
| ARCH-06 | Architecture | Medium (P2) | 5 rate-limiter implementations | `{core,agent×2,agent-adapters,server×2}` | refactor | dzupagent-architect |
| ARCH-07 | Architecture | Medium (P2) | 2 circuit-breaker implementations | `core/src/llm/circuit-breaker.ts` + `agent/src/orchestration/circuit-breaker.ts` | refactor | dzupagent-architect |
| ARCH-08 | Architecture | Medium (P2) | Boundary tests not tier-driven; only 4 hand-rules | `testing/src/__tests__/boundary-enforcement.test.ts` | refactor | dzupagent-test-dev |
| ARCH-10 | Architecture | Medium (P2) | Top god-objects exceed 1000 LOC (×6) | `flow-ast/{validate,parse}`, `codex-adapter`, `run-engine`, `pipeline-runtime`, `flow-dsl/normalize` | major | dzupagent-architect |
| ARCH-12 | Architecture | Medium (P2) | `app-tools` declares all deps as peer | `app-tools/package.json` | quick | dzupagent-architect |
| ARCH-13 | Architecture | Medium (P2) | `code-edit-kit` peer-only with no deps | `code-edit-kit/package.json` | quick | dzupagent-architect |
| ARCH-14 | Architecture | Medium (P2) | Extension surfaces lack abstract base | `runtime-contracts` (missing `MemoryStore`/`ToolRegistry`/`ModelProvider`) | refactor | dzupagent-architect |
| ARCH-17 | Architecture | Medium (P2) | `app-tools`/`code-edit-kit` ship w/ empty declared graph | as ARCH-12/13 | quick | dzupagent-architect |
| AGENT-108 | Agent | Medium | Retry-sleep AbortListener leak | `agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:288-298` | quick | dzupagent-agent-dev |
| AGENT-109 | Agent | Medium | First-error-wins hides remaining tool errors | `agent/src/agent/tool-loop/tool-scheduler-kernel.ts:156-159` | quick | dzupagent-agent-dev |
| AGENT-110 | Agent | Medium | No `MemoryEvictionPolicy` contract | `memory/src/store-capabilities.ts` | refactor | dzupagent-core-dev |
| AGENT-111 | Agent | Medium | No quota check before write in staged-writer | `memory/src/staged-writer.ts` | refactor | dzupagent-core-dev |
| AGENT-112 | Agent | Medium | Compression failure swallowed silently | `agent/src/agent/tool-loop.ts:~608` | quick | dzupagent-agent-dev |
| AGENT-113 | Agent | Medium | Default token counter is char/4 unless tiktoken installed | `context/src/index.ts` | refactor | dzupagent-core-dev |
| AGENT-114 | Agent | Medium | Prompt-injection patterns only 54 LOC | `security/src/prompt-injection/patterns.ts` | refactor | dzupagent-core-dev |
| AGENT-115 | Agent | Medium | PII detector regex-only, no NER fallback | `security/src/pii/detector.ts` | refactor | dzupagent-core-dev |
| AGENT-116 | Agent | Medium | Stuck-detector drift (5-mode vs 3-mode) | `agent-adapters/src/guardrails/adapter-guardrails.ts` vs `agent/src/guardrails/stuck-detector.ts` | refactor | dzupagent-agent-dev |
| AGENT-117 | Agent | Medium | Checkpoint store unverified at startup | `agent/src/pipeline/pipeline-runtime.ts:99-110` | quick | dzupagent-agent-dev |
| AGENT-118 | Agent | Medium | `recovery-copilot.ts` 679 LOC | `agent/src/recovery/recovery-copilot.ts` | refactor | dzupagent-agent-dev |
| AGENT-119 | Agent | Medium | SSE parser duplicated openai+openrouter | `agent-adapters/src/{openai,openrouter}/*.ts` | quick | dzupagent-connectors-dev |
| AGENT-120 | Agent | Medium | Cross-provider handoff logic duplicated | `agent-adapters/src/recovery/{cross-provider-handoff,recovery-loop-runner}.ts` | refactor | dzupagent-connectors-dev |
| AGENT-121 | Agent | Medium | Postgres approval store polling-only | `hitl-kit/src/postgres-approval-store.ts` | refactor | dzupagent-agent-dev |
| AGENT-122 | Agent | Medium | Webhook delivery in legacy approval-gate | `agent/src/approval/approval-gate.ts:104` | refactor | dzupagent-agent-dev |
| AGENT-123 | Agent | Medium | RAG `'cross-encoder'` reranker option has no impl | `rag/src/{types.ts:75,retriever.ts:63}` | refactor | dzupagent-connectors-dev |
| AGENT-124 | Agent | Medium | No hybrid retrieval (BM25+vector+RRF) | `rag/src/retriever.ts` | major | dzupagent-connectors-dev |
| AGENT-125 | Agent | Medium | No retrieval-quality-scorer in evals | `rag/src/quality-retriever.ts` + `evals/` | refactor | dzupagent-test-dev |
| AGENT-126 | Agent | Medium | Task-router weights opaque | `agent-adapters/src/registry/task-router.ts` (382 LOC) | quick | dzupagent-connectors-dev |
| AGENT-127 | Agent | Medium | Capability-router 452 LOC | `agent-adapters/src/registry/capability-router.ts` | refactor | dzupagent-connectors-dev |
| CODE-06 | Code | Medium (P2) | 25+ `agent/src/orchestration/team/*` files lack tests | `team/`, `team/patterns/`, `topology/`, `routing/`, `merge/`, `contract-net/` | major | dzupagent-test-dev |
| CODE-07 | Code | Medium (P2) | `flow-ast/validate.ts` 1410 + `parse.ts` 1077 | `flow-ast/src/{validate,parse}.ts` | major | dzupagent-architect |
| CODE-08 | Code | Medium (P2) | `mergeBranchExecutionResult` ~142 LOC | `agent/src/pipeline/pipeline-runtime.ts` | refactor | dzupagent-agent-dev |
| CODE-09 | Code | Medium (P2) | DzipAgent constructor 120 LOC | `agent/src/agent/dzip-agent.ts:170` | refactor | dzupagent-agent-dev |
| CODE-11 | Code | Medium (P2) | `routes/runs.ts` 968 LOC | `server/src/routes/runs.ts` | refactor | dzupagent-server-dev |
| CODE-12 | Code | Medium (P2) | `routes/compile.ts` 782 LOC | `server/src/routes/compile.ts` | refactor | dzupagent-server-dev |
| CODE-13 | Code | Medium (P2) | `run-worker-stages.ts` 798 LOC | `server/src/runtime/run-worker-stages.ts` | major | dzupagent-server-dev |
| CODE-16 | Code | Medium (P2) | Server runtime 62% files lack tests | `server/src/runtime/*`, `lifecycle/*` | major | dzupagent-test-dev |
| CODE-17 | Code | Medium (P2) | `executeGenerateRunInner` 270 LOC | `agent/src/agent/run-engine.ts:373` | refactor | dzupagent-agent-dev |
| CODE-18 | Code | Medium (P2) | `tool-loop.ts` 825 LOC | `agent/src/agent/tool-loop.ts` | refactor | dzupagent-agent-dev |
| CODE-19 | Code | Medium (P2) | `delegating-supervisor.ts` 847 LOC + 149/117 LOC functions | `agent/src/orchestration/delegating-supervisor.ts:384,533` | refactor | dzupagent-agent-dev |
| CODE-20 | Code | Medium (P2) | `codex-adapter.ts` 1125 LOC | `agent-adapters/src/codex/codex-adapter.ts` | refactor | dzupagent-connectors-dev |
| CODE-21 | Code | Medium (P2) | `mapRawEvent` 143 LOC | `agent-adapters/src/claude/claude-adapter.ts:320` | refactor | dzupagent-connectors-dev |
| CODE-22 | Code | Medium (P2) | `memory-space-manager.ts` 950 LOC | `memory/src/sharing/memory-space-manager.ts` | refactor | dzupagent-core-dev |
| CODE-24 | Code | Medium (P2) | Empty fixture directory imported in tests | `security/src/prompt-injection/fixtures/` | quick | dzupagent-test-dev |
| CODE-26 | Code | Medium (P2) | `flow-compiler/stages/semantic.ts` 807 LOC + 117 LOC visit | `flow-compiler/src/stages/semantic.ts:160` | refactor | dzupagent-architect |
| CODE-27 | Code | Medium (P2) | `eval-orchestrator.ts` 95+84 LOC fns | `evals/src/orchestrator/eval-orchestrator.ts:412,257` | refactor | dzupagent-test-dev |
| CODE-31 | Code | Medium (P2) | `// eslint-disable no-new-func` in compiler | `flow-compiler/src/stages/semantic.ts:324` | refactor | dzupagent-architect |
| SEC-18 | Security | Low | JSON body limit 1 MiB / some routes 8 MiB | `server/src/composition/middleware.ts:32-38` | quick | dzupagent-server-dev |
| SEC-19 | Security | Low | `c.set('apiKey' as never, …)` | `server/src/middleware/auth.ts:70` | quick | dzupagent-server-dev |
| SEC-20 | Security | Low | `execSync` to `git rev-parse` blocks event loop | `core/src/skills/hierarchical-walker.ts:93-101` | quick | dzupagent-core-dev |
| SEC-21 | Security | Low | `which` not portable to Windows | `agent-adapters/src/utils/process-helpers.ts:25` | quick | dzupagent-connectors-dev |
| SEC-22 | Security | Low | Yarn npm audit blocked by env corepack misconfig | n/a | quick | n/a |
| ARCH-09 | Architecture | Low (P3) | OrchestratorFacade 468 LOC vs memory's 279 LOC claim | `agent-adapters/src/facade/orchestrator-facade.ts` | quick | dzupagent-architect |
| ARCH-11 | Architecture | Low (P3) | Dynamic-import phantom edges in `create-dzupagent` | `create-dzupagent/src/{bridge,sync}.ts` | quick | dzupagent-architect |
| ARCH-15 | Architecture | Low (P3) | Same as ARCH-03 | (subsumed) | refactor | – |
| ARCH-16 | Architecture | Low (P3) | `packages/playground/` is dead-code shell | `packages/playground/` | quick | dzupagent-architect |
| ARCH-18 | Architecture | Low (P3) | `connectors` ships 9 DB drivers as direct deps | `connectors/package.json` | major | dzupagent-architect |
| ARCH-19 | Architecture | Low (P3) | `apache-arrow` is a hard dep of `memory-ipc` | `memory-ipc/package.json` | refactor | dzupagent-architect |
| ARCH-20 | Architecture | Low (P3) | Two parallel-executor implementations | `agent/src/agent/parallel-executor.ts` + `agent-adapters/src/orchestration/parallel-executor.ts` | refactor | dzupagent-agent-dev |
| AGENT-128 | Agent | Low | Tool-loop top file 825 LOC | `agent/src/agent/tool-loop.ts` | refactor | dzupagent-agent-dev |
| AGENT-129 | Agent | Low | `MemoryHealer` not scheduled | `memory/src/memory-healer.ts` | quick | dzupagent-core-dev |
| AGENT-130 | Agent | Low | No `FrozenSnapshotManager` | `context/src/prompt-cache.ts` | refactor | dzupagent-core-dev |
| AGENT-131 | Agent | Low | Judge prompt+model not pinned | `evals/src/scorers/llm-judge-enhanced.ts` | quick | dzupagent-test-dev |
| AGENT-132 | Agent | Low | No per-suite cost cap on evals | `evals/src/orchestrator/eval-orchestrator.ts` | quick | dzupagent-test-dev |
| AGENT-133 | Agent | Low | HITL cross-process integration test missing | `hitl-kit/src/__tests__/approval-gate.test.ts` | quick | dzupagent-test-dev |
| AGENT-134 | Agent | Low | Reranker tests missing (post-impl) | `rag/src/__tests__/` | quick | dzupagent-test-dev |
| AGENT-135 | Agent | Low | Qwen/Crush adapter tests thin | `agent-adapters/src/__tests__/{qwen,crush}-adapter.test.ts` | quick | dzupagent-test-dev |
| CODE-10 | Code | Low (P3) | `console.log/error` leaks (~25 sites) | `server/src/lifecycle/human-contact-timeout.ts`, `agent-adapters/src/{base/stream-runner,middleware/memory-enrichment,dzupagent/syncer}.ts` | quick | dzupagent-server-dev |
| CODE-14 | Code | Low (P3) | `cli/doctor.ts` 715 LOC | `server/src/cli/doctor.ts` | refactor | dzupagent-server-dev |
| CODE-15 | Code | Low (P3) | `console.error` for runtime errors | `server/src/lifecycle/human-contact-timeout.ts` | quick | dzupagent-server-dev |
| CODE-23 | Code | Low (P3) | `convention-extractor.ts` 748 LOC | `memory/src/convention/convention-extractor.ts` | refactor | dzupagent-core-dev |
| CODE-25 | Code | Low (P3) | `flow-dsl/normalize.ts` 1018 LOC | `flow-dsl/src/normalize.ts` | refactor | dzupagent-architect |
| CODE-28 | Code | Low (P3) | `as unknown` overuse (143 cases) | distributed | major | dzupagent-architect |
| CODE-29 | Code | Low (P3) | `console.warn` in stream/middleware/syncer | `agent-adapters/src/{base/stream-runner,middleware/memory-enrichment,dzupagent/syncer}.ts` | quick | dzupagent-connectors-dev |
| CODE-30 | Code | Low (P3) | `as never` DOM probe | `connectors-browser/src/browser/auth-handler.ts:128,132` | quick | dzupagent-connectors-dev |
| CONSUMER-01 | Cross | High | `@dzupagent/flow-compiler` ships no `.d.ts` | `flow-compiler/dist/` (build config) | quick | dzupagent-architect |
| CONSUMER-02 | Cross | High | `ConsolidationResult` shape changed without semver bump | `memory/src/consolidation/*` | refactor | dzupagent-core-dev |
| CONSUMER-03 | Cross | High | `DzupEventBus` not assignable to `DzupEventBusAdapter` for consumers | `core/src/events/*` | refactor | dzupagent-core-dev |

**Total: 104 unique findings** (some IDs are subsumed/duplicates and called out as such — actionable items: ~86).
