# 01 — Memory Architecture Overview

> **Agent:** system-architect
> **Priority:** P0
> **Depends on:** None

---

## 1. Three-Tier Memory Model

The memory system operates across three scopes with increasing persistence and breadth:

```
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 3: TENANT MEMORY (cross-project, cross-user)                 │
│  Scope: Everything a tenant has ever generated                     │
│  TTL: Permanent until pruned                                       │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  - Generation lessons (errors + fixes + strategies)           │ │
│  │  - Coding conventions (naming, error format, import style)    │ │
│  │  - Error pattern database (recurring issues + solutions)      │ │
│  │  - Feature catalog (all generated features across projects)   │ │
│  │  - Prompt effectiveness scores (which prompts work best)      │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  TIER 2: PROJECT MEMORY (cross-session, cross-feature)             │
│  Scope: All features generated for a specific project              │
│  TTL: Permanent while project exists                               │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  - Architecture decisions (API patterns, DB conventions)      │ │
│  │  - Feature index (what's been generated, dependencies)        │ │
│  │  - API conventions (base paths, auth patterns, error format)  │ │
│  │  - Shared type registry (types used across features)          │ │
│  │  - Session summaries (per-feature generation history)         │ │
│  │  - Tech stack configuration (per-project stack choices)       │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  TIER 1: THREAD MEMORY (single session)                            │
│  Scope: One feature generation run                                 │
│  TTL: Session lifetime (LangGraph checkpoint)                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  - Conversation history (messages, trimmed + summarized)      │ │
│  │  - VFS state (generated files in virtual filesystem)          │ │
│  │  - Feature plan (file list, dependencies, strategies)         │ │
│  │  - Test results, validation scores                            │ │
│  │  - Current phase, fix attempts, tool call counts              │ │
│  │  - API contract (extracted from backend for frontend use)     │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  TIER 0: USER MEMORY (cross-project, per-user)                     │
│  Scope: Individual user preferences and defaults                   │
│  TTL: Permanent while user exists                                  │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  - Tech stack preferences (preferred frameworks)              │ │
│  │  - Clarification defaults (answers per category)              │ │
│  │  - Code style preferences (naming, formatting)                │ │
│  │  - Generation history (features generated, satisfaction)      │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## 2. Data Flow Architecture

### 2.1 Memory Write Flow (Post-Generation)

```
publish() node completes
  │
  ├─▶ storeProjectDecision()         → [projectId, "decisions"]
  │     Extract: apiEndpoints, databaseModels, npmPackages
  │
  ├─▶ storeGenerationLesson()        → [tenantId, "lessons"]
  │     Condition: fixAttempts > 0 (learned from errors)
  │     Extract: errorTypes, fixStrategy, category
  │
  ├─▶ storeUserDefaults()            → [userId, "generation-defaults"]
  │     Extract: clarificationAnswers per category
  │
  ├─▶ storeSessionSummary()          → [projectId, "session-summaries"]
  │     Extract: feature name, quality, file count
  │
  ├─▶ storeApiConventions()          → [projectId, "conventions"]
  │     Extract: endpoint patterns, auth patterns
  │
  ├─▶ [NEW] storeFeatureSpec()       → [tenantId, "feature-specs"]
  │     Extract: abstract description, category, requirements
  │     Purpose: Enable cross-stack feature retrieval
  │
  ├─▶ [NEW] storeSharedTypes()       → [projectId, "shared-types"]
  │     Extract: type definitions used across features
  │     Purpose: Ensure type consistency
  │
  └─▶ [NEW] storeConventionUpdate()  → [projectId, "conventions-auto"]
        Extract: naming patterns, import patterns from generated code
        Purpose: Auto-learn project conventions
