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
MEM-P001 through MEM-P006 are available only from
`@dzupagent/memory/records`, `@dzupagent/memory/lifecycle`,
`@dzupagent/memory/service`, `@dzupagent/memory/retrieval`, and
`@dzupagent/memory/workers`; they do not widen the compatibility root.
Physical projections remain a later packet with separate acceptance.

## Canonical record contract

Use the records subpath for the provider-neutral `datazup.memory.record/v1`
envelope:

```typescript
import {
  canonicalizeMemoryRecordV1,
  decodeMemoryRecordV1,
  digestMemoryRecordV1,
  type MemoryRecordV1,
} from '@dzupagent/memory/records'

const record: MemoryRecordV1 = decodeMemoryRecordV1(untrustedInput)
const canonicalJson = canonicalizeMemoryRecordV1(record)
const envelopeDigest = digestMemoryRecordV1(record)
```

Decoding rejects unknown fields and versions, invalid time order, unsafe object
shapes, accessors, cycles, non-finite numbers, and bounded-value overruns. It
also checks inline content against `contentDigest`. Results are detached and
deeply frozen. Restricted or oversized content must use a bounded content
reference. The record carries policy and consent references only; it never
grants execution authority.

`adaptMemoryRecordToV1` and `adaptStagedRecordToV1` preserve legacy payloads,
but require the caller to provide canonical scope, lifecycle, provenance,
governance, quality, and observation inputs that the legacy records do not
contain. No adapter supplies a clock, retention duration, consent, or policy
default.

## Pure lifecycle contract

Use the lifecycle subpath for deterministic, provider-neutral transitions:

```typescript
import {
  projectMemoryVersionChainV1,
  reduceMemoryCommandV1,
  type MemoryCommandV1,
  type MemoryLifecycleStateV1,
} from '@dzupagent/memory/lifecycle'

declare const state: MemoryLifecycleStateV1 | undefined
declare const command: MemoryCommandV1

const result = reduceMemoryCommandV1(state, command)
const chain = projectMemoryVersionChainV1(result.state.events)
```

Commands supply every identifier, transition time, sequence, generation,
actor, decision, reason, evidence reference, and record precondition. The
reducer uses no I/O, clock, randomness, provider, product policy, or hidden
mutable registry. Exact command replays return the original digest-bound
receipt; conflicting idempotency reuse, sequence gap/reorder, stale generation,
stale record, illegal transition, time reversal, and unknown reason fail
closed.

Lifecycle state and events retain metadata and digests, not memory content.
Corrections emit a new version and a superseded prior-record update, while the
version-chain projection preserves competing correction branches admitted in
one globally ordered sequence. The state's version, status, digest, and
retrieval flag describe only the last transitioned version; use the projection
for chain-wide active versions and conflicts. Disputed versions remain visible
as unresolved history but are excluded from normal active retrieval; a future
policy-aware query may inspect them explicitly. Revocation removes retrieval
eligibility immediately. A purge command produces only a
bounded target proposal and minimal non-content tombstone; it never claims
physical deletion or a final `purged` state. Archive and purge effects remain
host-owned and require separately supplied evidence.

Reducer state retains at most 32 command/event/receipt entries. The host must
checkpoint durable events and receipts before that bound and begin a separately
admitted generation. The opt-in lifecycle service below provides that bounded
custody; the pure reducer itself neither rolls generations nor provides
indefinite idempotency storage.

## Opt-in lifecycle service

Use the service subpath when a host needs structural scope isolation, atomic
append/CAS, durable replay, checkpointed generation rollover, or explicit
cache/index invalidation outcomes:

```typescript
import {
  InMemoryMemoryLifecycleAdapter,
  MemoryLifecycleService,
} from '@dzupagent/memory/service'

const adapter = new InMemoryMemoryLifecycleAdapter()
const lifecycle = new MemoryLifecycleService(adapter)

declare const scopedCommand: Parameters<typeof lifecycle.remember>[0]
const result = await lifecycle.remember(scopedCommand)
```

`remember`, `correct`, `forget`, and `revoke` require caller-supplied canonical
commands; they never infer consent, retention, promotion, policy, or authority.
`queryLifecycle` returns active records by default, while disputed and full
history access are explicit. `explain` is content-free and reports only bounded
lifecycle, evidence-reference, checkpoint, and capability facts.

The reference adapter is deterministic and provider-free. It retains records,
events, receipts, checkpoints, and purge-proposal tombstones in separately
bounded logical collections, but it is not a production persistence adapter.
Its delete, purge, and index-invalidation capabilities are false. Hosts may
inject `MemoryInvalidationPort`; logical revocation remains successful when a
physical effect is partial, unsupported, or retryable, and the result preserves
both truths. Existing root `MemoryService` CRUD behavior is unchanged.

