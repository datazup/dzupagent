# `src/snapshot` Architecture

## Scope
This document covers only `packages/agent/src/snapshot`.

In scope:
- `agent-snapshot.ts`
- `serialized-message.ts`
- Public export wiring in `packages/agent/src/index.ts`
- Snapshot/message tests under `packages/agent/src/__tests__`

Out of scope:
- Legacy serializer internals in `src/agent/agent-state.ts` (except compatibility notes)
- Replay internals under `src/replay/*`

## Responsibilities
The snapshot module provides two concrete utility surfaces:
- Snapshot creation, integrity verification, and transport compression via `agent-snapshot.ts`.
- Message normalization/migration across mixed wire formats via `serialized-message.ts`.

Specifically, it:
- Produces `AgentStateSnapshot` objects with generated `schemaVersion`, `createdAt`, and SHA-256 `contentHash`.
- Verifies tamper evidence by recomputing hash over semantic fields.
- Compresses/decompresses snapshot `messages` using `gzip` plus base64 encoding.
- Normalizes heterogeneous message inputs (plain objects, LangChain message objects, primitive inputs) into one `SerializedMessage` shape.
- Normalizes role aliases and tool-call formats from multiple provider conventions.

## Structure
Directory files:
- `agent-snapshot.ts`
- `serialized-message.ts`
- `ARCHITECTURE.md`

`agent-snapshot.ts` internals:
- `AgentStateSnapshot`
- `CreateSnapshotParams`
- `computeHash(...)` (internal)
- `createSnapshot(...)`
- `verifySnapshot(...)`
- `compressSnapshot(...)`
- `decompressSnapshot(...)`

`serialized-message.ts` internals:
- `MultimodalContent`
- `SerializedMessage`
- `LegacyMessage` (internal helper type)
- `normalizeRole(...)` (internal)
- `normalizeContent(...)` (internal)
- `extractToolCalls(...)` (internal)
- `serializeMessage(...)`
- `migrateMessages(...)`

## Runtime and Control Flow
Snapshot path:
1. `createSnapshot(params)` computes `contentHash` from a deterministic object containing agent identity, messages, optional state fields, and `compressed`.
2. It returns a snapshot with fixed `schemaVersion: '1.0.0'` and `createdAt` set to `new Date().toISOString()`.
3. `verifySnapshot(snapshot)` recomputes the same hash input and compares to `snapshot.contentHash`.

Compression path:
1. `compressSnapshot(snapshot)` returns early when `snapshot.compressed` is already true.
2. Otherwise it serializes `snapshot.messages` to JSON, applies `gzipSync`, encodes base64, and stores it as `messages: [base64]`.
3. It sets `compressed: true`, recomputes `contentHash`, and keeps original `createdAt`.

Decompression path:
1. `decompressSnapshot(snapshot)` returns unchanged when `compressed` is falsy.
2. For compressed input, it expects `messages[0]` to be a base64 string; otherwise it throws.
3. It gunzips and parses the message array, clears `compressed`, recomputes hash, and preserves `createdAt`.

Message normalization path:
1. `serializeMessage(msg)` handles `null`/`undefined`, primitives, LangChain-like objects with `_getType`, and plain objects.
2. Roles are normalized (`human -> user`, `ai -> assistant`, `function -> tool`; unknown defaults to `user`).
3. Content is normalized to string or multimodal blocks (`text`, `image`, OpenAI `image_url` mapping).
4. Tool calls are normalized from `toolCalls` and `tool_calls` variants, with fallback IDs (`call_<idx>`) and argument parsing fallback (`{ raw: <string> }` on invalid JSON).
5. `migrateMessages(old)` maps an array through `serializeMessage`.

## Key APIs and Types
Snapshot APIs:
- `createSnapshot(params: CreateSnapshotParams): AgentStateSnapshot`
- `verifySnapshot(snapshot: AgentStateSnapshot): boolean`
- `compressSnapshot(snapshot: AgentStateSnapshot): AgentStateSnapshot & { compressed: true }`
- `decompressSnapshot(snapshot: AgentStateSnapshot): AgentStateSnapshot`

