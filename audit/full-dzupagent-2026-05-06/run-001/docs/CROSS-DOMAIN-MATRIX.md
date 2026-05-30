# Cross-Domain Findings Matrix — full-dzupagent 2026-05-06 / run-001

All 85 findings from the four parallel domain audits, sorted by severity then domain.
Severities are normalized: CODE P1 → High, P2 → Medium, P3 → Low (original P-tier preserved in source doc).

## Live-check normalization notes

This matrix has been normalized against the live checkout on 2026-05-06 before implementation. Do not treat the generated prompt pack as authoritative without these corrections:

- `SEC-010` is already closed in the live code. The current implementation is `packages/codegen/src/workspace/local-workspace.ts`, not `packages/codegen/src/sandbox/local-workspace.ts`; the constructor applies `DEFAULT_ALLOWED_COMMANDS` when `allowedCommands` is undefined and `runCommand` enforces the resolved list.
- `ARCH-022` was overstated. `yarn verify` already runs `check:domain-boundaries`, and `packages/testing/src/__tests__/boundary/architecture.test.ts` provides machine-readable boundary enforcement. The remaining architecture-gate gap is cycle detection plus declared-vs-actual dependency completeness, not "no package-boundary CI test."
- Approval webhook findings should point to `packages/agent/src/approval/approval-gate.ts:275-322`, not `packages/agent/src/orchestration/approval-gate.ts`.

