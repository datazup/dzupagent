# @dzupagent/memory-ipc Architecture

## Purpose
`@dzupagent/memory-ipc` defines a columnar interoperability layer for memory exchange between agents/processes/frameworks. It standardizes memory transfer around Apache Arrow tables plus serialization, adapter, selection, and transport utilities.

## Main Responsibilities
- Define a canonical memory frame schema for interop.
- Build/read memory frames with typed helper APIs.
- Serialize/deserialize frames over Arrow IPC and base64 channels.
- Perform vectorized column operations for scoring/selection/filtering.
- Provide adapter bridges to multiple memory ecosystems.
- Support MCP import/export handlers and A2A memory artifacts.

## Module Structure
Top-level modules under `src/`:
- `schema.ts`: canonical frame columns and metadata.
- `frame-builder.ts` / `frame-reader.ts`: bidirectional table mapping.
- `ipc-serializer.ts`: Arrow IPC and base64 transforms.
- `columnar-ops.ts`: decay update, mask, ranking, token-budget utilities.
- `token-budget.ts` + `phase-memory-selection.ts`: budgeted/phase-aware selection.
- `cache-delta.ts`, `memory-aware-compress.ts`, `shared-memory-channel.ts`.
- `adapters/`: LangGraph/Mastra/Mem0/Letta/MCP-KG adapters and registry.
- `mcp-memory-transport.ts`, `a2a-memory-artifact.ts`, `blackboard.ts`, `frames/`.

## How It Works (Interchange Flow)
1. Source memories are transformed into canonical Arrow frame rows.
2. Frame is serialized to IPC bytes (optionally base64-wrapped).
3. Consumer deserializes bytes into Arrow table.
4. Adapter or frame reader maps rows into target system representations.
5. Optional selection/ranking runs to enforce token or phase budgets.

## Main Features
- Canonical schema with explicit version and field-count metadata.
- Efficient batch/columnar operations (instead of row-wise scans).
- Adapter registry for framework-level portability.
- Shared-memory channel support for low-copy intra-process exchange.
- MCP handler set for export/import/schema discovery endpoints.
- Domain-specific extended frames (tool results, codegen, eval, entity graph).

## Integration Boundaries
- Optional peer integration with `@dzupagent/memory`.
- Used by `@dzupagent/agent`, `@dzupagent/server`, and memory tooling for interchange.
- Built on `apache-arrow` and `zod` schemas.

## Extensibility Points
- Add new adapter implementations.
- Extend frame schemas in `frames/` for additional domains.
- Add optimized column operations for new ranking strategies.

## Quality and Test Posture
- Strong test coverage for frame round-trips, schemas, deltas, token budgets, shared channels, and adapter correctness.
