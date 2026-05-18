# `src/snapshot` Architecture

## Scope
This document describes the snapshot subsystem in `packages/agent/src/snapshot` and its direct package-level integration.

In scope:
- `src/snapshot/agent-snapshot.ts`
- `src/snapshot/serialized-message.ts`
- root export wiring in `src/index.ts`
- related package documentation in `packages/agent/README.md` and `packages/agent/docs/api-tiers.md`
- snapshot/serialization tests in `src/__tests__`

Out of scope:
- legacy serializer internals in `src/agent/agent-state.ts` (except where relevant for migration boundaries)
- replay internals in `src/replay/*`
- run-state persistence in `@dzupagent/core` stores

## Responsibilities
The snapshot subsystem provides two utility surfaces:

- Snapshot lifecycle utilities (`createSnapshot`, `verifySnapshot`, `compressSnapshot`, `decompressSnapshot`) for portable agent state capture.
- Message normalization utilities (`serializeMessage`, `migrateMessages`) for converting mixed message wire formats into one package-defined shape.

Current responsibilities implemented in code:
- Build snapshots with fixed `schemaVersion: '1.0.0'`, generated `createdAt`, and SHA-256 `contentHash`.
- Recompute hashes for tamper-evidence checks.
- Gzip+base64 compress snapshot `messages` payloads into a single encoded entry.
- Normalize roles/content/tool-calls across plain object input, OpenAI-style payloads, and LangChain-style messages (`_getType`).
- Preserve optional snapshot fields while avoiding explicit `undefined` fields in verify/compress/decompress hash inputs via `omitUndefined(...)`.

## Structure
Files in this folder:
- `agent-snapshot.ts`
- `serialized-message.ts`
- `ARCHITECTURE.md`

`agent-snapshot.ts`:
- `AgentStateSnapshot` interface
- `CreateSnapshotParams` type
- internal `computeHash(params)`
- `createSnapshot(params)`
- `verifySnapshot(snapshot)`
- `compressSnapshot(snapshot)`
- `decompressSnapshot(snapshot)`

`serialized-message.ts`:
- `MultimodalContent` type
- `SerializedMessage` interface
- internal `LegacyMessage` helper interface
- internal `normalizeRole(role)`
- internal `normalizeContent(content)`
- internal `extractToolCalls(msg)`
- `serializeMessage(msg)`
- `migrateMessages(old)`

## Runtime and Control Flow
Snapshot creation:
1. `createSnapshot(params)` computes `contentHash` from semantic fields (`agentId`, `agentName`, `messages`, optional state fields, and `compressed`).
2. It returns an object with `schemaVersion: '1.0.0'`, spread params, computed hash, and current ISO timestamp.

Verification:
1. `verifySnapshot(snapshot)` rebuilds hash input from the snapshot fields.
2. It runs that input through `omitUndefined(...)` before hashing.
3. It compares the computed hash with `snapshot.contentHash` and returns boolean.

Compression:
1. `compressSnapshot(snapshot)` returns the input unchanged when `snapshot.compressed` is already truthy.
2. Otherwise, it `JSON.stringify`s `messages`, gzips the bytes, and base64-encodes the result.
3. It writes compressed data as `messages: [base64]`, sets `compressed: true`, recomputes hash, and preserves `createdAt`.

Decompression:
1. `decompressSnapshot(snapshot)` returns early if `compressed` is falsy.
2. It requires `messages[0]` to be a base64 string; otherwise it throws a format error.
3. It gunzips, parses JSON back into `unknown[]`, removes `compressed`, recomputes hash, and preserves `createdAt`.

Message normalization:
1. `serializeMessage(msg)` handles `null`/`undefined`, primitives, LangChain-like objects with `_getType`, and plain objects.
2. `normalizeRole` maps aliases (`human` -> `user`, `ai` -> `assistant`, `function` -> `tool`) and defaults unknown roles to `user`.
3. `normalizeContent` returns either a string or multimodal blocks:
4. string input remains string
5. array input is normalized into `{ type: 'text' | 'image', ... }` blocks
6. OpenAI `{ type: 'image_url', image_url: { url } }` is converted to `{ type: 'image', url }` when `url` is a string
7. unsupported typed blocks are stringified into text blocks
8. `extractToolCalls` prefers `toolCalls` over `tool_calls`, normalizes IDs/names/arguments, and parses JSON argument strings with raw-string fallback on parse failure.
9. `migrateMessages(old)` is a direct `old.map(serializeMessage)`.

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

