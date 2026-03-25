# @forgeagent/memory Architecture

## Purpose
`@forgeagent/memory` is the memory intelligence layer for ForgeAgent. It manages durable memory records, retrieval strategies, consolidation, policy-aware writes, provenance, and advanced graph/temporal structures.

## Main Responsibilities
- Provide namespace-scoped memory CRUD and search APIs.
- Support working memory and long-term memory patterns.
- Enforce safe writes through sanitization and write policies.
- Manage memory quality over time using decay, deduplication, pruning, and consolidation.
- Provide advanced retrieval and ranking (vector, FTS, graph, reranking, fusion).
- Support multi-agent/multi-space sharing and conflict handling.

## Module Structure
Top-level modules under `src/`:
- `memory-service.ts`, `working-memory.ts`, `scoped-memory.ts`, `versioned-working-memory.ts`.
- `retrieval/`: vector search, FTS, graph traversal, PageRank, hub dampening, RRF fusion, adaptive retrieval.
- `convention/`: convention extraction and conformance signals.
- `semantic-consolidation.ts`, `memory-consolidation.ts`, `sleep-consolidator.ts`, `staleness-pruner.ts`, `lesson-dedup.ts`.
- `write-policy.ts`, `staged-writer.ts`, `policy-aware-staged-writer.ts`, `dual-stream-writer.ts`.
- `temporal.ts`, `causal/`, `relationship-store`, `persistent-graph`.
- `provenance/`, `encryption/`, `sharing/`, `multi-modal/`, `crdt/`, `agent-file/`.
- `mcp-memory-server.ts` for MCP-facing memory operations.

## How It Works (Memory Lifecycle)
1. Memory write request enters `MemoryService` or a staged writer.
2. Sanitization/policy checks run before durable write.
3. Record is stored in namespace with scope keys and metadata.
4. Consolidation/decay jobs improve quality and reduce redundancy.
5. Retrieval combines one or more strategies based on query intent.
6. Results can be formatted for prompt injection with bounded context.

## Retrieval Architecture
- Vector retrieval for semantic similarity.
- FTS retrieval for lexical matching.
- Graph retrieval for relationship-aware traversal.
- Fusion/reranking layers improve ranking robustness.
- Adaptive retriever chooses strategy weights by inferred intent.

## Main Features
- Memory decay and reinforcement mechanics.
- Multi-phase consolidation and staleness pruning.
- Provenance tracking and content hashing.
- Encrypted memory wrapper for protected persistence.
- CRDT + HLC support for distributed conflict-safe merge scenarios.
- Multi-modal attachment-aware memory operations.
- Agent-file import/export for portability.

## Integration Boundaries
- Used directly by `@forgeagent/core` and server memory routes.
- Works with `@forgeagent/memory-ipc` for Arrow frame export/import and inter-process sharing.
- Relies on LangGraph-compatible stores (in-memory or Postgres-backed).

## Extensibility Points
- Add custom retrieval providers and score fusion logic.
- Add custom write policies and staged promotion heuristics.
- Extend convention/provenance extraction rules.
- Plug alternative attachment storage for multi-modal memory.

## Quality and Test Posture
- Heavy unit-test footprint (`30+` tests) covering retrieval math, consolidation, policy flow, encryption, temporal logic, and IPC bridge behavior.