| ID | Domain | Severity | Title | Files | Phase | Effort | Target Agent |
|----|--------|----------|-------|-------|-------|--------|--------------|
| SEC-001 | Security | Critical | Cross-tenant access on 7 CRUD route families (agent defs, personas, triggers, schedules, prompts, marketplace, clusters) | `packages/server/src/routes/{agents,personas,triggers,schedules,prompts,marketplace,clusters}.ts` + `packages/server/src/services/agent-definition-service.ts` | refactor | 12h | dzupagent-server-dev |
| AGT-001 | Agent | Critical | AdapterLearningLoop has zero tenant scoping (ExecutionRecord, ProviderProfile, LearningStore) | `packages/agent-adapters/src/learning/{adapter-learning-loop,learning-store}.ts`, `packages/agent/src/self-correction/learning-candidate-service.ts` | refactor | 16h | dzupagent-agent-dev |
| ARCH-022 | Architecture | Medium | Extend existing boundary gates with cycle detection and declared-vs-actual dependency completeness checks | `package.json`, `packages/testing/src/__tests__/boundary/architecture.test.ts`, CI workflow | refactor | 6h | dzupagent-architect |
| SEC-002 | Security | High | ApprovalGate.notifyWebhook uses raw fetch with no outbound URL policy (SSRF/IMDS reach) | `packages/agent/src/approval/approval-gate.ts:275-322` | quick | 2h | dzupagent-agent-dev |
| SEC-003 | Security | High | GitHub connector bypasses outbound URL policy (`fetch(url)` direct) | `packages/connectors/src/github/github-client.ts:213` | quick | 1h | dzupagent-connectors-dev |
| SEC-004 | Security | High | Default `security.promptInjection: 'off'` — out-of-the-box agents have no injection scanning | `packages/agent/src/agent/run-engine.ts`, `packages/agent/src/agent/agent-types.ts` | quick | 2h | dzupagent-agent-dev |
| SEC-005 | Security | High | 32 high-severity dependency CVEs (axios prototype pollution, node-tar, ip-address) | `dzupagent/yarn.lock`, package.json deps | quick | 4h | dzupagent-architect |
| SEC-006 | Security | High | 207 user-input touch points; only 13 use Zod schemas | `packages/server/src/routes/*.ts` | refactor | 12h | dzupagent-server-dev |
| SEC-007 | Security | High | Webhook secret stored plaintext in `triggers.webhook_secret` | `packages/server/src/db/drizzle-schema.ts:214` | refactor | 4h | dzupagent-server-dev |
| SEC-008 | Security | High | PII detector only runs on memory write-back; tool-result + learning-candidate paths bypass it | `packages/memory/src/sanitizer/*`, agent tool-result pipeline | refactor | 8h | dzupagent-agent-dev |
| SEC-009 | Security | High | LearningCandidateService has zero tenant scoping in framework class | `packages/agent/src/self-correction/learning-candidate-service.ts` | refactor | 6h | dzupagent-agent-dev |
| SEC-010 | Security | Closed | Already fixed: LocalWorkspace applies the default command allowlist when `allowedCommands === undefined` | `packages/codegen/src/workspace/local-workspace.ts:149`, `packages/codegen/src/workspace/local-workspace.ts:268` | done | 0h | n/a |
| AGT-002 | Agent | High | Approval webhook fires unsigned — no HMAC, no timestamp, no replay protection | `packages/agent/src/approval/approval-gate.ts:275-322` | refactor | 4h | dzupagent-agent-dev |
| AGT-003 | Agent | High | Two parallel security stacks (`@dzupagent/security` + `core/security/monitor/built-in-rules.ts`) — diverging PII coverage causes silent JWT/CC/IBAN leak | `packages/core/src/security/*`, `packages/security/src/*` | refactor | 12h | dzupagent-core-dev |
| ARCH-001 | Architecture | High | `agent-adapters/workflow/*` imports `PipelineRuntime` from `@dzupagent/agent` — inverted layer | `packages/agent-adapters/src/workflow/{default-pipeline-executor,adapter-workflow,pipeline-assembler}.ts` | refactor | 8h | dzupagent-architect |
| ARCH-002 | Architecture | High | `core/src/index.ts` is 877 LOC / 225 exports — erodes intended stable/advanced split | `packages/core/src/index.ts` | refactor | 6h | dzupagent-core-dev |
| ARCH-003 | Architecture | High | `core/vectordb` (3,631 LOC, 7 adapters) duplicates `@dzupagent/rag` (3,638 LOC) | `packages/core/src/vectordb/*`, `packages/rag/src/*` | major | 32h | dzupagent-architect |
| ARCH-004 | Architecture | High | `core/security` (3,094 LOC) overlaps `packages/security` (464 LOC) | `packages/core/src/security/*`, `packages/security/src/*` | major | 24h | dzupagent-core-dev |
| ARCH-005 | Architecture | High | 28 intra-package circular dependencies (10 in agent-adapters, 8 in server, 6 in agent, 2 in core, 1 in adapter-types) | madge output across packages | refactor | 16h | dzupagent-architect |
| CODE-002 | Code | High | `runToolLoop` is 362 LOC at nesting depth 10 | `packages/agent/src/orchestration/run-tool-loop.ts` | refactor | 6h | dzupagent-agent-dev |
| CODE-005 | Code | High | 6 large agent helper files have zero direct test (≥400 LOC each, e.g. run-engine-streaming-helpers.ts 717 LOC, confidence-calculator.ts 348 LOC) | `packages/agent/src/...` (see CODE-AUDIT) | major | 24h | dzupagent-test-dev |
| CODE-006 | Code | High | 5 server zero-test files (≥250 LOC each, deploy/scorecard) | `packages/server/src/routes/{deploy,scorecard}*.ts` | refactor | 12h | dzupagent-test-dev |
| AGT-004 | Agent | Medium | `Promise.race` timer leak in invoke.ts — no clearTimeout on success path | `packages/core/src/model-registry/invoke.ts:172` | quick | 1h | dzupagent-core-dev |
| AGT-005 | Agent | Medium | TiktokenCounter routes Claude through `cl100k_base` instead of `@anthropic-ai/tokenizer` | `packages/context/src/tokenizer/tiktoken-counter.ts` | refactor | 4h | dzupagent-core-dev |
| AGT-006 | Agent | Medium | Stuck detector idle counter can be stale after parallel-mode approval pause | `packages/agent/src/orchestration/stuck-detector.ts` | refactor | 4h | dzupagent-agent-dev |
| AGT-007 | Agent | Medium | Approval timeout silently cancels without persisting decision | `packages/agent/src/approval/approval-gate.ts` | refactor | 4h | dzupagent-agent-dev |
| AGT-009 | Agent | Medium | LLM audit log lacks tenantId, prompt, response — compliance light | `packages/agent/src/observability/audit-log.ts` | refactor | 6h | dzupagent-agent-dev |
| AGT-010 | Agent | Medium | Tool result safety scan uses SafetyMonitor (different PII set than ContentScanner) | `packages/agent/src/orchestration/tool-loop/...` | refactor | 4h | dzupagent-agent-dev |
| AGT-012 | Agent | Medium | Permission tier enforced at sandbox layer, not at write-tool issuance | `packages/codegen/src/permissions/*` | refactor | 6h | dzupagent-codegen-dev |
| AGT-014 | Agent | Medium | Memory sanitizer not enforced at every MemoryStore.put boundary | `packages/memory/src/store/*.ts` | refactor | 4h | dzupagent-core-dev |
| ARCH-007 | Architecture | Medium | 9 source files exceed 900 LOC — multi-responsibility god objects | flow-ast/validate.ts (1410), agent/run-engine.ts (1186), codex-adapter.ts (1126), flow-ast/parse.ts (1077), pipeline-runtime.ts (1071), normalize.ts (1018), routes/runs.ts (969), agent-defs (940), event-types.ts (909) | major | 32h | dzupagent-agent-dev |
| ARCH-010 | Architecture | Medium | core mid-tier subdomains exceed 2000 LOC each — extraction candidates: mcp, protocol, skills, identity, persistence, formats | `packages/core/src/{mcp,protocol,skills,identity,persistence,formats}/*` | major | 40h | dzupagent-architect |
| ARCH-011 | Architecture | Medium | `server/composition/types.ts` is a kitchen-sink ambient module — root cause of 2 cycles | `packages/server/src/composition/types.ts` | refactor | 4h | dzupagent-server-dev |
| ARCH-012 | Architecture | Medium | `server/routes/runs.ts` (969 LOC) violates its own design intent | `packages/server/src/routes/runs.ts` | refactor | 8h | dzupagent-server-dev |
| ARCH-013 | Architecture | Medium | `agent/src/index.ts` re-exports 210 symbols (821 LOC) | `packages/agent/src/index.ts` | refactor | 4h | dzupagent-agent-dev |
| ARCH-015 | Architecture | Medium | No CI gate for circular dependencies | turbo / CI workflow | quick | 1h | dzupagent-architect |
| ARCH-016 | Architecture | Medium | No CI gate for layering rule (rule exists in codegen/guardrails but not run on framework) | `packages/codegen/src/guardrails/rules/layering-rule.ts` | refactor | 4h | dzupagent-architect |
| ARCH-021 | Architecture | Medium | `core/events/event-types.ts` (774 LOC) at risk of becoming a god-file | `packages/core/src/events/event-types.ts` | refactor | 4h | dzupagent-core-dev |
| CODE-001 | Code | Medium | 6 files >1000 LOC (validate.ts 1410, run-engine.ts 1186, codex-adapter.ts 1126, parse.ts 1077, pipeline-runtime.ts 1071, normalize.ts 1018) | (see ARCH-007) | major | (covered by ARCH-007) | dzupagent-agent-dev |
| CODE-003 | Code | Medium | ~180 LOC of identical mtime-cache logic across 3 dzupagent loaders | dzupagent loaders | refactor | 4h | dzupagent-core-dev |
| CODE-004 | Code | Medium | `MemoryEntry` interface name collision across packages | `packages/{memory,core,agent}/...` | refactor | 4h | dzupagent-core-dev |
| CODE-007 | Code | Medium | `flow-ast/parse.ts` (1077 LOC) has 16 untested per-node parsers | `packages/flow-ast/src/parse.ts` | refactor | 8h | dzupagent-test-dev |
| CODE-008 | Code | Medium | `hitl-kit` has 1 test for 4 production files (531 LOC) | `packages/hitl-kit/src/*` | refactor | 6h | dzupagent-test-dev |
| CODE-009 | Code | Medium | ~50 real `console.*` calls in non-CLI, non-test code (mcp.ts:8, syncer.ts:4, etc.) bypass defaultLogger | various non-test files | refactor | 4h | dzupagent-core-dev |
| CODE-010 | Code | Medium | 28 non-null `!.` assertions in server hot routes (14 in routes/mcp.ts) | `packages/server/src/routes/mcp.ts` + others | quick | 2h | dzupagent-server-dev |
| CODE-011 | Code | Medium | Memory `void-filter.ts` and `adaptive-retriever.ts` use `!.` at boundary | `packages/memory/src/{void-filter,adaptive-retriever}.ts` | quick | 1h | dzupagent-core-dev |
| CODE-012 | Code | Medium | `agent/src/index.ts` has 40 `@deprecated` re-export shims | `packages/agent/src/index.ts` | refactor | 6h | dzupagent-agent-dev |
| CODE-015 | Code | Medium | `codex/codex-adapter.ts` runStreamedThread depth-9 nesting | `packages/agent-adapters/src/codex/codex-adapter.ts` | refactor | 6h | dzupagent-connectors-dev |
| CODE-016 | Code | Medium | `pipeline-runtime.ts` recovery block at depth 9 | `packages/agent/src/pipelines/pipeline-runtime.ts` | refactor | 4h | dzupagent-agent-dev |
| CODE-018 | Code | Medium | `server/routes/runs.ts` 968 LOC route file (covered by ARCH-012) | `packages/server/src/routes/runs.ts` | refactor | (covered) | dzupagent-server-dev |
| CODE-022 | Code | Medium | `security/prompt-injection/patterns.ts` has 0 dedicated coverage | `packages/security/src/prompt-injection/patterns.ts` | refactor | 4h | dzupagent-test-dev |
| SEC-011 | Security | Medium | `flow-compiler` builds `new Function('ctx', expr)` from user input | `packages/flow-compiler/src/semantic.ts` | refactor | 6h | dzupagent-architect |
| SEC-012 | Security | Medium | Sandbox WASM transpiler invokes dynamic import via `new Function` | `packages/codegen/src/sandbox/wasm-sandbox.ts` | refactor | 4h | dzupagent-codegen-dev |
| SEC-013 | Security | Medium | `runs.ts` GET /runs does not enforce ownership at LIST time | `packages/server/src/routes/runs.ts` | quick | 1h | dzupagent-server-dev |
| SEC-014 | Security | Medium | `/api/agent-definitions` PATCH accepts arbitrary metadata/guardrails spread into service update | `packages/server/src/routes/agents.ts`, `packages/server/src/services/agent-definition-service.ts` | quick | 2h | dzupagent-server-dev |
| SEC-015 | Security | Medium | `validateMcpExecutablePath` does not reject `~/`, `/dev/`, `/proc/` | `packages/core/src/mcp/validate-mcp-path.ts` | quick | 1h | dzupagent-core-dev |
| SEC-016 | Security | Medium | Gemini CLI argument injection via prompt prefix | `packages/agent-adapters/src/gemini/gemini-adapter.ts` | quick | 2h | dzupagent-connectors-dev |
| SEC-017 | Security | Medium | CSP header is not set by default; default `securityHeaders` only covers basics | `packages/server/src/middleware/security-headers.ts` | quick | 2h | dzupagent-server-dev |
| SEC-018 | Security | Medium | No rate limit on `/api/runs/:id/stream` (SSE) | `packages/server/src/routes/runs.ts` SSE handler | quick | 2h | dzupagent-server-dev |
| AGT-008 | Agent | Low | IterationBudget.fork() leaks Set entries across child runs | `packages/agent/src/orchestration/iteration-budget.ts` | quick | 1h | dzupagent-agent-dev |
| AGT-011 | Agent | Low | Circuit breaker cooldown timer has no jitter | `packages/core/src/model-registry/circuit-breaker.ts` | quick | 1h | dzupagent-core-dev |
| AGT-013 | Agent | Low | ModelRegistry fallback does NOT retry on invocation error (only on creation error) | `packages/core/src/model-registry/registry.ts` | refactor | 4h | dzupagent-core-dev |
| AGT-015 | Agent | Low | Auto-compress consecutive-failure terminal error count is per-loop not per-run | `packages/agent/src/orchestration/auto-compress.ts` | quick | 2h | dzupagent-agent-dev |
| ARCH-006 | Architecture | Low | `core` imports types from `agent-types` and `runtime-contracts` (informational; OK because pure leaf type packages) | declare convention in ADR | quick | 1h | dzupagent-architect |
| ARCH-008 | Architecture | Low | `flow-ast`, `flow-dsl`, `flow-compiler` strong coupling — consolidation candidate | three flow-* packages | major | 24h | dzupagent-architect |
| ARCH-009 | Architecture | Low | 5 small contract packages (adapter-types, adapter-rules, agent-types, runtime-contracts, eval-contracts) — consolidation candidate | five contract packages | major | 16h | dzupagent-architect |
| ARCH-014 | Architecture | Low | 20/32 packages have READMEs (≈63%) | various | quick | 4h | dzupagent-architect |
| ARCH-017 | Architecture | Low | `core/index.ts` directly re-exports `QdrantAdapter` (line 783) | `packages/core/src/index.ts:783` | quick | 0.5h | dzupagent-core-dev |
| ARCH-018 | Architecture | Low | Top-level `agent-adapters` index re-exports 5 subpaths — verify each is actually used | `packages/agent-adapters/src/index.ts` | quick | 1h | dzupagent-architect |
| ARCH-019 | Architecture | Low | `memory` declares 3 deps but no subpath re-exports — dense single-export surface | `packages/memory/src/index.ts` | refactor | 4h | dzupagent-core-dev |
| ARCH-020 | Architecture | Low | `agent-adapters` ships claude-adapter.ts + codex-adapter.ts in same package — prevents tree-shaking of optional deps | `packages/agent-adapters/src/{claude,codex}/*` | refactor | 8h | dzupagent-connectors-dev |
| CODE-013 | Code | Low | `core/src/index.ts` 875 LOC barrel sprawl (covered by ARCH-002) | `packages/core/src/index.ts` | refactor | (covered) | dzupagent-core-dev |
| CODE-014 | Code | Low | 132 `as never` casts concentrated in 5 agent test files | `packages/agent/src/__tests__/*` | refactor | 6h | dzupagent-test-dev |
| CODE-017 | Code | Low | `flow-ast/validate.ts:validateDefaults` triple-nested issue accumulator | `packages/flow-ast/src/validate.ts` | refactor | 2h | dzupagent-architect |
| CODE-019 | Code | Low | Magic-number constants for timeouts | various | quick | 2h | dzupagent-core-dev |
| CODE-020 | Code | Low | 40 deprecated re-exports lack removal milestone | `packages/agent/src/index.ts` | quick | 2h | dzupagent-agent-dev |
| CODE-021 | Code | Low | `connectors-browser` retains 41 `as never` casts (16+12+10 in tests) | `packages/connectors-browser/src/__tests__/*` | refactor | 4h | dzupagent-test-dev |
| CODE-023 | Code | Low | `eval-contracts` and `agent-types` ratio of 1 test : 5+ src files | `packages/{eval-contracts,agent-types}/src/*` | refactor | 4h | dzupagent-test-dev |
| CODE-024 | Code | Low | Static-data heavy `core/src/events/event-types.ts` (717 LOC, 0 fns, 0 tests) | `packages/core/src/events/event-types.ts` | refactor | 2h | dzupagent-core-dev |
| SEC-019 | Security | Low | redactSecrets applied in onError but not in routine console.error logs | `packages/server/src/routes/*.ts` | quick | 2h | dzupagent-server-dev |
| SEC-020 | Security | Low | GitHub `Authorization: Bearer …` may be logged via `GitHubApiError(res.status, text)` | `packages/connectors/src/github/github-client.ts` | quick | 1h | dzupagent-connectors-dev |
| SEC-021 | Security | Low | `metadata` field on runs/agents/personas accepts unbounded JSON depth | various drizzle schemas | refactor | 4h | dzupagent-server-dev |
| SEC-022 | Security | Low | `/api/v1/learning-candidates` lookup does not require role=admin | `packages/server/src/routes/learning.ts` | quick | 1h | dzupagent-server-dev |
| SEC-023 | Security | Low | `routes/learning.ts` POST /feedback and /ingest lack JSON body schema | `packages/server/src/routes/learning.ts` | quick | 2h | dzupagent-server-dev |
| SEC-024 | Security | Low | `c.get('apiKey' as never)` casts swallow type errors | server route handlers | quick | 2h | dzupagent-server-dev |