```

### 2.2 Memory Read Flow (Pre-Generation)

```
Graph invocation starts
  │
  ├─▶ loadPromptCache()                 ← PromptTemplate table (5min TTL)
  │     Scope: All active prompts for tenant/user
  │
  ├─▶ [intake node]
  │     ├─▶ No memory reads (first contact)
  │     └─▶ Create Feature DB record
  │
  ├─▶ [clarify node]
  │     ├─▶ loadUserDefaults()           ← [userId, "generation-defaults"]
  │     │     Purpose: Pre-fill clarification questions
  │     │
  │     └─▶ [NEW] loadProjectConventions() ← [projectId, "conventions"]
  │           Purpose: Frame questions around existing project patterns
  │
  ├─▶ [plan node]
  │     ├─▶ loadProjectContext()          ← [projectId, "decisions"]
  │     │     Purpose: Know what features already exist
  │     │
  │     ├─▶ loadRelevantLessons()         ← [tenantId, "lessons"]
  │     │     Purpose: Avoid repeating past mistakes
  │     │
  │     ├─▶ loadApiConventions()          ← [projectId, "conventions"]
  │     │     Purpose: Follow established API patterns
  │     │
  │     ├─▶ ragRetrievalService.find()    ← Qdrant/Feature DB
  │     │     Purpose: Find similar features as reference
  │     │
  │     └─▶ [NEW] loadSharedTypes()       ← [projectId, "shared-types"]
  │           Purpose: Reuse existing types, avoid duplicates
  │
  ├─▶ [generate_* nodes]
  │     ├─▶ [NEW] loadConventions()       ← [projectId, "conventions-auto"]
  │     │     Purpose: Follow auto-learned naming/import patterns
  │     │
  │     └─▶ buildReferenceCodeExamples()  ← State (from plan node RAG)
  │           Purpose: Use similar features as patterns
  │
  └─▶ [fix node]
        └─▶ [NEW] loadRelevantLessons()   ← [tenantId, "lessons"]
              Purpose: Apply known fix strategies for similar errors
```

### 2.3 Cross-Graph Context Flow

```
                  ┌──────────────────────┐
                  │   Router Service     │
                  │ (intent classification)│
                  └──────┬───────────────┘
                         │
           ┌─────────────┼──────────────┐
           │             │              │
    ┌──────▼──────┐ ┌───▼────────┐ ┌──▼──────────────┐
    │ Configurator│ │  Feature   │ │  Template        │
    │    Graph    │ │ Generator  │ │  Builder Graph   │
    │             │ │   Graph    │ │                  │
    └──────┬──────┘ └───┬────────┘ └──┬──────────────┘
           │            │             │
           │    ┌───────▼──────┐     │
           │    │  Feature     │     │
           │    │ Editor Graph │     │
           │    └───────┬──────┘     │
           │            │             │
           └────────────┼─────────────┘
                        │
              ┌─────────▼──────────┐
              │  LangGraph Store   │
              │  (Shared Memory)   │
              │                    │
              │  Namespaces:       │
              │  [tenant/lessons]  │
              │  [project/decisions]│
              │  [user/defaults]   │
              │  [project/sessions]│
              └────────────────────┘
```

**Key insight:** All graphs write to and read from the same LangGraph Store. This enables cross-intent context transfer WITHOUT custom wiring between graphs.

## 3. Namespace Design

### 3.1 Complete Namespace Registry

```
TENANT-SCOPED (shared across all projects for a tenant):
  [tenantId, "lessons"]                    → Generation lessons with semantic search
  [tenantId, "error-patterns"]             → Recurring error patterns + proven fixes
  [tenantId, "conventions"]                → Tenant-wide coding standards
  [tenantId, "feature-specs"]              → [NEW] Abstract feature descriptions
  [tenantId, "prompt-effectiveness"]       → [NEW] Prompt version → quality correlation

PROJECT-SCOPED (shared across features in a project):
  [projectId, "decisions"]                 → Architecture decisions per feature
  [projectId, "conventions"]               → Manually set + extracted conventions
  [projectId, "conventions-auto"]          → [NEW] Auto-learned from generated code
  [projectId, "generated-features"]        → Feature index with quality + outcomes
  [projectId, "shared-types"]              → [NEW] Shared TS types across features
  [projectId, "session-summaries"]         → Past session summaries
  [projectId, "tech-stack"]               → [NEW] Project's tech stack config

