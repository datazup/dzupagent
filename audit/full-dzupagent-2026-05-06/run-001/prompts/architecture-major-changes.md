# Architecture Major Changes

Sprint-scale refactors taking 24+ hours each. These are restructurings of package boundaries that require coordinated changes across many consumers. Sequence: deliver MC-ARCH-001 (vector-DB extraction) and MC-ARCH-002 (security extraction) before MC-ARCH-003 (core extractions); they reduce core surface area first.

---

## MC-ARCH-001: Extract vector-DB implementations from `core/vectordb` to `@dzupagent/rag`

**Files moved (3,631 LOC):**
- `packages/core/src/vectordb/adapters/{qdrant-adapter,lancedb-adapter,...}.ts` → `packages/rag/src/providers/`
- `packages/core/src/vectordb/embeddings/` → `packages/rag/src/embeddings/`
- `packages/core/src/vectordb/{semantic-store,filter-utils,auto-detect}.ts` → `packages/rag/src/providers/`

**Files retained in core (interface-only):**
- `packages/core/src/vectordb/types.ts` — `VectorStore`, `VectorEntry`, `VectorQuery`, `EmbeddingProvider` interfaces.
- `packages/core/src/vectordb/in-memory-vector-store.ts` — keep the in-memory test impl (no external SDK deps).

**Why:** `core` is shipping 3,631 LOC of vector-DB integrations with optional peer deps (`@qdrant/js-client-rest`, `@lancedb/lancedb`). These belong in `rag`, which already has its own Qdrant provider (594 LOC) and currently *imports back* from core (`packages/rag/src/qdrant-factory.ts` imports `QdrantAdapter` from `@dzupagent/core/advanced`). Cleaner: rag owns implementations, core owns the contract.

**Change:**
1. Move adapter files; update internal imports inside `rag` to use the new locations.
2. Remove `QdrantAdapter`/`LanceDBAdapter` exports from `packages/core/src/index.ts` and from `core/vectordb/index.ts`. Keep only types and `InMemoryVectorStore`.
3. Add `@dzupagent/rag` as a runtime dep where needed.
4. Update all consumers (run `grep -rn "from '@dzupagent/core/vectordb'\|from '@dzupagent/core/advanced'" packages apps --include="*.ts"`):
   - Implementations → switch import to `@dzupagent/rag`.
   - Interfaces only → keep as `@dzupagent/core/vectordb`.
5. Drop the optional peer deps for vector DB SDKs from `core/package.json`; add them to `rag/package.json` peer-deps.

**Validation:**
- `find packages/core/src/vectordb -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1` ≤ 800 LOC.
- `find packages/rag/src -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1` ≥ 5,000 LOC.
- `yarn verify` passes.
- No package outside `rag` imports a Qdrant or LanceDB symbol.

**Target agent:** `dzupagent-core-dev`
**Effort:** 12-20 hours.

---

## MC-ARCH-002: Extract output-pipeline / classification / policy / audit from `core/security` to `@dzupagent/security`

**Files moved (~2,500 LOC of 3,094):**
- `packages/core/src/security/audit/` → `packages/security/src/audit/`
- `packages/core/src/security/classification/` → `packages/security/src/classification/`
- `packages/core/src/security/memory/` → `packages/security/src/memory-defense/`
- `packages/core/src/security/monitor/` → `packages/security/src/monitor/`
- `packages/core/src/security/output/` → `packages/security/src/output/`
- `packages/core/src/security/policy/` → `packages/security/src/policy/`
- `packages/core/src/security/output-pipeline.ts` → `packages/security/src/output-pipeline.ts`
- `packages/core/src/security/risk-classifier.ts` → `packages/security/src/risk-classifier.ts`
- `packages/core/src/security/content-sanitizer.ts` → `packages/security/src/content-sanitizer.ts`
- `packages/core/src/security/outbound-url-policy.ts` → `packages/security/src/outbound-url-policy.ts`

