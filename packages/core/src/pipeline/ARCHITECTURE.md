# Pipeline Architecture (`@dzupagent/core`)

## Scope
This document covers the pipeline module under `packages/core/src/pipeline`:
- `pipeline-definition.ts`
- `pipeline-checkpoint-store.ts`
- `pipeline-serialization.ts`
- `pipeline-layout.ts`
- `index.ts`
- `__tests__/pipeline.test.ts`

It also includes package-level integration evidence from:
- `packages/core/src/index.ts`
- `packages/core/src/facades/orchestration.ts`
- `packages/core/src/__tests__/pipeline-layout.test.ts`
- `packages/core/src/__tests__/facades.test.ts`
- `packages/core/package.json`

This module provides contracts, validation/serialization helpers, and layout utilities. It does not implement a pipeline executor.

## Responsibilities
The pipeline module is responsible for:
- Defining the canonical pipeline data model as TypeScript interfaces and discriminated unions.
- Defining checkpoint persistence contracts via an async store interface.
- Validating pipeline/checkpoint payloads with Zod schemas.
- Serializing/deserializing pipeline definitions to/from JSON with schema enforcement.
- Providing a deterministic topological layout helper for visualization.
- Re-exporting pipeline symbols as a focused submodule API.

## Structure
`src/pipeline` is split by concern:
- `pipeline-definition.ts`
  - Core domain types: `PipelineNode` (8 node types), `PipelineEdge` (3 edge types), `PipelineDefinition`, checkpoint strategy, validation result types.
- `pipeline-checkpoint-store.ts`
  - Checkpoint payload types and `PipelineCheckpointStore` interface (`save/load/loadVersion/listVersions/delete/prune`).
- `pipeline-serialization.ts`
  - Zod schemas for nodes, edges, checkpoint, and full definitions.
  - `serializePipeline()` and `deserializePipeline()` helpers.
- `pipeline-layout.ts`
  - `autoLayout()` with topological layering and default viewport metadata.
- `index.ts`
  - Type and runtime re-exports for the module.
- `__tests__/pipeline.test.ts`
  - Unit coverage for schema unions, definition/checkpoint validation, serialization failures/success, and JSON-serializable expectations.

## Runtime and Control Flow
Current flow supported by this module:
1. A caller builds a `PipelineDefinition` object using union types from `pipeline-definition.ts`.
2. Caller validates the object through `PipelineDefinitionSchema` (directly or via `serializePipeline`).
3. `serializePipeline(definition)` performs schema validation and returns JSON.
4. `deserializePipeline(json)` parses JSON, validates against schema, and returns a typed definition.
5. If graph visualization is needed, caller converts edges to simple source/target relations and calls `autoLayout(nodes, edges)`.
6. If execution state persistence is needed, caller provides a `PipelineCheckpointStore` implementation and persists `PipelineCheckpoint` payloads.

Notes on module behavior:
- `autoLayout()` computes depth using Kahn-style topological processing with max-depth updates for multi-parent nodes.
- Edges without `targetNodeId` are tolerated in layout input and ignored during adjacency/depth updates.
- Empty-node layout returns an empty `nodePositions` map with metadata (`layoutAlgorithm`, `computedAt`).
- Checkpoint storage is interface-only in this module; no concrete backend is included in `src/pipeline`.

## Key APIs and Types
Primary types:
- `NodeRetryPolicy`
- `PipelineNodeBase`
- `AgentNode | ToolNode | TransformNode | GateNode | ForkNode | JoinNode | LoopNode | SuspendNode`
- `PipelineNode`
- `SequentialEdge | ConditionalEdge | ErrorEdge`
- `PipelineEdge`
- `CheckpointStrategy`
- `PipelineDefinition`
- `PipelineValidationError | PipelineValidationWarning | PipelineValidationResult`
- `PipelineCheckpoint | PipelineCheckpointSummary | PipelineCheckpointStore`
- `NodePosition | ViewportState | PipelineLayout`

Primary runtime exports:
- Zod schemas:
  - `AgentNodeSchema`, `ToolNodeSchema`, `TransformNodeSchema`, `GateNodeSchema`, `ForkNodeSchema`, `JoinNodeSchema`, `LoopNodeSchema`, `SuspendNodeSchema`
  - `PipelineNodeSchema`
  - `SequentialEdgeSchema`, `ConditionalEdgeSchema`, `ErrorEdgeSchema`, `PipelineEdgeSchema`
  - `PipelineCheckpointSchema`, `PipelineDefinitionSchema`
