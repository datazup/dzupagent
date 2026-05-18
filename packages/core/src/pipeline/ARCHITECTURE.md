# Pipeline Architecture (`@dzupagent/core/src/pipeline`)

## Scope
This document covers the pipeline module under `packages/core/src/pipeline`:
- `pipeline-definition.ts`
- `pipeline-checkpoint-store.ts`
- `pipeline-serialization.ts`
- `pipeline-layout.ts`
- `index.ts`
- `__tests__/pipeline.test.ts`

It also covers package-level integration points that expose this module:
- `packages/core/src/index.ts`
- `packages/core/src/facades/orchestration.ts`
- `packages/core/src/pipeline.ts`
- `packages/core/package.json` export map (`"./pipeline"`, `"."`, `"./orchestration"`)

Out of scope:
- Execution runtime for pipeline nodes
- Scheduler/runner semantics
- Concrete persistence backend for checkpoints

## Responsibilities
- Define the pipeline DSL type contracts for nodes, edges, top-level definitions, and validation result shapes.
- Define checkpoint persistence contracts (`PipelineCheckpoint`, `PipelineCheckpointStore`).
- Validate pipeline/checkpoint payloads at runtime with Zod schemas.
- Provide JSON serialization and deserialization helpers with validation (`serializePipeline`, `deserializePipeline`).
- Provide deterministic auto-layout for graph visualization (`autoLayout`).
- Provide a stable local barrel (`src/pipeline/index.ts`) used by other entrypoints.

## Structure
- `pipeline-definition.ts`
- Defines `NodeRetryPolicy` and `PipelineNodeBase`.
- Defines 8 node variants: `agent`, `tool`, `transform`, `gate`, `fork`, `join`, `loop`, `suspend`.
- Defines 3 edge variants: `sequential`, `conditional`, `error`.
- Defines `CheckpointStrategy`, `PipelineDefinition`, and `PipelineValidation*` types.
- `pipeline-checkpoint-store.ts`
- Defines `PipelineCheckpoint` and `PipelineCheckpointSummary`.
- Defines `PipelineCheckpointStore` async contract: `save`, `load`, `loadVersion`, `listVersions`, `delete`, `prune`.
- `pipeline-serialization.ts`
- Defines Zod schemas for all node/edge variants, `PipelineCheckpoint`, and `PipelineDefinition`.
- Exposes `serializePipeline(definition)` and `deserializePipeline(json)`.
- `pipeline-layout.ts`
- Defines `NodePosition`, `ViewportState`, `PipelineLayout`.
- Implements `autoLayout(nodes, edges)` with topological depth layering and centered layer placement.
- `index.ts`
- Re-exports all pipeline types, schemas, and helper functions from local files.
- `__tests__/pipeline.test.ts`
- Unit tests for type/schema behavior, checkpoint shape validation, and serialization error paths.

## Runtime and Control Flow
Typical usage path:
1. Build a `PipelineDefinition` object using the node and edge unions.
2. Call `serializePipeline` to validate and emit JSON for storage or transport.
3. Call `deserializePipeline` to parse + validate incoming JSON payloads.
4. Optionally call `autoLayout` to compute deterministic UI coordinates.
5. Persist run snapshots via an external implementation of `PipelineCheckpointStore`.

Current helper behavior:
- `serializePipeline` uses `PipelineDefinitionSchema.safeParse` and throws `Error` with concatenated issue messages on failure.
- `deserializePipeline` first runs `JSON.parse`; malformed input throws `Pipeline deserialization failed: invalid JSON`, then schema-validate and throw issue-based errors when needed.
- `autoLayout`:
- Initializes adjacency and in-degree maps from the given node list.
- Processes edges where `targetNodeId` exists.
- Uses Kahn-style traversal and keeps max depth for multi-parent nodes.
- Assigns depth `0` to remaining nodes (disconnected/cycle fallback).
- Returns `nodePositions`, `layoutAlgorithm: "topological"`, `computedAt`, and default viewport `{ zoom: 1, panX: 0, panY: 0 }`.

## Key APIs and Types
Core type contracts:
- `NodeRetryPolicy`
- `PipelineNodeBase`
- `AgentNode`, `ToolNode`, `TransformNode`, `GateNode`, `ForkNode`, `JoinNode`, `LoopNode`, `SuspendNode`
- `PipelineNode`
- `SequentialEdge`, `ConditionalEdge`, `ErrorEdge`, `PipelineEdge`
- `CheckpointStrategy`
- `PipelineDefinition`
- `PipelineValidationError`, `PipelineValidationWarning`, `PipelineValidationResult`
- `PipelineCheckpoint`, `PipelineCheckpointSummary`, `PipelineCheckpointStore`
- `NodePosition`, `ViewportState`, `PipelineLayout`