**Files retained in core (small, used in LLM invocation hot path):**
- `packages/core/src/security/secrets-scanner.ts` — used to redact secrets from log/audit lines before they leave core.
- `packages/core/src/security/pii-detector.ts` — used by core middleware for inline PII redaction.
- `packages/core/src/security/tool-permission-tiers.ts` — used by core tool registry.

**Why:** Security audit logging, policy evaluation, output pipelines, and risk classification are application-layer concerns. They don't belong in the foundation `core` package. Today the standalone `@dzupagent/security` package is anemic (464 LOC) while core's security folder is 3,094 LOC.

**Change:**
1. Move files listed above.
2. Add interface re-exports in core for any contract types still referenced from core code (e.g., `SanitizationStage`).
3. Update consumers (search for affected imports): `agent`, `agent-adapters`, `server`, `evals`. They should depend on `@dzupagent/security` directly for runtime classes; on `@dzupagent/core` only for low-level types.
4. Add `@dzupagent/security` as a runtime dep of every consumer.

**Validation:**
- `find packages/core/src/security -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1` ≤ 800 LOC.
- `find packages/security/src -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1` ≥ 2,500 LOC.
- `yarn verify` passes.
- Consumer changes are tracked in a CHANGELOG entry.

**Target agent:** `dzupagent-core-dev`
**Effort:** 16-24 hours.

---

## MC-ARCH-003: Extract `core/protocol` (A2A) into `@dzupagent/a2a`

**Files moved (2,826 LOC):**
- `packages/core/src/protocol/` → `packages/a2a/src/`

**New package:** `@dzupagent/a2a`
- `package.json` declares no `@dzupagent/*` deps (or only `@dzupagent/core` for shared types).
- Subpath exports: `./adapter`, `./client`, `./push`, `./sse`.
- Layer position: tier 3 (alongside memory, security, otel).

**Why:** A2A is a self-contained inter-agent protocol with its own ARCHITECTURE.md (`packages/core/src/protocol/ARCHITECTURE.md`). It has 7 files in core/protocol and is consumed from a small number of places (`server`, `agent-adapters`).

**Change:**
1. Create `packages/a2a/` with the standard package skeleton.
2. Move `core/protocol/*` to `a2a/src/`.
3. Move the ARCHITECTURE.md.
4. Update all consumers: `grep -rn "from '@dzupagent/core/protocol\|protocol/" packages` (be careful — some matches are for path-internal imports).
5. Replace consumer imports with `@dzupagent/a2a`.
6. Remove from `packages/core/src/index.ts` if listed there.
7. Add to `tsconfig` references if the project uses them.

**Validation:**
- `find packages/core/src/protocol -name '*.ts'` returns 0 matches.
- `find packages/a2a/src -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1` ≈ 2,800 LOC.
- All A2A tests in core pass after relocation to `packages/a2a/src/__tests__/`.
- `yarn verify` passes.

**Target agent:** `dzupagent-core-dev`
**Effort:** 12-20 hours.

---

## MC-ARCH-004: Extract `core/mcp` into `@dzupagent/mcp`

**Files moved (3,010 LOC):**
- `packages/core/src/mcp/` → `packages/mcp/src/`

**New package:** `@dzupagent/mcp`
- Subpath exports: `./client`, `./manager`, `./registry`, `./resources`, `./reliability`.
- Layer: tier 3.
- Peer-dep: `@modelcontextprotocol/sdk`.

**Why:** MCP integration is an optional capability that not every consumer needs. Core ships MCP client, manager, connection-pool, registry, and reliability code — 3,010 LOC and an SDK peer-dep — that's deadweight for consumers using only the LLM/event/tool surface.