- Functions:
  - `serializePipeline(definition)`
  - `deserializePipeline(json)`
  - `autoLayout(nodes, edges)`

## Dependencies
Direct dependencies used by this module:
- `zod` (in `pipeline-serialization.ts`) for runtime validation.

Internal dependencies:
- `pipeline-serialization.ts` imports `PipelineDefinition` type from `pipeline-definition.ts`.
- `index.ts` is a pure barrel over module-local files.

Package metadata relevant to this module (`packages/core/package.json`):
- `zod` is declared as a peer dependency (`>=4.0.0`) and a dev dependency (`^4.3.6`) for local build/test.
- Build/test scripts are package-level (`tsup`, `tsc --noEmit`, `vitest run`, `eslint src/`).

## Integration Points
Within `@dzupagent/core`, pipeline APIs are surfaced through:
- Root barrel: `packages/core/src/index.ts` re-exports pipeline types, schemas, serialization helpers, and layout API.
- Orchestration facade: `packages/core/src/facades/orchestration.ts` re-exports pipeline types/schemas/functions for curated orchestration imports.

External import surfaces declared in package exports:
- `@dzupagent/core` (root barrel includes pipeline exports)
- `@dzupagent/core/orchestration` (includes pipeline exports through facade)
- `@dzupagent/core/advanced` (alias of full root surface)
- `@dzupagent/core/stable` (namespace facade that reaches orchestration exports)

Practical integration expectations from current code:
- This module is a contract and utility layer for pipeline definition/checkpoint/layout data.
- Execution semantics (scheduling, retries, runtime state machine, real checkpoint backend behavior) are implemented outside this folder.

## Testing and Observability
Tests directly covering this module:
- `src/pipeline/__tests__/pipeline.test.ts`
  - Validates all node and edge schema variants.
  - Validates minimal and full pipeline definitions.
  - Validates checkpoint payloads.
  - Verifies serialize/deserialize success and error handling.
  - Includes JSON-serializable constraint checks.
- `src/__tests__/pipeline-layout.test.ts`
  - Covers empty/single/linear/parallel/diamond graphs.
  - Covers viewport metadata, dimensions, JSON round-trip, and missing-target edge handling.
- `src/__tests__/facades.test.ts`
  - Verifies orchestration facade exports `PipelineDefinitionSchema`, `serializePipeline`, `deserializePipeline`, and `autoLayout`.

Observability status in `src/pipeline`:
- No built-in logging, metrics, or event emission is implemented in this folder.
- Observability is currently limited to test assertions and caller-managed instrumentation.

## Risks and TODOs
Current code-level risks in this module:
- `retryPolicy` drift between type model and schema:
  - `PipelineNodeBase` includes `retryPolicy?: NodeRetryPolicy`.
  - `PipelineNodeBaseSchema` in `pipeline-serialization.ts` does not include `retryPolicy`.
  - Result: definitions using `retryPolicy` are not preserved by schema-validated serialization/deserialization.
- JSON-serializable claim mismatch:
  - `NodeRetryPolicy.retryableErrors` allows `RegExp` values.
  - `RegExp` is not JSON-native, which conflicts with module comments stating full JSON-serializability.
- Checkpoint timestamp validation is weak:
  - `PipelineCheckpointSchema.createdAt` is validated as non-empty string, not as an ISO datetime format.
- Graph semantic validation is intentionally absent here:
  - Schema validation does not enforce graph-level invariants (for example entry-node existence in nodes, reachability, cycle/fork/join consistency).

Targeted follow-ups:
- Add `retryPolicy` schema support (or remove field from types if intentionally unsupported).
- Decide and enforce one policy for `retryableErrors` (`string[]` for strict JSON, or explicit custom encoding for regex).
- Tighten `createdAt` validation to datetime format if downstream requires strict parsing.
- Keep semantic graph validation responsibilities explicit in the runtime package and documented as out-of-scope for this module.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: rewrote document from live `packages/core/src/pipeline` implementation, package exports, and in-repo tests.