Current wire-shape constraints:
- `schemaVersion` is currently a literal `'1.0.0'`.
- `AgentStateSnapshot.messages` is `unknown[]` and can contain arbitrary message payloads.
- compressed snapshots encode messages as a single base64 string entry inside `messages`.
- `SerializedMessage.content` is `string | MultimodalContent[]`.
- tool-call arguments are normalized to `Record<string, unknown>`.

## Dependencies
Direct imports in this subsystem:
- `node:crypto` (`createHash`)
- `node:zlib` (`gzipSync`, `gunzipSync`)
- local shim `../utils/exact-optional.js` (`omitUndefined`)

The local shim re-exports from `@dzupagent/core/utils`, so hash input normalization in this module depends on the core utility behavior.

Package context (`packages/agent/package.json`):
- no dedicated package export subpath for `snapshot`; the API is exposed through root exports in `src/index.ts`.
- package peer dependencies include `@langchain/core`, `@langchain/langgraph`, and `zod`; snapshot code itself does not import those directly, but message normalization is designed to accept LangChain-style message objects.

## Integration Points
Public API exposure:
- `src/index.ts` re-exports enhanced snapshot APIs and types from `src/snapshot/agent-snapshot.ts`.
- `src/index.ts` re-exports enhanced message APIs and types from `src/snapshot/serialized-message.ts`.

Compatibility boundary:
- root exports also include legacy `serializeMessages` / `deserializeMessages` and legacy state types from `src/agent/agent-state.ts`.
- `src/compat.ts` continues to export only legacy serialization/state types and does not re-export the enhanced snapshot APIs.

Package documentation alignment:
- `packages/agent/README.md` documents snapshot/serialization under "Snapshot & Serialization".
- `packages/agent/docs/api-tiers.md` classifies the enhanced snapshot/message APIs as `advanced` tier and legacy serializers as `internal`.

In-repo usage:
- direct production-runtime imports of `src/snapshot/*` inside `packages/agent/src` are not present.
- primary usage in this package is through dedicated tests and root-facade export contract.

## Testing and Observability
Snapshot/serialization test files:
- `src/__tests__/agent-snapshot.test.ts`
- `src/__tests__/agent-snapshot-extended.test.ts`
- `src/__tests__/serialized-message.test.ts`
- `src/__tests__/serialized-message-deep.test.ts`
- `src/__tests__/serialized-message-branches.test.ts`

Covered behaviors in current tests:
- snapshot metadata generation (`schemaVersion`, hash format, timestamp).
- tamper detection for each hashed field (`agentId`, `agentName`, `messages`, `budgetState`, `config`, `toolNames`, `workingMemory`, `metadata`).
- compress/decompress round-trips for empty, large, multimodal, and tool-call-heavy histories.
- idempotency expectations for repeated compression and repeated migration/serialization.
- role/content normalization across primitive, object, OpenAI-style, and LangChain message inputs.
- tool-call extraction precedence and fallback behavior (`toolCalls` vs `tool_calls`, fallback IDs, invalid JSON handling).
- passthrough of unknown/future fields in message payloads during snapshot round-trip.

Observability in module code:
- no direct event bus, logger, or metrics instrumentation in `src/snapshot/*`.
- integrity observability is exposed as:
- boolean result from `verifySnapshot(...)`
- thrown error on invalid compressed payload shape in `decompressSnapshot(...)`

## Risks and TODOs
Current risks:
- hash checks provide tamper evidence only; there is no signature/authentication layer.
- `schemaVersion` is fixed and there is no versioned migration dispatcher in this subsystem.
- hash determinism relies on stable `JSON.stringify` behavior for provided object shapes.
- `messages: unknown[]` allows unvalidated payload content to be persisted and restored.
- compression and decompression are synchronous and may be expensive on large payloads.
- OpenAI `image_url` entries without a string `url` are dropped during normalization.
- enhanced and legacy serializer surfaces coexist, which can keep migration debt alive for consumers.

Current TODO directions (not yet implemented here):
- add explicit schema migration helpers when version changes are introduced.
- add authenticated snapshot integrity (e.g., signatures) if provenance is required.
- consider async/streaming compression paths for large payload workloads.
- continue reducing legacy serializer usage and define eventual removal policy at package level.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