## Lifecycle-aware retrieval

Use the retrieval subpath for strict scope and temporal filtering, canonical
lifecycle resolution, deterministic lexical/vector fusion, trust and freshness
weighting, diversity limits, and a truthful token budget:

```typescript
import {
  retrieveMemoryV1,
  type MemoryRetrievalProfileV1,
  type MemoryRetrieverPort,
} from '@dzupagent/memory/retrieval'

declare const retriever: MemoryRetrieverPort
declare const profile: MemoryRetrievalProfileV1

const result = await retrieveMemoryV1({
  query: {
    schema: 'datazup.memory.query/v1',
    scope: { tenantId: 'tenant-1', namespace: 'lessons' },
    text: 'What changed in API-204 on 2026-08-11?',
    asOf: '2026-08-11T12:00:00.000Z',
  },
  profile,
  retriever,
})
```

The retriever port returns candidates and resolves every selected candidate
against current canonical lifecycle state. Normal retrieval excludes disputed,
superseded, forgotten, revoked, archived, expired, future, wrong-scope, and
stale-version records. Explicit history mode widens lifecycle visibility but
never scope or as-of time. Optional query-rewriter and reranker failures are
reported as degradation; required stages return a retryable result. Selection
explanations contain bounded identifiers and scores, never memory content.

Every rewrite, candidate, lifecycle-resolution, and rerank invocation receives
an abort signal and is enclosed by the profile's hard `stageDeadlineMs` bound,
including when an adapter ignores cancellation. An externally routed rewrite
or rerank must declare an `externalProviderPolicy`: a reference-only route,
non-retention, query-text admission, and the exact sensitivity classes allowed
inline. Ineligible content fails closed before the external port is invoked.

## Background consolidation and reliable delivery

Use the workers subpath to retain reference-only extraction or consolidation
intent behind a host-controlled scheduler, policy, budget, and provider route:

```typescript
import {
  createInMemoryMemoryOutbox,
  type MemoryConsolidationPort,
} from '@dzupagent/memory/workers'

const outbox = createInMemoryMemoryOutbox()
declare const preparedEnvelopeInput: unknown
declare const claimInput: unknown
declare const runInput: unknown
declare const port: MemoryConsolidationPort

const envelope = outbox.prepare(preparedEnvelopeInput)
outbox.enqueue(envelope)
const claim = outbox.claim(claimInput)
if (claim.status === 'claimed') await outbox.runClaimed(runInput, port)
```

The adapter is inert: it owns no clock, timer, scheduler, provider, network,
filesystem, canonical memory write, or production authority. Every persisted
time is caller supplied. Source and candidate values are references and
digests, not memory content. Outputs always require candidate review and state
that canonical promotion was not performed.

Claims and renewals are generation-fenced, execution is single-flight, and
current admission is rechecked before each execute or reconcile call. Finite
retry schedules use explicit reason allowlists. A timeout, thrown port, expired
execution lease, malformed result, or unknown cost becomes ambiguous and
cannot be retried until reconciliation proves the effect was not applied.
Terminal outcomes retain a content-free dead letter. Exported state and
checkpoints are digest-bound and bounded for host-owned persistence.

Port results report cumulative provider cost for the envelope, not merely the
latest call. The adapter rejects a decreasing total or a total above the job
ceiling. If an invoked stage cannot report a trustworthy total, its outcome
records unknown cost; a later terminal dead letter preserves that uncertainty.

This surface wraps the role of existing `ConsolidationEngine`,
`SemanticConsolidator`, `SleepConsolidator`, and dual-stream/staged writers; it
does not replace or automatically invoke them. In particular,
`SleepConsolidationConfig` is not an admission, delivery, or authority contract.
Hosts must adapt legacy engines behind `MemoryConsolidationPort` and keep their
scheduling and promotion behavior separately admitted.

## Provider-free conformance

`@dzupagent/memory/testing` exposes the versioned `MemoryBenchmarkProfileV1`
and reusable record, lifecycle, store, retrieval, compaction, deletion, and
worker suite creators. The repository baseline uses only invented fixtures, an
injected clock, a fixed seed and tokenizer identity, explicit pre-observation
thresholds, and locally simulated ports:

```bash
yarn docs:memory-conformance
yarn check:memory-conformance
```

The generated JSON and Markdown are source-bound provider-free evidence. They
do not qualify a live provider, credential, application integration,
deployment, or production enablement. Compaction transcripts remain owned by
the context package and are passed through a content-free adapter.

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
