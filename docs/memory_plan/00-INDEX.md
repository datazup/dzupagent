# Memory & Context Management — Master Plan Index

> **Created:** 2026-03-22
> **Status:** Planning
> **Scope:** Cross-session memory, multi-tech-stack generation, RAG-aware context management, conversation lifecycle

---

## Problem Statement

StarterForge generates features (UI + backend + DB code files), combines features into templates, and templates into projects. The platform must support **generating the same feature description against different tech stacks** (Vue -> React, Express -> FastAPI, Prisma -> TypeORM, etc.) while maintaining consistent quality and learning from every generation.

**Current gaps:**
1. Memory is siloed per thread — no cross-session, cross-feature, or cross-project learning
2. No "feature description" abstraction separate from "feature implementation" — the description IS tied to the tech stack
3. RAG retrieval only searches within a single tech stack — cannot find equivalent features across stacks
4. Conversation history grows unbounded within complex pipelines
5. No memory consolidation — lessons accumulate without deduplication or quality filtering
6. Framework adaptation is file-by-file LLM calls with no structural memory
7. No project-level "convention memory" that persists across feature generations

---

## Plan Documents

| # | Document | Agent | Priority | Description |
|---|----------|-------|----------|-------------|
| **01** | [Architecture Overview](./01-ARCHITECTURE.md) | system-architect | P0 | Three-tier memory model, data flow diagrams, namespace design |
| **02** | [Feature Abstraction Layer](./02-FEATURE-ABSTRACTION.md) | system-architect | P0 | Separating feature descriptions from tech-stack implementations |
| **03** | [LangGraph Store Integration](./03-STORE-INTEGRATION.md) | langchain-ts-expert | P0 | PostgresStore enhancement, semantic search, embedding configuration |
| **04** | [Conversation Management](./04-CONVERSATION-MANAGEMENT.md) | langchain-ts-expert | P0 | Message trimming, summarization, context compaction |
| **05** | [Multi-Tech-Stack Generation](./05-MULTI-TECH-STACK.md) | system-architect | P1 | Same description -> different implementations, adaptation pipeline |
| **06** | [RAG & Cross-Stack Retrieval](./06-RAG-CROSS-STACK.md) | langchain-ts-expert | P1 | Cross-framework reference retrieval, embedding strategy |
| **07** | [Prompt Management](./07-PROMPT-MANAGEMENT.md) | system-architect | P1 | Tech-stack-aware prompts, template variables, caching |
| **08** | [Memory Consolidation](./08-MEMORY-CONSOLIDATION.md) | system-architect | P2 | Lesson dedup, convention extraction, periodic quality review |
| **09** | [Cross-Intent Context](./09-CROSS-INTENT-CONTEXT.md) | langchain-ts-expert | P2 | Context transfer between generate -> edit -> configure flows |
| **10** | [Implementation Roadmap](./10-ROADMAP.md) | system-architect | — | Sprint breakdown, dependency graph, effort estimates |
| **11** | [Expert Findings Addendum](./11-EXPERT-FINDINGS-ADDENDUM.md) | experts | CRITICAL | 5 bugs, 5 prompt gaps, 5 architecture issues from deep reviews |

---

## Current Implementation Status

### Extracted Packages (2026-03-24)

The memory and context primitives have been extracted into standalone, reusable packages. See [FORGEAGENT_REFACTOR.md](/docs/FORGEAGENT_REFACTOR.md) for the full extraction rationale.

| Package | Responsibility | Key Exports |
|---------|---------------|-------------|
| **`@dzipagent/memory`** | Memory service, decay, consolidation, healer, sanitization, write policies, staged writer, working memory, frozen snapshots, observation extractor, retrieval (vector, FTS, graph, RRF fusion), store factory | `MemoryService`, `WorkingMemory`, `StagedWriter`, `ObservationExtractor`, `FrozenMemorySnapshot`, `fusionSearch`, `createStore` |
| **`@dzipagent/context`** | Message compression, auto-compress pipeline, context eviction, system reminders, completeness scorer, Anthropic prompt cache | `autoCompress`, `summarizeAndTrim`, `SystemReminderInjector`, `evictIfNeeded`, `applyCacheBreakpoints` |
| **`@dzipagent/core`** | Re-exports all of the above + orchestration foundation (model registry, events, plugins, subagents, skills, MCP, security) | Everything from memory + context + own modules |

### What Exists (Working)

| Component | Status | Package / File |
|-----------|--------|---------------|
| MemoryService (namespace-scoped put/get/search) | Implemented | `@dzipagent/memory` |
| WorkingMemory (Zod-validated state) | Implemented | `@dzipagent/memory` |
| Decay engine (Ebbinghaus forgetting curve) | Implemented | `@dzipagent/memory` |
| Memory consolidation (4-phase dedup/prune) | Implemented | `@dzipagent/memory` |
| Memory healer (Jaccard dedup, contradiction finder) | Implemented | `@dzipagent/memory` |
| Sanitization (injection/exfiltration/Unicode) | Implemented | `@dzipagent/memory` |
| Write policies (PII/secret reject, decision confirm) | Implemented | `@dzipagent/memory` |
| Staged writer (capture/promote/confirm) | Implemented | `@dzipagent/memory` |
| Frozen snapshots (prompt cache optimization) | Implemented | `@dzipagent/memory` |
| Observation extractor (LLM fact extraction) | Implemented | `@dzipagent/memory` |
| Retrieval: vector, FTS, graph, RRF fusion | Implemented | `@dzipagent/memory` |
| Store factory (Postgres + InMemory) | Implemented | `@dzipagent/memory` |
| Message manager (summarize/trim/prune) | Implemented | `@dzipagent/context` |
| Auto-compress pipeline | Implemented | `@dzipagent/context` |
| Context eviction (head/tail truncation) | Implemented | `@dzipagent/context` |
| System reminder injector | Implemented | `@dzipagent/context` |
| Completeness scorer | Implemented | `@dzipagent/context` |
| Anthropic prompt cache breakpoints | Implemented | `@dzipagent/context` |
| Prompt template engine | Implemented | `@dzipagent/core` |
| Cost-aware LLM router | Implemented | `@dzipagent/core` |
| Model registry with circuit breaker | Implemented | `@dzipagent/core` |

### What's Missing (This Plan)

| Component | Priority | Effort |
|-----------|----------|--------|
| Feature abstraction (desc vs impl) | P0 | 8h |
| Store semantic search with embeddings | P0 | 4h |
| Cross-stack RAG retrieval | P1 | 6h |
| Multi-tech-stack generation pipeline | P1 | 12h |
| Convention memory (auto-extract) | P1 | 4h |
| Cross-intent context transfer | P2 | 4h |
| Prompt adaptation per tech stack | P1 | 4h |
| `interrupt()` native plan approval | P2 | 2h |

---

## Key Architectural Decisions

1. **LangGraph Store over custom tables**: Use PostgresStore for all memory tiers — it handles schema, indexing, and semantic search natively
2. **Feature Description as first-class entity**: Separate `FeatureSpec` (abstract) from `FeatureImplementation` (tech-stack-specific)
3. **Namespace hierarchy**: `[tenantId, scope, type]` — consistent across all memory operations
4. **Non-blocking memory**: All store operations are fire-and-forget with graceful degradation
5. **Embedding-based retrieval**: Use store's built-in embedding index for semantic search across lessons, conventions, and cross-stack references
6. **Extracted packages**: Memory and context primitives live in `@dzipagent/memory` and `@dzipagent/context` — independently publishable, reusable across projects. `@dzipagent/core` re-exports everything for backward compatibility