USER-SCOPED (personal preferences):
  [userId, "profile"]                      → Tech stack preferences
  [userId, "generation-defaults"]          → Clarification defaults per category
  [userId, "style-preferences"]            → [NEW] Code style preferences
  [userId, "generation-history"]           → [NEW] Past generations + satisfaction

FEATURE-SCOPED (per-feature implementation details):
  [featureDbId, "implementations"]         → [NEW] Tech-stack-specific implementations
  [featureDbId, "adaptation-log"]          → [NEW] Cross-stack adaptation history
```

### 3.2 Key Pattern: Write with `index` for Semantic Search

```typescript
// Items that need semantic retrieval MUST include index configuration
await store.put(
  [tenantId, "lessons"],
  `lesson-${Date.now()}`,
  { text: "...", category: "...", ... },
  { index: ["text"] }  // ← Required for store.search() to work
)
```

**Current gap:** The `storeGenerationLesson()` in the app-level `memory-service.ts` does NOT pass `{ index: ["text"] }`. This means `loadRelevantLessons()` uses `store.search()` with a query, but the items were never indexed. **This is a bug that must be fixed.**

> **Note (2026-03-24):** The generic `MemoryService` in `@dzipagent/memory` now auto-enriches searchable namespaces with a `text` field if missing (see `memory-service.ts:87`). App-level code should define namespaces with `searchable: true` to benefit from this.

### 3.3 Embedding Configuration

```typescript
// Store should be initialized with embedding config for semantic search
const store = PostgresStore.fromConnString(env.DATABASE_URL, {
  index: {
    embeddings: new AnthropicEmbeddings({ model: 'voyager-3' }),
    dims: 1024,
    fields: ['text'],
  }
})
```

**Current state:** `store.ts` initializes without embedding configuration. This means `store.search()` falls back to keyword matching only.

## 4. Implementation Tasks

### 4.1 Fix Existing Bugs (Immediate)

| Task | File | Issue |
|------|------|-------|
| Add `{ index: ["text"] }` to lesson writes | App-level `memory-service.ts` (mitigated: `@dzipagent/memory` auto-enriches searchable namespaces) | Semantic search won't work |
| Add embedding config to store init | App-level `store.ts` (use `@dzipagent/memory`'s `createStore`) | Search uses keyword-only fallback |
| Add `{ index: ["text"] }` to convention writes | App-level `memory-service.ts` (mitigated: `@dzipagent/memory` auto-enriches searchable namespaces) | Convention search broken |

### 4.2 New Capabilities (This Plan)

| Task | Document | Priority |
|------|----------|----------|
| Feature abstraction layer | `02-FEATURE-ABSTRACTION.md` | P0 |
| Store embedding configuration | `03-STORE-INTEGRATION.md` | P0 |
| Conversation compaction enhancement | `04-CONVERSATION-MANAGEMENT.md` | P0 |
| Multi-stack generation pipeline | `05-MULTI-TECH-STACK.md` | P1 |
| Cross-stack RAG retrieval | `06-RAG-CROSS-STACK.md` | P1 |
| Prompt tech-stack adaptation | `07-PROMPT-MANAGEMENT.md` | P1 |
| Memory consolidation | `08-MEMORY-CONSOLIDATION.md` | P2 |
| Cross-intent context | `09-CROSS-INTENT-CONTEXT.md` | P2 |

## 5. Expert Agent Assignment

Each document in this plan specifies which expert agent should execute it:

| Agent | Responsibilities |
|-------|-----------------|
| `system-architect` | Data model design, namespace schema, cross-component integration |
| `langchain-ts-expert` | LangGraph Store API, embedding config, graph compilation changes |
| `backend-api-dev` | Service implementations, API endpoints, Prisma migrations |
| `database-architect` | Schema changes, index design, migration scripts |
| `vue3-component-dev` | Frontend components for memory visualization (optional) |
