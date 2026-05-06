# Architecture Audit — dzupagent

**Audit date:** 2026-05-06
**Scope:** `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent` — 32 packages, 1,535 source files (excluding tests), ~257k LOC.
**Tooling:** `madge --circular --extensions ts packages` (8.0.0), grep-based import tracing, `wc -l`, package.json inspection.

---

## Summary

- **Findings:** 22 (Critical: 1, High: 6, Medium: 9, Low: 6)
- **Cycles detected:** 28 (madge run @ 2026-05-06)
- **Layer violations (cross-package):** 1 confirmed; 4 borderline / direction-of-arrow questions
- **Files >500 LOC:** 72
- **Files >900 LOC:** 9
- **`packages/core/src/index.ts` exports:** 225 (877 lines) — barrel bloat
- **Largest packages:** agent (45,319 LOC, 235 files), agent-adapters (37,208 LOC, 166 files), server (34,682 LOC, 215 files), core (33,037 LOC, 223 files).

### Cycle distribution

| Package | Cycles |
|---------|-------:|
| agent-adapters | 10 |
| server | 8 |
| agent | 6 |
| core | 2 |
| adapter-types | 1 |
| **Total** | **28** (intra-package) |

No **cross-package** cycles were detected. All 28 cycles are within a single package.

---

## Dependency Map (observed)

Top inbound imports from non-test source files (`grep "from '@dzupagent/" packages/*/src --include="*.ts"` minus `*.test.ts`):

