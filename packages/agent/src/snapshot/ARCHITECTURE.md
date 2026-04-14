# Snapshot Module Architecture (`src/snapshot`)

## 1) Scope and Intent

This folder contains the "enhanced snapshot" and "enhanced message serialization" utilities for `@dzupagent/agent`:

- [`agent-snapshot.ts`](./agent-snapshot.ts): tamper-evident agent state snapshots with optional message compression.
- [`serialized-message.ts`](./serialized-message.ts): provider-agnostic message normalization + migration.

Design intent:

- Portable state for checkpointing/debug/audit.
- Backward/interop support for mixed message formats (LangChain/OpenAI/legacy/plain).
- Minimal runtime dependencies (`node:crypto`, `node:zlib` only in snapshot hashing/compression path).

---

## 2) Public API Surface

Exported via [`packages/agent/src/index.ts`](../index.ts):

- Snapshot API:
  - `createSnapshot(params)`
  - `verifySnapshot(snapshot)`
  - `compressSnapshot(snapshot)`
  - `decompressSnapshot(snapshot)`
  - `AgentStateSnapshot`
  - `CreateSnapshotParams`
- Message API:
  - `serializeMessage(msg)`
  - `migrateMessages(msgs)`
  - `SerializedMessage`
  - `MultimodalContent`

Implementation references:

