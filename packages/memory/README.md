# @dzupagent/memory

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Beta | **Coverage:** 88% | **Exports:** 195

| Metric | Value |
|--------|-------|
| Source Files | 76 |
| Lines of Code | 29,532 |
| Test Files | 37 |
| Internal Dependencies | `@dzupagent/memory-ipc` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @dzupagent/memory
```
<!-- AUTO-GENERATED-END -->

Reusable memory management for LLM agents built on LangGraph Store.

## Features

- **MemoryService** -- Namespace-scoped put/get/search with non-fatal error handling
- **WorkingMemory** -- Zod-validated persistent state across sessions
- **Decay Engine** -- Ebbinghaus forgetting curve with spaced-repetition reinforcement
- **Consolidation** -- 4-phase dedup/prune cycle (orient, gather, consolidate, prune)
- **Memory Healer** -- Jaccard duplicate detection, contradiction finder, staleness detection
- **Sanitization** -- Prompt injection, exfiltration, and invisible Unicode detection
- **Write Policies** -- PII/secret rejection, decision confirmation, composable policies
- **Staged Writer** -- 3-stage capture/promote/confirm workflow with auto-thresholds
- **Frozen Snapshots** -- Freeze memory at session start for prompt cache optimization
- **Observation Extractor** -- LLM-based fact extraction from conversations
- **Governed Observational Memory** -- Optional candidate-first staging and explicit confirmation before model-written observations become durable
- **Retrieval** -- Vector search, TF-IDF full-text search, entity graph traversal, RRF fusion

## Install

```bash
npm install @dzupagent/memory
# peer deps
npm install @langchain/core @langchain/langgraph zod
```

## Quick Start

```typescript
import { createStore, MemoryService } from '@dzupagent/memory'

const store = await createStore({ type: 'memory' })
const memory = new MemoryService(store, [
  { name: 'lessons', scopeKeys: ['tenantId', 'lessons'], searchable: true },
  { name: 'decisions', scopeKeys: ['projectId', 'decisions'] },
])

// Write
await memory.put('lessons', { tenantId: 't1' }, 'lesson-1', {
  text: 'Always validate input at API boundaries',
})

// Read
const records = await memory.get('lessons', { tenantId: 't1' })

// Search (semantic, requires embedding config on store)
const results = await memory.search('lessons', { tenantId: 't1' }, 'validation', 5)

// Format for prompt injection
const context = memory.formatForPrompt(records, { header: '## Lessons Learned' })
```

## Candidate-First Observational Memory

Use candidate-first mode when a model extracts possible long-term memories from
short-term conversation context:

```typescript
const memory = new MemoryService(store, [
  {
    name: 'observations',
    scopeKeys: ['tenantId', 'workspaceId'],
    searchable: true,
  },
  {
    name: 'observation-candidates',
    scopeKeys: ['tenantId', 'workspaceId'],
    searchable: false,
  },
])
const candidateStore = new MemoryServiceObservationCandidateStore(
  memory,
  'observation-candidates',
)

const observations = new ObservationalMemory({
  model: cheapModel,
  memoryService: memory,
  store,
  namespace: 'observations',
  scope: { tenantId: 't1', workspaceId: 'w1' },
  observationWriteMode: 'candidate-first',
  candidateStore,
  observerAgentUri: 'forge://acme/memory-observer',
})

await observations.observe(messages)

// This asynchronous form restores candidates after a process restart.
const pending = await observations.listPendingObservationCandidates()
await observations.confirmObservation(pending[0].key)
```

Candidate-first mode rejects unsafe records through the default write policy,
does not trust model confidence as confirmation, and persists confirmed
observations with derived provenance. The separate candidate namespace stores
restart-safe lifecycle state and idempotent confirmation receipts; rejected and
stale candidates are pruned by the configured retention policy. Direct mode
remains the backwards-compatible default.

## Store Backends

- **PostgresStore** -- Production, via `@langchain/langgraph-checkpoint-postgres`
- **InMemoryBaseStore** -- Development/testing, no database required

```typescript
// Production
const store = await createStore({
  type: 'postgres',
  connectionString: process.env.DATABASE_URL,
})

// Development
const store = await createStore({ type: 'memory' })
```

## Peer Dependencies

| Package | Version |
|---------|---------|
| `@langchain/core` | >= 1.0.0 |
| `@langchain/langgraph` | >= 1.0.0 |
| `zod` | >= 4.0.0 |