**Change:**
1. Create `packages/mcp/`.
2. Move `core/mcp/*`.
3. Move the peer-dep declaration from `core/package.json` to `mcp/package.json`.
4. Update consumers: search for `@dzupagent/core/mcp` and root-barrel MCP imports; replace with `@dzupagent/mcp`.
5. Remove MCP exports from `packages/core/src/index.ts`.

**Validation:**
- `find packages/core/src/mcp -name '*.ts'` returns 0 matches.
- `find packages/mcp/src -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1` ≈ 3,000 LOC.
- A consumer that doesn't use MCP no longer pulls `@modelcontextprotocol/sdk` transitively.
- `yarn verify` passes.

**Target agent:** `dzupagent-core-dev`
**Effort:** 12-20 hours.

---

## MC-ARCH-005: Extract `core/identity` and consolidate with security perimeter

**Files moved (2,196 LOC):**
- `packages/core/src/identity/` → `packages/identity/src/` (new package) OR merge into `@dzupagent/security` post MC-ARCH-002.

**Decision point:** evaluate whether identity (API keys, delegation, trust scoring) is a peer-domain to security or its own thing. Recommendation: separate `@dzupagent/identity`. Reasoning: identity is invoked at request entry (auth), security is invoked at output (sanitization). Different timing, different consumers.

**New package:** `@dzupagent/identity`
- Subpaths: `./api-key`, `./delegation`, `./trust`, `./signing`.
- Layer: tier 3.

**Why:** Trust scoring, delegation management, API-key resolution, identity schemas — none of these belong in the foundation core. They're security-perimeter concerns.

**Change:**
1. Create `packages/identity/`.
2. Move all 17 identity files.
3. Update consumers: every package that authenticates a request or scopes by identity (`server`, `agent`, `agent-adapters`).
4. Remove identity exports from core root barrel.

**Validation:**
- `find packages/core/src/identity -name '*.ts'` returns 0 matches.
- `find packages/identity/src -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1` ≈ 2,200 LOC.
- `yarn verify` passes.

**Target agent:** `dzupagent-core-dev`
**Effort:** 10-16 hours.

---

## MC-ARCH-006: Extract `core/skills` into `@dzupagent/skills`

**Files moved (~2,000 LOC of 2,334; keep contracts in core):**
- `packages/core/src/skills/loader.ts`, `injector.ts`, `manager.ts`, `skill-chain.ts`, `skill-model-v2.ts`, etc. → `packages/skills/src/`
- Keep type contracts (`SkillResolutionContext`, etc.) in `core` or move to `@dzupagent/runtime-contracts`.

**Why:** Skills are a high-level orchestration concept. Core defines the contract; the implementation belongs above core.

**Change:**
1. Decide split: contracts stay in core, classes move to skills package.
2. Create `packages/skills/`.
3. Move implementation files.
4. Update consumers: `agent`, `codegen`, `agent-adapters`.
5. Remove from `packages/core/src/index.ts`.

**Validation:**
- `find packages/core/src/skills -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1` ≤ 500 LOC (contract types only).
- `find packages/skills/src -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1` ≥ 1,800 LOC.
- `yarn verify` passes.

**Target agent:** `dzupagent-core-dev`
**Effort:** 10-16 hours.

---

## MC-ARCH-007: Consolidate or document the `flow-ast` / `flow-dsl` / `flow-compiler` triple

**Decision required.** Two paths:

### Option A: keep separate, document
Add an ADR (`docs/dzupagent/adr/ADR-0006-flow-package-split.md`) explaining:
- Why three packages (independent versioning, leaf-runtime size, CLI tooling consumes only AST).
- Which consumer uses which subset.
- When the rule should be revisited.

**Effort:** 0-4 hours.

### Option B: merge into `@dzupagent/flow` with subpath exports
- New package `@dzupagent/flow`.
- Subpath exports: `./ast`, `./dsl`, `./compiler`.
- Migrate 31 source files (8,718 LOC).
- Update `agent`, `server`, `evals`, `app-tools` to use the new package.