- Snapshot exports: [`../index.ts:155`](../index.ts#L155)
- Message exports: [`../index.ts:167`](../index.ts#L167)

---

## 3) Data Contracts

### 3.1 `AgentStateSnapshot` contract

Defined in [`agent-snapshot.ts:13`](./agent-snapshot.ts#L13).

Key fields:

- `schemaVersion: '1.0.0'` (fixed literal)
- `agentId`, `agentName`
- `messages: unknown[]`
- Optional run state: `budgetState`, `config`, `toolNames`, `workingMemory`, `metadata`
- Integrity + metadata: `contentHash`, `createdAt`
- Storage marker: `compressed?: boolean`

Important detail:

- Hash input excludes `contentHash` and `createdAt`, but includes `compressed` and all semantic fields ([`agent-snapshot.ts:53`](./agent-snapshot.ts#L53)).

### 3.2 `SerializedMessage` contract

Defined in [`serialized-message.ts:21`](./serialized-message.ts#L21).

Key fields:

- `role`: `'system' | 'user' | 'assistant' | 'tool'`
- `content`: `string | MultimodalContent[]`
- Optional:
  - `toolCalls[]` with `{ id, name, arguments }`
  - `toolCallId`
  - `metadata`

`MultimodalContent` currently supports:

- text block: `{ type: 'text'; text: string }`
- image block: `{ type: 'image'; url: string; mimeType?: string }`

---

## 4) Feature Analysis

## 4.1 Snapshot Integrity and Tamper Detection

Core flow:

1. `createSnapshot` computes SHA-256 hash over deterministic JSON ([`agent-snapshot.ts:71`](./agent-snapshot.ts#L71)).
2. It sets `schemaVersion: '1.0.0'` and `createdAt = new Date().toISOString()`.
3. `verifySnapshot` recomputes hash from payload and compares to `contentHash` ([`agent-snapshot.ts:87`](./agent-snapshot.ts#L87)).

What this guarantees:

- Detects mutation of hashed fields (`messages`, `agentId`, etc.).

What it does not guarantee:

- No signature/authentication (integrity only, not author identity).
- No replay prevention metadata.

### 4.2 Snapshot Compression / Decompression

`compressSnapshot` behavior ([`agent-snapshot.ts:108`](./agent-snapshot.ts#L108)):

- Idempotent on already compressed snapshot (`compressed === true` returns same object).
- Serializes `messages` JSON, gzips, base64-encodes.
- Replaces `messages` with single-element array: `[base64String]`.
- Sets `compressed: true`.
- Recomputes `contentHash`.
- Preserves original `createdAt`.

`decompressSnapshot` behavior ([`agent-snapshot.ts:144`](./agent-snapshot.ts#L144)):

- If not compressed: returns snapshot unchanged.
- Expects `messages[0]` to be a base64 string; throws if not string.
- Gunzip + parse into original `messages` array.
- Returns new uncompressed snapshot with recomputed hash.
- Preserves original `createdAt`.

### 4.3 Message Normalization and Migration

`serializeMessage` unifies multiple input shapes into `SerializedMessage` ([`serialized-message.ts:182`](./serialized-message.ts#L182)):

- Null/undefined -> `{ role: 'user', content: '' }`
- LangChain-style (`_getType`) objects
- Plain objects (OpenAI/legacy/mixed)
- String/primitive fallback

Normalization helpers:

- Role normalization (`human -> user`, `ai -> assistant`, `function -> tool`) ([`serialized-message.ts:59`](./serialized-message.ts#L59)).
- Content normalization:
  - strings pass through
  - arrays normalized to multimodal blocks
  - OpenAI `image_url` block mapped to internal `image`
  - unknown blocks/stringifiable values downgraded to text blocks ([`serialized-message.ts:80`](./serialized-message.ts#L80))
- Tool-call extraction:
  - supports `toolCalls` and OpenAI `tool_calls`
  - arguments accepted as object or parsed from JSON string
  - parse failures become `{ raw: <string> }` ([`serialized-message.ts:132`](./serialized-message.ts#L132))

Batch migration:

- `migrateMessages(old)` is a map over `serializeMessage` ([`serialized-message.ts:261`](./serialized-message.ts#L261)).

---

## 5) End-to-End Flow

### 5.1 Snapshot flow (runtime/persistence)

1. Build a normalized message list (optional: with `serializeMessage`/`migrateMessages`).
2. Call `createSnapshot` with runtime state.
3. Optionally call `compressSnapshot` before storing/transferring.
4. On load, call `verifySnapshot`.
5. If compressed, call `decompressSnapshot` before runtime rehydration/inspection.

### 5.2 Message migration flow

1. Receive old or heterogeneous message payloads.
2. Run `migrateMessages` once at boundary.
3. Downstream logic uses only `SerializedMessage` contract.

---

## 6) Usage Examples

### 6.1 Create + verify + compress

```ts
import {
  createSnapshot,
  verifySnapshot,
  compressSnapshot,
  decompressSnapshot,
} from '@dzupagent/agent'

const snapshot = createSnapshot({
  agentId: 'agent-42',
  agentName: 'SupportAgent',
  messages: [{ role: 'user', content: 'Summarize ticket #123' }],
  budgetState: { tokensUsed: 1800, costCents: 12, iterations: 4 },
  toolNames: ['search', 'read_file'],
  metadata: { runId: 'run-abc' },
})

if (!verifySnapshot(snapshot)) throw new Error('Integrity check failed')

const stored = compressSnapshot(snapshot)
// persist `stored`...

const loaded = decompressSnapshot(stored)
if (!verifySnapshot(loaded)) throw new Error('Snapshot tampered in transit')
```

### 6.2 Normalize mixed message formats

```ts
import { migrateMessages } from '@dzupagent/agent'

const mixed = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'human', content: 'Find docs for this API.' }, // legacy role
  {
    role: 'assistant',
    content: 'Calling tool...',
    tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"api docs"}' } }],
  },
  { role: 'tool', content: 'results...', tool_call_id: 'c1' },
  {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'https://example.com/screenshot.png' } }],
  },
]

const normalized = migrateMessages(mixed)
```

### 6.3 LangChain-style message support

```ts
import { serializeMessage } from '@dzupagent/agent'

const langChainLike = {
  _getType: () => 'ai',
  content: 'I will inspect the repo.',
  tool_calls: [{ id: 'tc_1', name: 'read_file', args: { path: 'README.md' } }],
}

const msg = serializeMessage(langChainLike)
// msg.role === 'assistant'
// msg.toolCalls?.[0].arguments.path === 'README.md'
```

---

## 7) Primary Use Cases

- **Checkpoint portability**: persist minimal agent state across storage/process boundaries.
- **Audit trails**: detect post-capture mutations via `contentHash`.
- **Transmission/storage optimization**: compress large message history while preserving verification semantics.
- **Interop migration**: normalize legacy/LangChain/OpenAI message formats into one contract before further processing.
- **Multimodal conversation archival**: represent text + image inputs in a provider-agnostic envelope.

---

## 8) References in Other Packages and Usage

Repository snapshot date for this analysis: **April 4, 2026**.

Observed references:

- Public re-export in `@dzupagent/agent` entrypoint:
  - [`packages/agent/src/index.ts:155`](../index.ts#L155)
  - [`packages/agent/src/index.ts:167`](../index.ts#L167)
- Public API mention in package README:
  - [`packages/agent/README.md:120`](../../README.md#L120)
- Direct implementation usage currently found only in local tests:
  - [`packages/agent/src/__tests__/agent-snapshot.test.ts`](../__tests__/agent-snapshot.test.ts)
  - [`packages/agent/src/__tests__/serialized-message.test.ts`](../__tests__/serialized-message.test.ts)

Not found (via repository-wide symbol search):

- No direct imports of `createSnapshot`, `verifySnapshot`, `compressSnapshot`, `decompressSnapshot`, `serializeMessage`, or `migrateMessages` from other workspace packages at this time.

Interpretation:

- This module is currently a **published utility surface** with local validation and external availability, but no in-repo downstream runtime adoption yet outside `@dzupagent/agent` tests/docs.

---

## 9) Test Coverage and Validation

Executed commands:

- `yarn workspace @dzupagent/agent test src/__tests__/agent-snapshot.test.ts src/__tests__/serialized-message.test.ts`
  - Result: **2 files passed, 22 tests passed**
- `yarn workspace @dzupagent/agent test:coverage -- src/__tests__/agent-snapshot.test.ts src/__tests__/serialized-message.test.ts --coverage.include=src/snapshot/*.ts --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 --coverage.thresholds.statements=0 --coverage.thresholds.branches=0 --coverage.reporter=text --coverage.reporter=json`
  - Result (scoped to snapshot files):
    - Statements: **93.82%**
    - Branches: **69.86%**
    - Functions: **100%**
    - Lines: **93.82%**

Per-file:

- `agent-snapshot.ts`
  - Stmts/Lines: **98.85%**
  - Branches: **90.9%**
  - Uncovered statements: lines **151-152** (error path for invalid compressed message format).
- `serialized-message.ts`
  - Stmts/Lines: **90.49%**
  - Branches: **66.12%**
  - Uncovered statements include fallback/error-normalization branches (e.g. defaults/fallback mappings and metadata branches): lines
    **73, 91-92, 113-117, 121, 123-127, 151, 153, 159-160, 162-163, 219-220, 223-224, 248-249**.

### 9.1 Covered behavior matrix

- Snapshot creation: schema/hash/timestamp generation.
- Hash verification:
  - valid snapshot success
  - tampered messages failure
  - tampered `agentId` failure
- Compression lifecycle:
  - compress/decompress round-trip
  - idempotent compress
  - decompress no-op for uncompressed input
  - `createdAt` preservation across transformations
- Message serialization:
  - standard roles + tool calls
  - OpenAI `tool_calls`
  - new-style `toolCalls`
  - tool message `tool_call_id`
  - multimodal blocks + OpenAI `image_url`
  - role alias normalization (`human`, `ai`, `function`)
  - LangChain-style `_getType`
  - null/undefined/string inputs
- Message migration:
  - mixed legacy arrays
  - empty arrays
  - serialized-message round-trip stability

### 9.2 Notable residual gaps

- Explicit tests for `decompressSnapshot` invalid payload exception (`messages[0]` non-string).
- Additional branch tests for lesser-used fallbacks in `serialized-message.ts`, especially:
  - unknown roles defaulting to `user`
  - non-string/non-object content coercion paths
  - malformed JSON tool argument fallback to `{ raw: ... }`
  - metadata population via legacy `name` fields in all paths.

---

## 10) Compatibility Notes

- `schemaVersion` is fixed at `'1.0.0'`; there is no version negotiation/migration logic yet.
- This module co-exists with legacy state serialization in [`../agent/agent-state.ts`](../agent/agent-state.ts) (older role/content model), and can be treated as the richer forward-facing format.