Snapshot types:
- `AgentStateSnapshot`
- `CreateSnapshotParams`

Message APIs:
- `serializeMessage(msg: unknown): SerializedMessage`
- `migrateMessages(old: unknown[]): SerializedMessage[]`

Message types:
- `SerializedMessage`
- `MultimodalContent`

Wire-shape constraints in current code:
- `schemaVersion` is a literal `'1.0.0'`.
- Snapshot `messages` are typed as `unknown[]`.
- Compressed snapshots store `messages` as a single base64 entry.
- `SerializedMessage.content` is `string | MultimodalContent[]`.

## Dependencies
Direct runtime imports inside this module:
- `node:crypto` (`createHash`)
- `node:zlib` (`gzipSync`, `gunzipSync`)

No local package modules are imported by `src/snapshot/*`.

Package dependency context (`packages/agent/package.json`):
- Module code itself uses only Node built-ins.
- Compatibility is designed for peer ecosystem types (`@langchain/core`) and schema tooling (`zod`) consumed elsewhere in the package.

## Integration Points
Public API integration:
- Re-exported from `packages/agent/src/index.ts` as:
- Enhanced snapshot exports (`createSnapshot`, `verifySnapshot`, `compressSnapshot`, `decompressSnapshot`, `AgentStateSnapshot`, `CreateSnapshotParams`)
- Enhanced message exports (`serializeMessage`, `migrateMessages`, `SerializedMessage`, `MultimodalContent`)

Compatibility integration:
- `src/index.ts` also exports legacy `serializeMessages`/`deserializeMessages` and legacy snapshot/message types from `src/agent/agent-state.ts`.
- This keeps both legacy and enhanced serialization contracts available to consumers.

Current in-repo usage:
- No runtime imports of `src/snapshot/*` from other production modules were found.
- Primary active consumers in this repo are the snapshot/serialization test suites.

## Testing and Observability
Snapshot-focused test files:
- `src/__tests__/agent-snapshot.test.ts`
- `src/__tests__/agent-snapshot-extended.test.ts`
- `src/__tests__/serialized-message.test.ts`
- `src/__tests__/serialized-message-deep.test.ts`
- `src/__tests__/serialized-message-branches.test.ts`

Current coverage themes from these tests:
- Hash generation and tamper detection across all hashed fields (`agentId`, `agentName`, `messages`, `budgetState`, `config`, `toolNames`, `workingMemory`, `metadata`).
- Compression/decompression round-trips for empty histories, large histories, multimodal content, and tool-call-heavy transcripts.
- Idempotency of `compressSnapshot` and of repeated serialization/migration.
- Role/content normalization branches, OpenAI/LangChain/new-style tool-call parsing, fallback IDs, and invalid JSON argument fallback behavior.
- Passthrough behavior for unknown/future message fields during snapshot round-trip.

Observability:
- No direct logging/metrics/event-bus emission is implemented in `src/snapshot/*`.
- Integrity visibility is provided by `verifySnapshot(...)` return value and decompress-time thrown errors for invalid compressed message format.

## Risks and TODOs
Current risks:
- Hashes provide tamper evidence but not authenticated provenance (no signing/identity binding).
- `schemaVersion` is fixed to `'1.0.0'` and there is no built-in migration dispatcher.
- Hash stability depends on deterministic `JSON.stringify` output over provided objects.
- `messages: unknown[]` allows persistence of unvalidated payload shapes.
- Compression/decompression is synchronous and can become expensive on very large payloads.
- OpenAI `image_url` blocks without a string `url` are currently dropped during normalization.

Potential TODOs aligned with current implementation:
- Add explicit schema-version migration helpers when version evolution is needed.
- Add optional signature support for authenticity guarantees.
- Add async compression/decompression alternatives for latency-sensitive paths.
- Decide long-term direction for enhanced vs legacy serializer exports and deprecation policy.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