**Why:** Three packages for a tightly-coupled compilation pipeline is overhead. The combined surface is mid-sized and likely to remain so.

**Validation (Option B):**
- `flow-ast`, `flow-dsl`, `flow-compiler` removed from `packages/`.
- `@dzupagent/flow/ast`, `@dzupagent/flow/dsl`, `@dzupagent/flow/compiler` resolve.
- Tests still pass.

**Target agent:** `dzupagent-codegen-dev`
**Effort:** 0-4h (Option A) or 16-24h (Option B).

---

## MC-ARCH-008: Consolidate the contract packages (or document them)

**Decision required.** Two paths:

### Option A: keep separate, add glossary (covered by QF-ARCH-012)

### Option B: merge into `@dzupagent/contracts`
- New package `@dzupagent/contracts` with subpath exports `./runtime`, `./agent`, `./adapter`, `./eval`.
- Migrate 30 source files (~2,200 LOC) from `runtime-contracts`, `agent-types`, `adapter-types`, `eval-contracts`.
- Keep `adapter-rules` separate (it has runtime code, not just types).
- Update every consumer: ~150 distinct files, ~250 import lines.

**Why:** Five tiny dep-less packages is a lot of `package.json`s to maintain. One umbrella package with subpath exports captures the same separation with less overhead.

**Validation (Option B):**
- The four type packages removed from `packages/`.
- `@dzupagent/contracts/runtime`, `/agent`, `/adapter`, `/eval` resolve.
- All consumers updated; `yarn verify` passes.

**Target agent:** `dzupagent-core-dev`
**Effort:** 4h (Option A) or 12-20h (Option B).

---

## MC-ARCH-009: Split top-20 god files (>600 LOC) per ARCH-007

**Scope:** Apply the patterns from R-ARCH-003, R-ARCH-004, R-ARCH-005 to the rest of the >600-LOC files. Target: no source file >700 LOC after this work, except generated barrels (which should also be ≤300 after MC-ARCH-011).

**Files to split (LOC, owning package):**
- `packages/agent-adapters/src/codex/codex-adapter.ts` (1,125)
- `packages/agent-adapters/src/claude/claude-adapter.ts` (783)
- `packages/agent-adapters/src/dzupagent/syncer.ts` (797)
- `packages/agent-adapters/src/http/adapter-http-handler.ts` (794)
- `packages/agent-adapters/src/orchestration/parallel-executor.ts` (748)
- `packages/agent-adapters/src/orchestration/contract-net.ts` (663)
- `packages/agent-adapters/src/recovery/recovery-attempt-handler.ts` (658)
- `packages/agent-adapters/src/dzupagent/importer.ts` (655)
- `packages/agent-adapters/src/guardrails/adapter-guardrails.ts` (640)
- `packages/agent-adapters/src/learning/adapter-learning-loop.ts` (702)
- `packages/agent-adapters/src/testing/ab-test-runner.ts` (732)
- `packages/agent-adapters/src/normalize.ts` (601)
- `packages/agent/src/agent/dzip-agent.ts` (942)
- `packages/agent/src/orchestration/delegating-supervisor.ts` (847)
- `packages/agent/src/orchestration/planning-agent.ts` (684)
- `packages/agent/src/agent/run-engine.ts` (641)
- `packages/agent/src/agent/streaming-run.ts` (629)
- `packages/agent/src/recovery/recovery-copilot.ts` (679)
- `packages/agent/src/self-correction/output-refinement.ts` (630)
- `packages/agent/src/workflow/workflow-builder.ts` (966)
- `packages/server/src/runtime/run-worker-stages.ts` (798)
- `packages/server/src/cli/doctor.ts` (715)
- `packages/server/src/routes/compile.ts` (782)
- `packages/server/src/routes/learning.ts` (663)
- `packages/memory/src/sharing/memory-space-manager.ts` (950)
- `packages/memory/src/retrieval/adaptive-retriever.ts` (752)
- `packages/memory/src/convention/convention-extractor.ts` (748)
- `packages/memory-ipc/src/columnar-ops.ts` (659)
- `packages/evals/src/orchestrator/eval-orchestrator.ts` (765)
- `packages/evals/src/benchmarks/suites/self-correction.ts` (733)
- `packages/evals/src/prompt-experiment/prompt-experiment.ts` (659)
- `packages/codegen/src/repomap/tree-sitter-extractor.ts` (648)
- `packages/otel/src/event-metric-map/empty-events.ts` (629)
- `packages/core/src/vectordb/adapters/lancedb-adapter.ts` (616) — moves out per MC-ARCH-001
- `packages/core/src/registry/in-memory-registry.ts` (604)
- `packages/rag/src/providers/qdrant.ts` (594)

