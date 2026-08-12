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

## Memory Contract Baseline

MEM-P000 freezes the current memory/context/IPC/agent-loader surface and the
accepted compatibility decisions before versioned lifecycle exports are added.
The generated report lives at
`docs/generated/MEMORY_API_CENSUS.v1.md`; refresh it with
`yarn docs:memory-api-census` and verify drift with
`yarn check:memory-api-census` from the DzupAgent repository root.

The current root API remains compatible during the 0.x migration window.
Canonical records, lifecycle, service, retrieval, workers, and deterministic
projections live on separately gated narrow subpaths and do not widen the root
barrel.

## Deterministic Projections

`@dzupagent/memory/projections` derives bounded structured, canonical JSON,
injection-safe Markdown, and semantic diffs from exact canonical record,
lifecycle-event, and receipt inputs. Every request binds scope, record/history
digests, lifecycle generation/sequence, redaction policy, caller-supplied time,
and hard output limits. Restricted, non-exportable, excluded, or oversized
content is reference-only.

Projection outputs are immutable and state `authority: none`. They preserve
supersession, dispute, revocation, governance, provenance, receipt, and
incomplete-purge truth; they do not write files, invoke Git, mutate lifecycle,
or grant permission. Filesystem/Git adapters and product controls remain
MEM-P007-B work under separate authority and host admission.

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
  observationRunId: runId,
  observationMessageReferenceResolver: message => message.id,
  onObservationLifecycleEvent: event => {
    auditSink.record(event)
  },
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

The default `observation-extraction/v3` contract requires every extracted
observation to cite at least one supplied message label. The extractor resolves
only valid labels into stable `evidenceReferences`, using the host message ID
when available and a deterministic role/content digest otherwise. Each
reference includes the optional run ID, a complete-content SHA-256 digest, and
a bounded review excerpt. Uncited or invented references are discarded, and
candidate confirmation validates evidence again. Semantic consolidation unions
the source references of merged or duplicate observations.

Custom `observationPrompt` values must preserve the same `evidenceRefs`
requirement and supplied message-label convention. A custom response without
valid evidence references is rejected rather than persisted.

`onObservationLifecycleEvent` is a narrow, non-fatal host adapter. It emits
captured, promoted, confirmed, rejected, restored, retention-pruned, and
persistence-failed events with scope, candidate key, stage, and reference IDs;
it does not expose the observation value or source excerpt. Product-owned
approval UI should consume this adapter rather than being added to the memory
package.

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
