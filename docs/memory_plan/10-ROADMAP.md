# 10 — Implementation Roadmap

> **Priority:** Reference document
> **Total estimated effort:** ~64h across 5 sprints (M0-M4)
> **Updated:** 2026-03-22 (incorporated expert review findings from doc 11)

---

## 1. Sprint Breakdown

### Sprint M0: Critical Fixes (BLOCKING) — ~8h

**Goal:** Fix production-level bugs that block all memory and multi-stack work.

| # | Task | File(s) | Agent | Effort | Depends On |
|---|------|---------|-------|--------|------------|
| M0-01 | Wire Store to all 5 graphs (BUG-01) | All graph build functions | langchain-ts-expert | 1h | — |
| M0-02 | Add LLM retry + fallback (BUG-02) | `llm.ts` | langchain-ts-expert | 2h | — |
| M0-03 | Fix PrismaClient singletons (BUG-03) | `rag-retrieval.service.ts`, others | backend-api-dev | 30m | — |
| M0-04 | Add undeclared vars to STANDARD_VARIABLES (PROMPT-02) | `template-engine.ts` | backend-api-dev | 1h | — |
| M0-05 | Inject memory context into all generation nodes (PROMPT-04) | `feature-generator.graph.ts` | langchain-ts-expert | 2h | M0-01 |
| M0-06 | Add per-node cost tracking (ARCH-03) | `feature-generator.graph.ts`, `cost-tracking.service.ts` | backend-api-dev | 1.5h | — |

**Acceptance gate:**
- `getStore()` returns non-null in ALL graph nodes (not just feature-generator)
- LLM calls survive 1-2 transient failures via retry
- No `new PrismaClient()` calls outside `lib/prisma.ts`
- `validateTemplateContent()` passes for all seed templates
- All generation nodes receive project conventions + lessons from memory
- Cost tracked for every LLM call (visible in Langfuse)

**See:** [11-EXPERT-FINDINGS-ADDENDUM.md](./11-EXPERT-FINDINGS-ADDENDUM.md) for detailed rationale.

---

### Sprint M1: Foundation (P0) — ~16h

**Goal:** Enable semantic search, improve conversation management.

> **Note (2026-03-24):** Tasks M1-02 through M1-05 are now handled by `@dzipagent/memory` (auto text enrichment for searchable namespaces) and `@dzipagent/context` (multi-phase compression pipeline with structured summarization). Remaining work is app-level integration.