Runtime schemas and helpers:
- `AgentNodeSchema`, `ToolNodeSchema`, `TransformNodeSchema`, `GateNodeSchema`, `ForkNodeSchema`, `JoinNodeSchema`, `LoopNodeSchema`, `SuspendNodeSchema`, `PipelineNodeSchema`
- `SequentialEdgeSchema`, `ConditionalEdgeSchema`, `ErrorEdgeSchema`, `PipelineEdgeSchema`
- `PipelineCheckpointSchema`, `PipelineDefinitionSchema`
- `serializePipeline`, `deserializePipeline`, `autoLayout`

## Dependencies
Direct dependency used by this folder:
- `zod` in `pipeline-serialization.ts`

Internal module dependency:
- `pipeline-serialization.ts` imports `PipelineDefinition` type from `pipeline-definition.ts`.
- `index.ts` only re-exports local pipeline module files.

Package export/dependency context from `packages/core/package.json`:
- `./pipeline` export points to `dist/pipeline.js` and `dist/pipeline.d.ts`.
- `zod` is declared as a peer dependency (`>=4.0.0`) and also present in `devDependencies`.

## Integration Points
Package entrypoints exposing this module:
- `src/index.ts` re-exports pipeline contracts, schemas, serialization helpers, and `autoLayout`.
- `src/facades/orchestration.ts` re-exports the same pipeline APIs as part of orchestration-focused surface.
- `src/pipeline.ts` re-exports pipeline APIs inside the broader pipeline-oriented subpath that also includes subagent/skills/mcp/registry/formats flows.

Consumer import surfaces:
- `@dzupagent/core`
- `@dzupagent/core/orchestration`
- `@dzupagent/core/pipeline`

Boundary:
- This folder defines contracts + validation + layout only.
- It does not execute pipelines or persist checkpoints by itself.

## Testing and Observability
Direct pipeline tests:
- `src/pipeline/__tests__/pipeline.test.ts`
- Validates all node and edge variants through schema parsing.
- Validates minimal and full `PipelineDefinition` payloads.
- Validates `PipelineCheckpointSchema` behavior.
- Covers `serializePipeline`/`deserializePipeline` happy paths and failure paths.
- Checks JSON-serializable expectations and compile-time validation result shape usage.

Related layout and export coverage:
- `src/__tests__/pipeline-layout.test.ts` covers empty/single/linear/branch/diamond layout behavior, viewport defaults, and missing-target edges.
- `src/__tests__/w15-h2-branch-coverage.test.ts` includes branch-oriented `autoLayout` tests for disconnected/cyclic/edge paths.
- `src/__tests__/facade-orchestration.test.ts` and `src/__tests__/facades.test.ts` verify pipeline APIs are reachable via facade surfaces.

Observability:
- No metrics/logging/tracing emission exists inside `src/pipeline/*`.
- Execution-time observability must be implemented by pipeline runtime layers that consume these contracts.

## Risks and TODOs
- Type/schema drift for per-node retry policy:
- `PipelineNodeBase` has optional `retryPolicy`, but `PipelineNodeBaseSchema` does not define it.
- Result: schema-validated payloads drop retry-policy fields.

- Type/schema drift for checkpoint recovery count:
- `PipelineCheckpoint` includes `recoveryAttemptsUsed`, but `PipelineCheckpointSchema` omits it.
- Result: schema-validated checkpoints drop that field.

- JSON contract mismatch in retry policy:
- `NodeRetryPolicy.retryableErrors` permits `RegExp`, which is not JSON-native despite module comments emphasizing JSON-serializable contracts.

- Limited semantic validation:
- `PipelineDefinitionSchema` checks shape but does not enforce graph semantics such as:
- `entryNodeId` existing in `nodes`
- edge/branch targets referencing known nodes
- unique node IDs

- Timestamp permissiveness:
- `PipelineCheckpointSchema.createdAt` validates as non-empty string only (no ISO datetime constraint).

- Layout edge permissiveness:
- `autoLayout` ignores edges whose source is not in the node set (`children.get(source)` missing), which can hide bad graph references unless validated upstream.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: full document rewrite based on current `packages/core` source, tests, exports, and package metadata.