## Cross-domain duplicates / linked findings

These findings describe overlapping root causes across domains — fix once, mark closed across domains:

| Group | IDs | Common root cause |
|-------|-----|-------------------|
| **Cross-tenant scoping** | SEC-001 + AGT-001 + SEC-009 | AgentDefinitionService, LearningCandidateService, AdapterLearningLoop all share missing tenant predicates. Fix at the service layer once. |
| **Approval webhook** | SEC-002 + AGT-002 | Same `packages/agent/src/approval/approval-gate.ts:275-322` — needs both outbound URL policy AND HMAC signing. Combine into one fix. |
| **Two security stacks** | AGT-003 + ARCH-004 + SEC-008 | `core/security` + `packages/security` overlap; PII coverage diverges → tool results bypass scanner. Consolidate to `@dzupagent/security`. |
| **God files** | ARCH-007 + CODE-001 + ARCH-012 + CODE-018 | Both audits flag the same 6-9 oversized files. ARCH-007 is the umbrella. |
| **Barrel sprawl** | ARCH-002 + CODE-013 + ARCH-013 + CODE-012 | core/index.ts (875 LOC), agent/index.ts (821 LOC) + 40 deprecated re-exports. Consolidate. |
| **Architecture gate completion** | ARCH-022 + ARCH-015 + ARCH-016 | Existing boundary/domain checks are present; add cycle detection and declared-vs-actual dependency completeness, then wire the expanded gate into CI. |
| **`new Function` from user input** | SEC-011 + SEC-012 | flow-compiler/semantic.ts + sandbox/wasm-sandbox.ts — both need controlled-evaluator pattern. |
| **GitHub connector** | SEC-003 + SEC-020 | github-client.ts SSRF + bearer-token log leak — fix together. |

## Phase distribution

| Phase | Critical | High | Medium | Low | Total | Effort estimate |
|-------|----------|------|--------|-----|-------|-----------------|
| **Quick (P1, ≤2-4h)** | 0 | 6 | 12 | 14 | 32 | ~50h |
| **Refactor (P2, 4-12h)** | 2 | 10 | 19 | 7 | 38 | ~210h |
| **Major (P3, 12h+)** | 1 | 3 | 4 | 2 | 10 | ~250h |
| **TOTAL** | **3** | **19** | **35** | **23** | **80*** | **~510h** |

*80 unique findings after de-duplication of cross-domain root causes (CODE-001, CODE-013, CODE-018 collapsed into ARCH umbrella entries; total raw findings = 85).
