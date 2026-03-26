# @forgeagent/memory

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Beta | **Coverage:** 88% | **Exports:** 195

| Metric | Value |
|--------|-------|
| Source Files | 76 |
| Lines of Code | 29,532 |
| Test Files | 37 |
| Internal Dependencies | `@forgeagent/memory-ipc` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @forgeagent/memory
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
- **Retrieval** -- Vector search, TF-IDF full-text search, entity graph traversal, RRF fusion

## Install

```bash
npm install @forgeagent/memory
# peer deps
npm install @langchain/core @langchain/langgraph zod
```

## Quick Start

```typescript
import { createStore, MemoryService } from '@forgeagent/memory'

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