| From package | Imports From | Count | Layer-OK? |
|--------------|--------------|------:|-----------|
| agent | core | 163 | yes |
| agent | context | 24 | yes |
| agent | agent-types | 15 | yes |
| agent | memory | 12 | yes |
| agent | security | 3 | yes |
| agent-adapters | core | 173 | yes |
| agent-adapters | adapter-types | 14 | yes |
| **agent-adapters** | **agent** | **3** (workflow/*) | **questionable — see ARCH-001** |
| agent-adapters | adapter-rules | 5 | yes |
| codegen | core | 38 | yes |
| codegen | adapter-types | 3 | yes |
| codegen | (no agent/server/memory) | 0 | yes |
| memory | agent-types | 4 | yes |
| memory | cache | 2 | yes |
| server | core | 195 | yes |
| server | agent | 47 | yes |
| server | agent-adapters | 23 | yes |
| server | eval-contracts | 17 | yes |
| server | memory-ipc | 15 | yes |
| server | flow-compiler | 13 | yes |
| flow-compiler | flow-ast | 23 | yes |
| flow-compiler | flow-dsl | 1 | yes |
| flow-compiler | core | 7 | yes |
| flow-dsl | flow-ast | 9 | yes |
| core | agent-types | 3 | yes (agent-types is leaf) |
| core | runtime-contracts | 1 | yes (runtime-contracts is leaf) |

Observed hierarchy (clean): leaf type packages (`adapter-types`, `agent-types`, `runtime-contracts`, `eval-contracts`) → `core` → `cache`, `memory-ipc`, `context`, `memory`, `otel`, `security`, `connectors*`, `rag`, `scraper` → `flow-ast` → `flow-dsl`, `flow-compiler` → `agent`, `codegen` → `agent-adapters` → `server`, `evals`, `app-tools`, `express`, `hitl-kit`.

---

## Findings

### ARCH-001: `agent-adapters/workflow/*` imports `PipelineRuntime` from `@dzupagent/agent`, inverting the natural adapter-below-agent expectation

**Severity:** High
**Type:** layer-violation
**Files:**
- `packages/agent-adapters/src/workflow/default-pipeline-executor.ts:13` — `import { PipelineRuntime } from '@dzupagent/agent'`
- `packages/agent-adapters/src/workflow/adapter-workflow.ts:42` — `import type { PipelineRuntimeEvent } from '@dzupagent/agent'`
- `packages/agent-adapters/src/workflow/pipeline-assembler.ts:15` — imports concrete symbols from `@dzupagent/agent`

**Why it matters:** `packages/codegen/src/guardrails/rules/layering-rule.ts` declares the canonical layer ordering as:
```
[core] → [memory, context, codegen] → [agent] → [server]
```
`agent-adapters` is not present in this rule, but in dependency direction it sits *below* `server` and is consumed by it (`server` imports 23 times from `agent-adapters`). The `agent → agent-adapters` direction is also free of imports (correct). However, by importing `PipelineRuntime` (a concrete runtime class from `agent`), `agent-adapters/workflow` puts itself architecturally *above* `agent`, contradicting its name and the documented role as an "Optional adapter layer for integrating agent runtimes" (`CLAUDE.md`). Two coupling problems:

1. `PipelineRuntime` is a 1,043-LOC concrete class living in `agent`. By depending on the implementation, `agent-adapters` cannot be used without pulling all of `agent` (workflow-builder, dzip-agent, tool-loop, etc.).
2. `pipeline-assembler.ts` and `default-pipeline-executor.ts` are essentially adaptive glue between `flow-compiler` output and the agent's pipeline runtime. They belong either *inside* `agent` (as `agent/pipeline-adapters/`) or in a new thin `flow-runtime-adapter` package that depends on both.

**Fix:**
1. Extract `PipelineRuntimeEvent` and the pipeline-port interface (`PipelineNodeExecutor`, `PipelineRuntimeOptions`, ...) into `@dzupagent/core` or a new `@dzupagent/pipeline-port` contract package; have `agent` *implement* and `agent-adapters/workflow` *consume* the contract. The concrete `PipelineRuntime` class then never crosses the package boundary.
2. Or, move `pipeline-assembler.ts` and `default-pipeline-executor.ts` into `packages/agent/src/pipeline-adapters/` and re-export from `@dzupagent/agent/pipeline`.
3. Document the adapter layer position in `CLAUDE.md` and add `@dzupagent/agent-adapters` to the codegen layering rule (`packages/codegen/src/guardrails/rules/layering-rule.ts`).

**Acceptance:**
- `grep -rn "from '@dzupagent/agent'" packages/agent-adapters/src --include="*.ts" | grep -v ".test.ts"` returns zero matches (or only type-only imports of contract types that have been moved to a contract package).
- `yarn verify` passes.

**Effort:** 8-14 hours (depending on whether option 1 or 2 is chosen).

---

### ARCH-002: `packages/core/src/index.ts` is a 877-line / 225-export barrel, eroding the intended `stable` / `advanced` split

**Severity:** High
**Type:** api-surface
**Files:**
- `packages/core/src/index.ts` (877 LOC)
- `packages/core/src/stable.ts`, `packages/core/src/advanced.ts`, `packages/core/src/facades/*.ts`

**Why it matters:** `package.json` declares five entry points (`.`, `./stable`, `./advanced`, `./quick-start`, `./orchestration`, `./security`, `./facades`) plus the root barrel. Yet `agent-adapters` is already importing from `@dzupagent/core/advanced` and `@dzupagent/core/orchestration` (good) **and** from `@dzupagent/core` (bad — pulls the full 225-symbol barrel). Cross-package imports of `@dzupagent/core/orchestration` exist in:
- `packages/agent-adapters/src/orchestration/{supervisor,map-reduce}.ts`
- `packages/agent/src/orchestration/map-reduce.ts`
- `packages/evals/src/{prompt-experiment/prompt-experiment,runner/enhanced-runner}.ts`
- `packages/flow-compiler/src/lower/_shared.ts`

This proves the subpath split *works*; consumers want to use it. But everything also lives in the root barrel, so dead-code elimination cannot trim the dependency graph for consumers that only need `Semaphore`. The 225 root exports include heavy domain types (vectordb adapters, MCP types, security policy types, identity/delegation types) that should require an explicit subpath import.

**Fix:**
1. Audit `packages/core/src/index.ts`. Move every export that already has a subpath barrel (`vectordb`, `mcp`, `security`, `identity`, `protocol`, `pipeline`, `skills`, `formats`, `registry`, `subagent`, `prompt`) out of root and require consumers to import via a subpath.
2. Add subpath exports for: `./vectordb`, `./mcp`, `./skills`, `./pipeline`, `./prompt`, `./registry`, `./protocol`, `./security` (already exists as facade), `./identity`, `./events`, `./errors`, `./llm`.
3. Keep the root `@dzupagent/core` index to ~30 high-traffic exports: `ForgeError`, `createEventBus`, `DzupEventBus`, `DzupEvent`, `ModelRegistry`, `ForgeContainer`, `defaultLogger`, `ToolRegistry`-style entry types, `PipelineDefinition`/`PipelineNode` types.
4. Run `tsup` with `splitting: true` for core to confirm subpaths are tree-shakable.

**Acceptance:**
- `wc -l packages/core/src/index.ts` < 250.
- `grep -c "^export" packages/core/src/index.ts` < 50.
- All existing consumers continue to compile (some will need to switch to subpath imports — track with a codemod or lint rule).

**Effort:** 16-24 hours (high coordination cost across all consumer packages).

---

### ARCH-003: `core/vectordb` (3,631 LOC, 7 adapters) duplicates the surface of `@dzupagent/rag` (3,638 LOC) and yet they are not unified

**Severity:** High
**Type:** extraction-opportunity / coupling
**Files:**
- `packages/core/src/vectordb/` — `lancedb-adapter.ts` (616 LOC), `qdrant-adapter.ts`, `in-memory-vector-store.ts`, `semantic-store.ts`, embedding adapters, etc.
- `packages/rag/src/providers/qdrant.ts` (594 LOC), `packages/rag/src/qdrant-factory.ts` (imports `QdrantAdapter` from `@dzupagent/core/advanced`)

**Why it matters:** `core` ships its own QdrantAdapter, LanceDBAdapter, in-memory vector store, and embedding provider abstractions, totaling 3,631 LOC. `rag` then *imports* `QdrantAdapter` from core to build its retriever, while also implementing its own `providers/qdrant.ts`. The two implementations duplicate filter translation, connection pooling, and error mapping. This is a leaky boundary: the lower-tier `core` package owns vector-store implementation details that should live in `rag` (or in a new `@dzupagent/vector-store` package). It also bloats `core`'s install footprint with optional peer dependencies (`@qdrant/js-client-rest`, `@lancedb/lancedb`).

**Fix:**
1. Define a minimal `VectorStore` interface in `core` (probably already exists in `core/vectordb/types.ts` — verify). Keep the in-memory implementation only.
2. Move `qdrant-adapter.ts`, `lancedb-adapter.ts`, and other provider adapters into `@dzupagent/rag/providers` (or a new `@dzupagent/vector-store`).
3. Have `rag` consume the interface; `rag` becomes the single source of truth for vector-store implementations.
4. Update peerDependencies in core to remove vector-DB SDKs.

**Acceptance:**
- `find packages/core/src/vectordb -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1` reduced by at least 50%.
- `rag` no longer imports `QdrantAdapter` from `@dzupagent/core/advanced`.
- The interface contract (`VectorStore`, `EmbeddingProvider`) remains in core.

**Effort:** 12-20 hours.

---

### ARCH-004: `core/security` (3,094 LOC) and standalone `packages/security` (464 LOC) overlap — `core/security` should largely move to `packages/security`

**Severity:** High
**Type:** extraction-opportunity / inverted-dependency
**Files:**
- `packages/core/src/security/` — `secrets-scanner.ts`, `pii-detector.ts`, `content-sanitizer.ts`, `output-pipeline.ts`, `risk-classifier.ts`, `monitor/`, `policy/`, `classification/`, `audit/`, `memory/`, `output/` — 3,094 LOC
- `packages/security/src/` — `pii/`, `prompt-injection/`, `content-scanner.ts` — 464 LOC

**Why it matters:** Two security packages that overlap in PII detection, content scanning, output filtering, and policy. `core/security` has more depth (audit logging, risk classification, policy evaluator, classification-aware redactor) but lives in the lower-tier `core` package, forcing core to ship 3,094 LOC of security logic to *every* consumer. Meanwhile the dedicated `@dzupagent/security` package is anemic. Direction is inverted: PII/secrets/output-filter/audit are *application-layer* security concerns and should live in a tier-2 package.

**Fix:**
1. Move `core/security/audit/`, `core/security/classification/`, `core/security/memory/`, `core/security/monitor/`, `core/security/output/`, `core/security/policy/` into `packages/security/src/`.
2. Keep in `core/security/` only what is needed by the LLM invocation path: low-level interfaces (`SecretMatcher`, `SanitizationStage`, `RiskTier`) and the inline secret/PII regex scanners that the model registry calls before logging.
3. Add `@dzupagent/security` as a runtime dep of `agent`, `agent-adapters`, `server` (which need full output pipelines).

**Acceptance:**
- `find packages/core/src/security -name '*.ts' | xargs wc -l | tail -1` < 1,000 LOC.
- `find packages/security/src -name '*.ts' | xargs wc -l | tail -1` > 2,000 LOC.
- No regressions in `yarn verify`.

**Effort:** 16-24 hours.

---

### ARCH-005: 28 intra-package circular dependencies, including 10 in `agent-adapters` and 8 in `server`

**Severity:** High
**Type:** cycle
**Files (representative):**
- `packages/server/src/runtime/run-worker.ts` ↔ `packages/server/src/runtime/run-worker-stages.ts`
- `packages/server/src/types.ts` → `packages/server/src/middleware/rbac.ts` (and rbac re-imports types)
- `packages/server/src/composition/types.ts` → `routes/deploy.ts` → `deploy/signal-checkers.ts` → `deploy/confidence-calculator.ts` → `scorecard/integration-scorecard.ts` (5-hop)
- `packages/agent-adapters/src/workflow/adapter-workflow.ts` ↔ `pipeline-assembler.ts` ↔ `adapter-workflow-execution.ts`
- `packages/agent-adapters/src/recovery/adapter-recovery.ts` ↔ `recovery-attempt-handler.ts` ↔ {recovery-events, recovery-strategy-application, recovery-strategy} (4 cycles)
- `packages/agent/src/agent/tool-loop.ts` ↔ `tool-loop/{model-turn-kernel,policy-enabled-tool-executor}.ts`
- `packages/core/src/config/config-loader.ts` ↔ `config-schema.ts`
- `packages/core/src/prompt/template-cache.ts` ↔ `template-resolver.ts`

**Why it matters:** Cycles defeat tree-shaking, slow IDE responsiveness, and produce subtle initialization-order bugs (a `class X` import resolves to `undefined` if it's mid-evaluation when re-entered through the cycle). Each cycle should be broken by extracting the shared types/symbols into a third file imported by both sides. The 5-hop `composition/types → routes/deploy → deploy/* → scorecard/*` cycle in `server` is a clear sign that `composition/types.ts` is being used as a kitchen-sink ambient namespace.

**Fix:**
1. Quick wins (local cycles between two files): introduce a sibling `*-types.ts` (no imports) that both files import. Apply to:
   - `core/config/config-loader.ts` ↔ `config-schema.ts` → extract `ForgeConfig` to `core/config/config-types.ts`.
   - `core/prompt/template-cache.ts` ↔ `template-resolver.ts` → move `PromptStore` interface into a new `core/prompt/template-store.ts`.
   - `server/types.ts` ↔ `middleware/rbac.ts` → move `ForgeRole` from `rbac.ts` to `types.ts` (or to a new `server/rbac-types.ts`).
   - `server/runtime/run-worker.ts` ↔ `run-worker-stages.ts` → move shared types (RunWorkerState, etc.) to `server/runtime/run-worker-types.ts`.
   - `server/runtime/tool-resolver.ts` ↔ `custom-tool-instantiation.ts` → same pattern.
   - `server/scorecard/integration-scorecard.ts` ↔ `probe-collector.ts` → same.
   - `server/a2a/task-handler.ts` ↔ `push-notifications.ts` → same.
   - `agent/agent/agent-types.ts` ↔ `memory-profiles.ts` → same (memory-profiles already imports `agent-types`; have agent-types not import memory-profiles).
   - `agent/self-correction/recovery-feedback.ts` ↔ `learning-candidate.ts` → same.
   - `agent/orchestration/delegating-supervisor.ts` ↔ `planning-agent.ts` → same.
   - `adapter-types/contracts/events.ts` ↔ `execution.ts` → same.
2. Refactor (4+ hop cycles): `agent-adapters/recovery/*` and `agent-adapters/workflow/*` need a structural review — likely split into a `recovery-types.ts` / `workflow-types.ts` shared module.
3. Add CI gate: `npx madge --circular --extensions ts packages` exits non-zero. Wire into `yarn verify`.

**Acceptance:**
- `npx madge --circular --extensions ts packages` reports 0 cycles.
- A new CI step fails the build on circular detection.

**Effort:** 24-40 hours (varies by cycle complexity; quick wins are <2h each).

---

### ARCH-006: `core` imports types from `@dzupagent/agent-types` and `@dzupagent/runtime-contracts` — only OK because those are pure leaf type packages with no `dependencies`

**Severity:** Low (informational, but worth documenting)
**Type:** layer-clarification
**Files:**
- `packages/core/src/guardrails/stuck-detector.ts:13` — `import type { StuckDetectorConfig } from '@dzupagent/agent-types'`
- `packages/core/src/llm/retry.ts:9` — `export type { RetryPolicy } from '@dzupagent/agent-types'`
- `packages/core/src/skills/skill-chain.ts:13` — `import type { RetryPolicy as CanonicalRetryPolicy } from '@dzupagent/agent-types'`
- `packages/core/src/skills/skill-model-v2.ts:86` — `from '@dzupagent/runtime-contracts'`

**Why it matters:** This audit assumed the hierarchy `runtime-contracts / agent-types → core`. The naming is unintuitive (`agent-types` looks higher than `core`) but verified: both `agent-types` and `runtime-contracts` have **no `dependencies`** in their `package.json`, making them true contract leaves below core. Document this in `CLAUDE.md` and the layering rule.

**Fix:**
- Update `packages/codegen/src/guardrails/rules/layering-rule.ts` `DEFAULT_LAYERS` to:
  ```ts
  [
    ['@dzupagent/runtime-contracts', '@dzupagent/agent-types', '@dzupagent/adapter-types', '@dzupagent/eval-contracts'],
    ['@dzupagent/core'],
    ['@dzupagent/cache', '@dzupagent/memory-ipc', '@dzupagent/otel'],
    ['@dzupagent/context', '@dzupagent/memory', '@dzupagent/security', '@dzupagent/rag', '@dzupagent/connectors'],
    ['@dzupagent/flow-ast'],
    ['@dzupagent/flow-dsl', '@dzupagent/flow-compiler'],
    ['@dzupagent/codegen', '@dzupagent/agent'],
    ['@dzupagent/agent-adapters', '@dzupagent/adapter-rules'],
    ['@dzupagent/server', '@dzupagent/express', '@dzupagent/evals', '@dzupagent/app-tools', '@dzupagent/hitl-kit'],
  ]
  ```
- Add `docs/dzupagent/architecture/LAYERING.md` enumerating the rule with rationale.

**Acceptance:**
- Codegen rule fires on a synthetic violation in a test.
- `docs/dzupagent/architecture/LAYERING.md` exists.

**Effort:** 2-3 hours.

---

### ARCH-007: 9 source files exceed 900 LOC — multi-responsibility "god objects"

**Severity:** Medium
**Type:** god-object
**Files (top 20 over 600 LOC):**

| LOC | File | Concerns |
|----:|------|----------|
| 1,410 | `packages/flow-ast/src/validate.ts` | Hand-rolled Zod-compatible validation for ~17 node kinds + helpers |
| 1,125 | `packages/agent-adapters/src/codex/codex-adapter.ts` | Codex SDK wrapping + event normalization + capabilities |
| 1,077 | `packages/flow-ast/src/parse.ts` | Parser for all 17 node kinds in one switch |
| 1,043 | `packages/agent/src/pipeline/pipeline-runtime.ts` | Pipeline execution + checkpoints + forks/joins/loops/gates/errors |
| 1,018 | `packages/flow-dsl/src/normalize.ts` | DSL-to-AST normalizer for all node kinds |
| 969 | `packages/server/src/routes/runs.ts` | 12 endpoints in one file |
| 966 | `packages/agent/src/workflow/workflow-builder.ts` | Fluent builder + compile + WorkflowExecutor |
| 950 | `packages/memory/src/sharing/memory-space-manager.ts` | Spaces, joining, sharing, retention, events |
| 942 | `packages/agent/src/agent/dzip-agent.ts` | Top-level agent class (already deferred to streaming-run, structured-generate, daemon-launcher per its own docstring; still 942 LOC) |
| 877 | `packages/core/src/index.ts` | Barrel — see ARCH-002 |
| 847 | `packages/agent/src/orchestration/delegating-supervisor.ts` | Supervisor orchestration |
| 825 | `packages/agent/src/agent/tool-loop.ts` | ReAct loop |
| 821 | `packages/agent/src/index.ts` | Barrel |
| 807 | `packages/flow-compiler/src/stages/semantic.ts` | Semantic analysis |
| 798 | `packages/server/src/runtime/run-worker-stages.ts` | Run worker stage orchestration |
| 797 | `packages/agent-adapters/src/dzupagent/syncer.ts` | DzupAgent sync logic |
| 794 | `packages/agent-adapters/src/http/adapter-http-handler.ts` | HTTP handler for adapters |
| 783 | `packages/agent-adapters/src/claude/claude-adapter.ts` | Claude SDK adapter |
| 782 | `packages/server/src/routes/compile.ts` | Compile endpoint group |
| 774 | `packages/core/src/events/event-types.ts` | Event type union |

**Why it matters:** Files >500 LOC are harder to test, slow IDE navigation, and tend to accumulate unrelated concerns. The framework already has refactoring precedent (e.g., `dzip-agent.ts` docstring lists `streaming-run.ts`, `structured-generate.ts`, `daemon-launcher.ts` as already-extracted modules — keep going).

**Fix:**
- For per-node-kind switches in `flow-ast` and `flow-dsl`: split into `parse/<kind>.ts`, `validate/<kind>.ts`, `normalize/<kind>.ts` and dispatch from a thin index. ~17 small files each.
- For `pipeline-runtime.ts`: extract `fork-executor.ts`, `join-executor.ts`, `gate-executor.ts`, `checkpoint-handler.ts` (loop-executor already exists alongside).
- For `routes/runs.ts`: split each endpoint handler into its own file (`handlers/trigger-run.ts`, `handlers/cancel-run.ts`, ...). Pattern matches what `runs.ts` docstring already promises ("every endpoint is backed by a named handler function exported below").
- For `workflow-builder.ts`: extract the `CompiledWorkflow` execution path into a sibling file.
- For codex/claude adapters (>1,000 LOC): split event-normalization, capability detection, and SDK invocation.

**Acceptance:**
- After refactor, no source file >700 LOC except generated barrels.
- `find packages -name "*.ts" -not -name "*.test.ts" -exec wc -l {} + | sort -rn | head -10` shows the top entry below 700.

**Effort:** 60-100 hours total across all 20 files; can be done incrementally one package at a time.

---

### ARCH-008: `flow-ast`, `flow-dsl`, `flow-compiler` — three packages with strong coupling that may justify consolidation or a shared subpath structure

**Severity:** Low
**Type:** package-boundary
**Files:**
- `packages/flow-ast/src/` — 7 files, 2,998 LOC, no `@dzupagent/*` deps
- `packages/flow-dsl/src/` — 10 files, 1,943 LOC, depends only on `flow-ast`
- `packages/flow-compiler/src/` — 14 files, 3,777 LOC, depends on `flow-ast` (23 imports) and `flow-dsl` (1 import)

**Why it matters:** All three packages are consumed primarily as a tuple by `agent`, `server`, and the codegen pipeline. The combined surface is 8.7k LOC across 31 files — a single mid-sized package. Three packages add three `package.json`s, three `tsup.config.ts`s, three test runners, three publish artifacts, and complicate the dependency-resolution graph at install time. The tradeoff: independent versioning and the option for a downstream consumer to use only `flow-ast` (zero hits in repo for `flow-ast` without a flow-dsl/compiler dep). Recommendation: keep separate but introduce a meta package or document why the split exists; revisit if external consumers never appear.

**Fix:** (optional)
1. Document in `docs/dzupagent/architecture/` why the flow stack is three packages.
2. Consider a `@dzupagent/flow` umbrella package re-exporting `ast`, `dsl`, `compiler` for ergonomics.
3. Or merge into a single `@dzupagent/flow` package with subpath exports `./ast`, `./dsl`, `./compiler`.

**Acceptance:**
- An ADR explains the choice.
- If merged, the consolidated package is 8.7k LOC with three subpath exports and `agent`, `server`, etc. import paths updated.

**Effort:** 0h (document) or 16-24h (consolidate).

---

### ARCH-009: `adapter-types`, `adapter-rules`, `agent-types`, `runtime-contracts`, `eval-contracts` — five small contract packages, none with deps; consider consolidating into one `@dzupagent/contracts`

**Severity:** Low
**Type:** package-boundary / extraction-opportunity
**Files:**
- `packages/agent-types/src/` — 7 files, 440 LOC, 0 deps
- `packages/runtime-contracts/src/` — 6 files, 338 LOC, 0 deps
- `packages/adapter-types/src/` — 12 files, 998 LOC, 0 deps
- `packages/adapter-rules/src/` — 12 files, 1,023 LOC, depends on adapter-types
- `packages/eval-contracts/src/` — 5 files, 445 LOC, 0 deps

**Why it matters:** Five tiny contract packages, four of which have zero dependencies. Each requires its own build step, README, version bump. They serve a real purpose (declaring shapes that consumers across many packages can agree on without circular imports), but the user-facing distinction between `agent-types`, `runtime-contracts`, and `adapter-types` is unclear from naming alone. Combined: ~3,200 LOC, 42 files — one mid-sized package.

**Fix:** (optional)
1. Document the split (start with a glossary in `docs/dzupagent/architecture/CONTRACTS.md`): which package owns *which* boundary?
   - `runtime-contracts` = ports/interfaces invoked at runtime by agent kernels
   - `agent-types` = configuration and policy shapes
   - `adapter-types` = provider-adapter SDK ports
   - `eval-contracts` = scorer and benchmark contracts
2. Or consolidate to `@dzupagent/contracts` with subpath exports `/runtime`, `/agent`, `/adapter`, `/eval`. Reduces the dep matrix significantly.
3. `adapter-rules` is meaningfully different (it's runtime rule code, not just types) — keep separate.

**Acceptance:**
- ADR or glossary describing each contract package, OR
- Consolidated `@dzupagent/contracts` with all five merged.

**Effort:** 4h (document) or 12-20h (consolidate).

---

### ARCH-010: `core` mid-tier subdomains exceed 2,000 LOC each — extraction candidates: `mcp`, `protocol`, `skills`, `identity`, `persistence`, `formats`

**Severity:** Medium
**Type:** extraction-opportunity / coupling
**Files (LOC by core subdomain):**
- `core/vectordb` — 3,631 (see ARCH-003)
- `core/security` — 3,094 (see ARCH-004)
- `core/mcp` — 3,010
- `core/protocol` — 2,826 (A2A: a2a-client-adapter, a2a-json-rpc, a2a-push-notification, a2a-sse-stream, message-factory, ...)
- `core/skills` — 2,334
- `core/identity` — 2,196 (api-key-resolver, capability-checker, delegation-manager/store/types, identity-resolver/schemas/types, key-manager, signing-types, trust-scorer)
- `core/persistence` — 1,934
- `core/formats` — 1,650

**Why it matters:** Core is 33k LOC across 223 files. Eight subdirectories own ~80% of the volume. Three of them (mcp, protocol, identity) are advanced features that not every consumer needs. Pushing them out makes core lean and gives each subdomain its own version cadence.

**Fix:**
- Phase 1: extract `core/protocol/` (A2A) → `@dzupagent/a2a`. The protocol is a self-contained module that already has its own ARCHITECTURE.md.
- Phase 2: extract `core/mcp/` → `@dzupagent/mcp`. Same logic, MCP client/manager/connection pool is a self-contained domain.
- Phase 3: extract `core/identity/` → `@dzupagent/identity`. Trust scoring, delegation, API-key resolution form a coherent security perimeter (combine with security work in ARCH-004).
- Phase 4: extract `core/skills/` → `@dzupagent/skills` (keep type contract in core).
- Phase 5: extract `core/formats/` → `@dzupagent/formats`.

**Acceptance:**
- Each phase: core LOC drops by extraction size; new package owns the subdir; consumer imports updated.
- `core` ends ≤15k LOC across ≤120 files.

**Effort:** 6-12h per phase × 5 phases = 30-60 hours.

---

### ARCH-011: `server/composition/types.ts` is a kitchen-sink ambient module imported by `routes/deploy.ts`, `routes/run-context.ts`, and downstream — root cause of two cycles

**Severity:** Medium
**Type:** coupling / cycle-source
**Files:**
- `packages/server/src/composition/types.ts` (cycle root for cycles 23 & 25)
- `packages/server/src/routes/deploy.ts` → `deploy/signal-checkers.ts` → `deploy/confidence-calculator.ts` → `scorecard/integration-scorecard.ts` (5-hop cycle back to composition/types)
- `packages/server/src/routes/run-context.ts`

**Why it matters:** A single types module imported by routes that imports back into composition land creates a 5-file cycle. This pattern of "dump shared route types in composition/types" is fragile.

**Fix:**
1. Extract the route-context types (whatever `run-context.ts` actually needs) into `server/routes/run-context-types.ts`.
2. Extract deploy-pipeline types into `server/deploy/deploy-types.ts` (no upward imports).
3. Reduce `composition/types.ts` to only the composition-root contracts.

**Acceptance:**
- `madge` no longer reports cycles 23 and 25.
- `composition/types.ts` < 200 LOC.

**Effort:** 4-6 hours.

---

### ARCH-012: `server/routes/runs.ts` (969 LOC) violates the file's own design intent stated in its docstring

**Severity:** Medium
**Type:** god-object
**Files:**
- `packages/server/src/routes/runs.ts:1-26` — docstring says "every endpoint is backed by a named handler function exported below"

**Why it matters:** The file documents the intent to keep handlers extractable, but they all still live in the same 969-LOC file. Splitting them now would honor the docstring and substantially shrink the file.

**Fix:**
- Create `packages/server/src/routes/runs/` directory.
- Extract each handler to its own file: `handlers/trigger-run.ts`, `handlers/list-runs.ts`, `handlers/get-run.ts`, `handlers/cancel-run.ts`, `handlers/pause-run.ts`, `handlers/resume-run.ts`, `handlers/fork-run.ts`, `handlers/list-checkpoints.ts`, `handlers/get-logs.ts`, `handlers/get-trace.ts`, `handlers/stream-events.ts`.
- `routes/runs.ts` becomes the thin Hono router that wires named handlers.

**Acceptance:**
- `wc -l packages/server/src/routes/runs.ts` < 200.
- Each handler file < 150 LOC.
- All run-route tests still pass.

**Effort:** 8-10 hours.

---

### ARCH-013: `agent/src/index.ts` re-exports 210 symbols (821 LOC); same barrel-bloat pattern as core

**Severity:** Medium
**Type:** api-surface
**Files:** `packages/agent/src/index.ts`

**Why it matters:** Agent already has 9 subpath exports declared (`./agent`, `./orchestration`, `./self-correction`, `./replay`, `./pipeline`, `./runtime`, `./workflow`, `./tools`, `./compat`). Yet the root barrel still exports 210 symbols, undermining the subpath structure. Same fix as ARCH-002.

**Fix:**
1. Audit root barrel; move subdomain exports to subpath barrels and *remove* from root.
2. Keep root to ~30 high-traffic symbols: `DzupAgent`, `createAgentWithMemory`, `IterationBudget`, `WorkflowBuilder`, `createWorkflow`, `runToolLoop`, key event types.

**Acceptance:**
- `grep -c "^export" packages/agent/src/index.ts` < 60.
- `wc -l packages/agent/src/index.ts` < 250.

**Effort:** 8-12 hours.

---

### ARCH-014: 20 of 32 packages have READMEs (≈63%); under-documented packages slow onboarding

**Severity:** Low
**Type:** documentation / api-surface
**Files:** the 12 packages without `README.md`.

**Why it matters:** Without per-package READMEs, contributors guess responsibilities from the directory name. ARCH-009 (contract package distinctions) is partly caused by this.

**Fix:**
- Generate stub READMEs for all 12 missing packages using a template:
  - Package name + purpose (one paragraph)
  - Public API summary (subpath exports listed)
  - Layer position (link to layering doc)
  - Example consumer

**Acceptance:**
- `find packages -maxdepth 2 -name "README.md" | wc -l` returns 32.

**Effort:** 4-6 hours.

---

### ARCH-015: No CI gate for circular dependencies; cycles accumulate silently

**Severity:** Medium
**Type:** ci-gate / process
**Files:** `package.json` (root) — `verify` script.

**Why it matters:** 28 cycles were discovered via this audit by manually running `madge`. Without a CI gate, every new cycle is invisible until someone audits.

**Fix:**
1. Add to root `package.json`:
   ```json
   "scripts": {
     "check:cycles": "madge --circular --extensions ts packages",
     "verify": "turbo run build typecheck lint test && yarn check:cycles"
   }
   ```
2. Add `madge` as a devDependency.
3. Optionally start with a tolerance file (`.madgerc` excluding the 28 known cycles) and gate at "no new cycles" until ARCH-005 is fully resolved.

**Acceptance:**
- `yarn check:cycles` exits non-zero when a new cycle is introduced.
- CI workflow includes the check.

**Effort:** 2-3 hours.

---

### ARCH-016: No CI gate for layering rule; the rule exists in `codegen/guardrails` but isn't run on the framework itself

**Severity:** Medium
**Type:** ci-gate / process
**Files:** `packages/codegen/src/guardrails/rules/layering-rule.ts`

**Why it matters:** The framework ships a layering guardrail used to enforce architecture in *generated code*, but doesn't apply it to its own packages. Self-application would have caught ARCH-001.

**Fix:**
1. Add a script `scripts/check-framework-layering.ts` that uses `createLayeringRule` against `packages/*/src/**/*.ts`.
2. Wire into `yarn verify`.
3. Use the corrected layer ordering from ARCH-006.

**Acceptance:**
- `yarn check:layering` runs the rule against the framework.
- A synthetic violation in any package fails the gate.
- ARCH-001's `agent-adapters → agent` is detected by the gate (and fixed before the gate is enabled, or temporarily allowlisted).

**Effort:** 6-8 hours.

---

### ARCH-017: `core/index.ts` directly re-exports `QdrantAdapter` (line 783) — confusing surface for a "core" import

**Severity:** Low
**Type:** api-surface
**Files:** `packages/core/src/index.ts:783, 802`

**Why it matters:** A consumer reading `import { QdrantAdapter } from '@dzupagent/core'` would reasonably ask "does core need a Qdrant client?" The answer is no — Qdrant is an optional peer dep — but the root barrel exposes it without ceremony, encouraging consumers to import from the wrong place.

**Fix:**
- Remove `QdrantAdapter` (and other vector-DB adapters) from the root barrel; require `import { QdrantAdapter } from '@dzupagent/core/vectordb'` (or move out of core entirely per ARCH-003).

**Acceptance:**
- `grep "QdrantAdapter\|LanceDBAdapter" packages/core/src/index.ts` returns no matches.

**Effort:** 1-2 hours (or rolled into ARCH-002/ARCH-003).

---

### ARCH-018: Top-level `agent-adapters` index re-exports 5 subpaths; verify each subpath is actually used independently

**Severity:** Low
**Type:** api-surface
**Files:** `packages/agent-adapters/package.json` exports field

**Why it matters:** `agent-adapters` exposes 11 subpath exports (`./providers`, `./orchestration`, `./workflow`, `./http`, `./persistence`, `./runs`, `./integration`, `./rules`, `./learning`, `./recovery`). Confirm each subpath's usage to see whether the surface is justified or whether some are aspirational (used only inside the package).

**Fix:**
- For each subpath, run `grep -rn "from '@dzupagent/agent-adapters/<subpath>" packages apps` to confirm external consumers exist.
- Fold unused subpaths back into the root barrel; or keep them with a rationale in `agent-adapters/ARCHITECTURE.md`.

**Acceptance:**
- Each remaining subpath has at least one external consumer.

**Effort:** 2-3 hours.

---

### ARCH-019: `memory` declares only 3 deps (`@dzupagent/agent-types`, `@dzupagent/cache`, `@dzupagent/memory-ipc`) but does not re-export any subpath — small but dense surface (21.5k LOC, single export)

**Severity:** Low
**Type:** api-surface
**Files:** `packages/memory/package.json`, `packages/memory/src/index.ts`

**Why it matters:** memory is 21.5k LOC. A single root export forces consumers to load the entire memory package even if they only need `MemoryService` or only `MemorySpaceManager` (950 LOC by itself). Subpath exports would let `agent` (which imports from memory 12 times) trim the surface.

**Fix:**
- Define subpaths matching the memory subdirs: `./service`, `./store`, `./consolidation`, `./retrieval`, `./sharing`, `./convention`, `./crdt`, `./provenance`.
- Update `package.json` exports.

**Acceptance:**
- 6+ subpath exports declared.
- At least one external consumer (`agent` or `server`) uses a subpath.

**Effort:** 4-6 hours.

---

### ARCH-020: `agent-adapters` declares both `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` as `optionalDependencies`, but the corresponding adapter files (claude-adapter.ts:783 LOC, codex-adapter.ts:1125 LOC) live in the same package — preventing tree-shaking

**Severity:** Low
**Type:** package-boundary
**Files:**
- `packages/agent-adapters/src/claude/claude-adapter.ts`
- `packages/agent-adapters/src/codex/codex-adapter.ts`
- `packages/agent-adapters/package.json` `optionalDependencies`

**Why it matters:** A consumer that only wants the Claude adapter still installs the codex adapter source; tsup ESM bundling can tree-shake but only if subpath exports gate the import. Currently both are exported via `./providers` (one barrel).

**Fix:**
- Split exports: `./providers/claude` and `./providers/codex` (separate subpaths).
- Or split into separate packages: `@dzupagent/adapter-claude`, `@dzupagent/adapter-codex`.

**Acceptance:**
- Consumers can import `@dzupagent/agent-adapters/providers/claude` without pulling codex code.

**Effort:** 4-8 hours (subpath split) or 12-20h (package split).

---

### ARCH-021: `core/events/event-types.ts` (774 LOC) is the canonical event union — risk of becoming a god-file as new event kinds accumulate

**Severity:** Medium
**Type:** god-object / future-risk
**Files:** `packages/core/src/events/event-types.ts`

**Why it matters:** Every new event kind across the framework adds a discriminated-union member here. The current 774 LOC houses all event types. If event-driven extension is a stated principle (per CLAUDE.md "Event-driven, typed `DzupEventBus`"), this file will keep growing.

**Fix:**
- Split by domain: `event-types-lifecycle.ts`, `event-types-adapter.ts`, `event-types-workflow.ts`, `event-types-tool.ts`, `event-types-budget.ts`, `event-types-mapreduce.ts`, etc.
- Re-export the union from `event-types.ts`.
- Or move event types into the package that owns the domain (e.g., `WorkflowEvent` in `agent`, `AdapterEvent` in `agent-adapters`) and have core only define the base `DzupEvent` discriminator.

**Acceptance:**
- Event-types file < 200 LOC.
- Each domain owns its event union.

**Effort:** 8-12 hours.

---

### ARCH-022: Existing boundary gates need cycle and dependency-completeness coverage

**Severity:** Medium
**Type:** ci-gate / process
**Files:** `package.json`, `packages/testing/src/__tests__/boundary/architecture.test.ts`, CI workflow

**Why it matters:** This audit ran 32-package scans manually. The combination of:
- ARCH-001 (agent-adapters → agent)
- ARCH-005 (28 cycles)
- ARCH-006 (layering rule not applied to framework)
- ARCH-017 (vendor types in core barrel)

…all stem from incomplete automated boundary enforcement. This is not a from-scratch package-boundary gap: `yarn verify` already runs domain-boundary checks, and `packages/testing/src/__tests__/boundary/architecture.test.ts` already loads machine-readable boundary policy. The remaining root cause is that cycle detection and declared-vs-actual dependency completeness are not yet enforced with the same rigor.

**Fix:**
1. Extend the existing architecture/boundary check surface:
   - Run `madge --circular` and fail on any new or unallowlisted cycle until the existing cycle baseline is fixed.
   - Run the layering rule against `packages/*/src` with the corrected hierarchy.
   - Verify each package's declared `dependencies` matches its actual imports (no undeclared, no stale).
   - Verify `index.ts` of each package only re-exports from its own `src/`.
   - Optionally diff `index.ts` exports between commits and warn on >5% surface growth.
2. Wire into `yarn verify` and CI.
3. Document in `docs/dzupagent/architecture/CI-GATES.md`.

**Acceptance:**
- `yarn check:architecture` runs all four checks.
- CI fails on any architectural regression.
- A PR adding a new cycle, layer violation, or undeclared dep is rejected.

**Effort:** 6-12 hours for gate completion; cycle elimination remains separate under ARCH-005.

---

## Recommendations Summary

### Quick wins (≤4h each)
- ARCH-006: update layering rule to include all contract leaves and `agent-adapters`/`adapter-rules` (2-3h)
- ARCH-014: stub READMEs for 12 missing packages (4-6h)
- ARCH-015: add `madge` CI gate with allowlist (2-3h)
- ARCH-017: remove `QdrantAdapter` from core root barrel (1-2h)
- ARCH-018: audit agent-adapters subpath usage (2-3h)
- ARCH-019: add memory subpath exports (4-6h)

### Refactors (4-24h each)
- ARCH-005: break local cycles via shared `*-types.ts` modules (24-40h, mostly mechanical)
- ARCH-011: extract `server/composition/types` god-module (4-6h)
- ARCH-012: split `server/routes/runs.ts` into per-handler files (8-10h)
- ARCH-016: apply layering rule to framework itself (6-8h)
- ARCH-020: split agent-adapters provider subpaths (4-8h)
- ARCH-021: split core event-types union (8-12h)
- ARCH-022: implement `scripts/check-architecture.ts` (16-24h)

### Major changes (24h+ each, multi-week scope)
- ARCH-001: extract pipeline-runtime port to remove agent-adapters → agent (8-14h)
- ARCH-002: shrink core/index.ts barrel to <30 exports + subpath split (16-24h)
- ARCH-003: move vector-store implementations from core to rag (12-20h)
- ARCH-004: move security audit/policy/output from core to packages/security (16-24h)
- ARCH-007: split 9 god files (60-100h)
- ARCH-008: consolidate or document flow-* packages (0h or 16-24h)
- ARCH-009: consolidate or document contract packages (4h or 12-20h)
- ARCH-010: extract core subdomains (mcp, protocol, identity, skills) (30-60h)
- ARCH-013: shrink agent/index.ts barrel (8-12h)

**Total estimated effort:** ~370-580 hours (≈10-15 dev-weeks).