**Patterns to apply:**
- Per-node-kind / per-event-kind dispatch → split per kind (R-ARCH-004 pattern).
- Multi-stage executor → extract per-stage modules (R-ARCH-005 pattern).
- Multi-handler routes → per-handler files (R-ARCH-003 pattern).
- Adapter classes >700 LOC → split into transport, normalization, capability-detection, error-mapping modules.

**Validation:**
- `find packages -name '*.ts' -not -name '*.test.ts' -exec wc -l {} + | sort -rn | head -10` shows the top entry below 700 (excluding barrels).
- `yarn verify` passes per package.

**Target agent:** distribute by package — `dzupagent-agent-dev` for agent/agent-adapters, `dzupagent-core-dev` for core/server/memory, `dzupagent-codegen-dev` for codegen/evals.
**Effort:** 60-100 hours total. Plan as a sustained refactoring sprint, not one PR.

---

## MC-ARCH-010: Extend architecture enforcement with cycles and dependency completeness (ARCH-022)

**Already covered by R-ARCH-008.** Listed here because its impact is sprint-scale: once fully enforced in CI, it prevents regression of every other architectural fix in this audit. This is an extension of existing boundary/domain checks, not a from-scratch package-boundary CI implementation.

Once R-ARCH-008 lands and turns red against the current codebase, the remaining quick fixes and refactors above become required maintenance to get CI green. Sequence: implement gate (16-24h) → fix existing violations (covered by other prompts) → enable gate in CI (1h).

---

## Sequencing recommendation

Prioritized order (each item depends on items above it):

1. **Quick fixes** — ship in week 1.
   - QF-ARCH-001 (layering rule update)
   - QF-ARCH-002 (madge gate, allowlisting current cycles)
   - QF-ARCH-007 through QF-ARCH-011 (break easy 2-file cycles)
   - QF-ARCH-003, QF-ARCH-005, QF-ARCH-006, QF-ARCH-014
2. **Cycle elimination** — week 2.
   - R-ARCH-001 (remaining cycles)
   - R-ARCH-002 (server composition)
3. **Layering enforcement** — week 3.
   - R-ARCH-006 (apply layering rule)
   - R-ARCH-007 (resolve agent-adapters → agent violation)
   - R-ARCH-008 (master check script) → CI gate flips on
4. **Surface contraction** — weeks 4-5.
   - R-ARCH-011 (shrink core/agent barrels)
   - R-ARCH-009 (event-types split)
5. **Package extractions** — weeks 6-10.
   - MC-ARCH-001, MC-ARCH-002 (vector-DB and security extractions)
   - MC-ARCH-003, MC-ARCH-004, MC-ARCH-005 (a2a, mcp, identity)
   - MC-ARCH-006 (skills)
6. **God-file split** — ongoing, weeks 6-12.
   - MC-ARCH-009 (per-package, distributed)
7. **Strategic decisions** — week 6 (parallel).
   - MC-ARCH-007 (flow consolidation: decide A vs B)
   - MC-ARCH-008 (contracts consolidation: decide A vs B)