| # | Task | File(s) | Agent | Effort | Depends On |
|---|------|---------|-------|--------|------------|
| M1-01 | Add embedding config to PostgresStore | App-level `store.ts` (use `@dzipagent/memory`'s `createStore`) | langchain-ts-expert | 2h | — |
| M1-02 | ~~Fix missing `{ index: ["text"] }`~~ | ~~`memory-service.ts`~~ | — | DONE | `@dzipagent/memory` auto-enriches |
| M1-03 | ~~Add `text` field to all searchable items~~ | ~~`memory-service.ts`~~ | — | DONE | `@dzipagent/memory` auto-enriches |
| M1-04 | ~~Implement phase-aware message windowing~~ | ~~`message-manager.ts`~~ | — | DONE | `@dzipagent/context` (tool pruning + boundary alignment) |
| M1-05 | ~~Implement structured summarization~~ | ~~`message-manager.ts`~~ | — | DONE | `@dzipagent/context` (goal/progress/decisions template) |
| M1-06 | Add `buildNodeMessages()` and apply to all 12 nodes | `feature-generator.graph.ts` | langchain-ts-expert | 3h | M1-04, M1-05 |
| M1-07 | Add `structuredSummary` state field | `feature-generator.state.ts` | langchain-ts-expert | 0.5h | M1-05 |
| M1-08 | Phase-specific summary formatting (`formatSummaryForPhase`) | App-level extension of `@dzipagent/context` | langchain-ts-expert | 1h | M1-05 |
| M1-09 | Integration testing: verify semantic search works end-to-end | Tests | langchain-ts-expert | 2h | M1-01 |
| M1-10 | Integration testing: verify conversation management | Tests | langchain-ts-expert | 1h | M1-06..08 |

**Acceptance gate:**
- `store.search()` with semantic query returns relevant results
- Generation nodes receive phase-appropriate message windows
- Token usage per LLM call reduced by 30%+ in later pipeline nodes

---

### Sprint M2: Feature Abstraction + Multi-Stack Prompts (P0/P1) — ~16h

**Goal:** Separate feature description from implementation, enable multi-stack prompt resolution.

| # | Task | File(s) | Agent | Effort | Depends On |
|---|------|---------|-------|--------|------------|
| M2-01 | Create `FeatureSpec` and `FeatureImplementation` Prisma models | `schema.prisma`, migration | database-architect | 2h | — |
| M2-02 | Create `feature-spec.service.ts` | `services/features/` | backend-api-dev | 3h | M2-01 |
| M2-03 | Add `techStackKey()` utility | `services/features/` | backend-api-dev | 0.5h | — |
| M2-04 | Modify `intake()` node to create FeatureSpec + FeatureImplementation | `feature-generator.graph.ts` | langchain-ts-expert | 2h | M2-01, M2-02 |
| M2-05 | Add `featureSpecId` to generator state | `feature-generator.state.ts` | langchain-ts-expert | 0.5h | — |
| M2-06 | Add `techStack` field to `PromptTemplate` model | `schema.prisma`, migration | database-architect | 1h | — |
| M2-07 | Update `resolveNodePrompt()` with techStack dimension | `feature-generator.graph.ts` | langchain-ts-expert | 2h | M2-06 |
| M2-08 | Create builtin prompts for Vue3, React, Svelte frontends | seed script | system-architect | 2h | M2-06 |
| M2-09 | Create builtin prompts for Express, Fastify, NestJS backends | seed script | system-architect | 2h | M2-06 |
| M2-10 | Create builtin prompts for Prisma, TypeORM, Drizzle ORMs | seed script | system-architect | 1h | M2-06 |

**Acceptance gate:**
- FeatureSpec + FeatureImplementation models in DB
- `intake()` creates both records
- Tech-stack-specific prompts resolve correctly
- Same featureId with different techStack creates separate implementations

---

### Sprint M3: Cross-Stack RAG + Reference Generation (P1) — ~12h

**Goal:** Enable cross-stack feature retrieval and reference-guided generation.

| # | Task | File(s) | Agent | Effort | Depends On |
|---|------|---------|-------|--------|------------|
| M3-01 | Create `cross-stack-rag.service.ts` | `services/features/` | langchain-ts-expert | 4h | M2-02 |
| M3-02 | Implement `findCrossStackReferences()` with 2-layer retrieval | `cross-stack-rag.service.ts` | langchain-ts-expert | 2h | M3-01, M1-01 |
| M3-03 | Implement `buildCrossStackPromptContext()` | `cross-stack-rag.service.ts` | langchain-ts-expert | 1h | M3-01 |
| M3-04 | Add `storeFeatureSpec()` (app-level, uses `@dzipagent/memory`) | App-level memory helpers | langchain-ts-expert | 1h | M1-01 |
| M3-05 | Integrate cross-stack RAG into `plan()` node | `feature-generator.graph.ts` | langchain-ts-expert | 1.5h | M3-01..03 |
| M3-06 | Inject per-layer reference context in generate nodes | `feature-generator.graph.ts` | langchain-ts-expert | 1.5h | M3-03 |
| M3-07 | Add RAG effectiveness tracking in `publish()` | `feature-generator.graph.ts`, app-level memory helpers | langchain-ts-expert | 1h | M3-01 |

**Acceptance gate:**
- Cross-stack search finds auth feature from Vue implementation when generating React
- Reference context is injected per-layer (backend files for backend node, etc.)
- RAG effectiveness is tracked after publish

---

### Sprint M4: Memory Consolidation + Cross-Intent (P2) — ~10h

**Goal:** Add memory quality management and cross-intent context transfer.

| # | Task | File(s) | Agent | Effort | Depends On |
|---|------|---------|-------|--------|------------|
> **Note (2026-03-24):** M4-01 through M4-03 are partially implemented in `@dzipagent/memory` (`consolidateNamespace`, `consolidateAll`, `healMemory`). Remaining work is app-level scheduling and LLM-assisted merge integration.

| # | Task | File(s) | Agent | Effort | Depends On |
|---|------|---------|-------|--------|------------|
| M4-01 | ~~Create consolidation service~~ | — | — | DONE | `@dzipagent/memory` (`consolidateNamespace`, `healMemory`) |
| M4-02 | Wire LLM-assisted merge into consolidation | App-level, uses `@dzipagent/memory` consolidation | langchain-ts-expert | 1.5h | M4-01 |
| M4-03 | ~~Implement convention consolidation~~ | — | — | DONE | `@dzipagent/memory` (`consolidateAll`) |
| M4-04 | Add consolidation trigger in `publish()` (every 25 gens) | `feature-generator.graph.ts` | langchain-ts-expert | 0.5h | M4-01 |
| M4-05 | Implement `CrossIntentSummary` write in all graphs | All graph files | langchain-ts-expert | 2h | M1-01 |
| M4-06 | Implement `loadCrossIntentContext()` | App-level memory helpers (uses `@dzipagent/memory`) | langchain-ts-expert | 1h | M4-05 |
| M4-07 | Apply `loadGraphEntryContext()` to editor + template builder | graph files | langchain-ts-expert | 1h | M4-06 |

**Acceptance gate:**
- Lessons consolidated after 25 generations (duplicates merged)
- Conventions consolidated to dominant pattern
- Feature editor loads generation context for the feature being edited
- Template builder knows what features exist

---

## 2. Dependency Graph

```
Sprint M0 (CRITICAL — blocks everything)
  M0-01 (Wire Store to all graphs) ──▶ M0-05 (Memory in gen nodes)
  M0-02 (LLM retry/fallback)       ──▶ [All subsequent sprints]
  M0-03 (Fix PrismaClient)         ──▶ [Production stability]
  M0-04 (Fix STANDARD_VARIABLES)   ──▶ M2-08..10 (Prompt seeds)
  M0-06 (Per-node cost tracking)   ──▶ [Independent]

Sprint M1 (depends on M0-01)
  M1-01 (Store embeddings)
    ├──▶ M1-02, M1-03 (Fix store.put() calls)
    │     └──▶ M1-09 (Integration test)
    ├──▶ M3-02 (Cross-stack search)
    └──▶ M4-01 (Consolidation service)

  M1-04 (Phase-aware windowing)
    ├──▶ M1-05 (Structured summarization)
    │     └──▶ M1-06 (Apply to all nodes)
    │           └──▶ M1-08 (Phase-specific formatting)
    └──▶ M1-10 (Integration test)

Sprint M2 (depends on M1, M0-04)
  M2-01 (FeatureSpec model)
    ├──▶ M2-02 (feature-spec.service)
    │     └──▶ M2-04 (intake() modification)
    │           └──▶ M3-01 (cross-stack-rag.service)
    └──▶ M2-06 (PromptTemplate techStack field)
          └──▶ M2-07 (resolveNodePrompt)
                └──▶ M2-08..10 (Prompt seeds)

Sprint M3 (depends on M2)
  M3-01..07 (Cross-stack RAG)
  + Anthropic prompt caching (PROMPT-05)
  + OpenAI model tier mapping (ARCH-04)

Sprint M4 (depends on M0-01, M1)
  M4-05 (CrossIntentSummary writes)
    └──▶ M4-06 (loadCrossIntentContext)
          └──▶ M4-07 (Apply to all graphs)
```

## 3. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Embedding API adds latency to store.put() | Medium | Async/fire-and-forget writes; batch embedding |
| Semantic search returns irrelevant results | Medium | Quality scoring + retrieval testing; tunable thresholds |
| FeatureSpec migration breaks existing features | High | Non-breaking: add optional FK, backfill later |
| Phase-aware windowing loses critical context | High | Always keep conversation summary; test with real pipelines |
| Tech-stack-specific prompts are too many to maintain | Medium | Start with 3 frontends + 3 backends; extend incrementally |
| Memory consolidation LLM calls are expensive | Low | Run infrequently (every 25 gens or daily cron); use Haiku |
| Cross-intent context injection bloats prompts | Low | Limit to 5 summaries, 500 tokens max; age-limit to 7 days |

## 4. Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Memory write latency | <200ms (including embedding) | Langfuse span timing |
| Memory read/search latency | <50ms | Langfuse span timing |
| Token reduction in generation nodes | 30%+ less than current | Compare before/after |
| Cross-stack search accuracy | >70% relevant results in top-3 | Manual evaluation |
| Consolidation job duration | <60s per tenant | BullMQ job metrics |
| Store size per tenant (1 year) | <100MB | PostgreSQL table size |

## 5. Migration Checklist

### Before Sprint M0
- [ ] Identify all graph build functions that need `store` parameter
- [ ] Identify all `new PrismaClient()` calls outside `lib/prisma.ts`
- [ ] Review `STANDARD_VARIABLES` in `template-engine.ts` vs `buildPromptContext()` output

### Before Sprint M1
- [ ] Sprint M0 completed and verified
- [ ] Verify `@langchain/langgraph-checkpoint-postgres` version supports Store embedding config
- [ ] Confirm Anthropic Voyager-3 embedding API access
- [ ] Baseline token usage per generation (for comparison)

### Before Sprint M2
- [ ] Design FeatureSpec Prisma migration
- [ ] Audit all Feature model usages that need FeatureSpec FK
- [ ] Draft builtin prompts for Vue3/React/Svelte × Express/Fastify/NestJS

### Before Sprint M3
- [ ] Generate 10+ features across 2+ tech stacks for testing
- [ ] Set up Qdrant collection for FeatureSpec embeddings (if using Qdrant alongside Store)

### Before Sprint M4
- [ ] Configure BullMQ consolidation queue
- [ ] Instrument all graphs with Langfuse spans for memory operations

## 6. Success Metrics

After full implementation:

1. **Feature generation quality improves** — Average quality score increases 5-10 points for 2nd+ features in a project (due to convention memory)
2. **Fix cycles decrease** — Average fixAttempts decreases as lessons accumulate
3. **Cross-stack generation viable** — Can generate same feature for different stack with >80% quality of fresh generation
4. **User satisfaction** — Editor/template builder aware of prior generation context
5. **Token efficiency** — 30%+ reduction in tokens per generation run
6. **Memory stays manageable** — Consolidation keeps store size bounded
