# Memory Arrow Interoperability — Master Plan Index

> **Created:** 2026-03-24
> **Status:** Planning
> **Scope:** Apache Arrow-based memory IPC, inter-agent sharing, columnar operations, context/token optimization
> **Depends on:** `docs/ecosystem_plan/05-MEMORY-SHARING.md` (SharedSpaces, Provenance, CausalGraph)
> **Source proposal:** `docs/agent_memory_arrow_interoperability.md`

---

## Problem Statement

DzipAgent's memory system stores every record as `Record<string, unknown>` serialized to JSON. This works for single-agent, single-process use cases. It breaks down at three boundaries:

1. **Inter-agent memory sharing** — agents in separate processes/threads pay full JSON serialization costs
2. **External agent interoperability** — no standard wire format for Mastra, LangGraph, CrewAI, Mem0, or A2A peers
3. **Bulk batch operations** — consolidation, decay scoring, PageRank, temporal filtering must deserialize every record row-by-row
4. **Token budget management** — no columnar analysis of which memories are worth their token cost

Apache Arrow provides a language-agnostic, zero-copy columnar format with IPC serialization that solves all four. This plan details the implementation across 8 documents.

---

## Plan Documents

| # | Document | Focus | Priority | Effort |
|---|----------|-------|----------|--------|
| **01** | [Architecture Overview](./01-ARCHITECTURE.md) | MemoryFrame design, integration with existing stack, data flow | P0 | — |
| **02** | [MemoryFrame Schema](./02-MEMORYFRAME-SCHEMA.md) | Full Arrow schema spec, field types, encoding, versioning, extensibility | P0 | 8h |
| **03** | [@dzipagent/memory-ipc Package](./03-IPC-PACKAGE.md) | FrameBuilder, FrameReader, IPC serializer, SharedMemoryChannel | P0 | 16h |
| **04** | [Inter-Agent Sharing Patterns](./04-INTER-AGENT-PATTERNS.md) | 4 sharing patterns, MCP exchange tools, A2A artifacts, blackboard | P0 | 12h |
| **05** | [Columnar Batch Operations](./05-COLUMNAR-OPS.md) | Vectorized decay, temporal mask, PageRank, hub dampening, consolidation | P1 | 10h |
| **06** | [Context & Token Management](./06-CONTEXT-TOKEN-MANAGEMENT.md) | Arrow-based token budgeting, context compression, prompt cache optimization | P1 | 8h |
| **07** | [Cross-Framework Adapters](./07-CROSS-FRAMEWORK-ADAPTERS.md) | Mastra, LangGraph, Mem0, Letta, MCP-KG bidirectional adapters | P1 | 12h |
| **08** | [Arrow in the Agentic Framework](./08-ARROW-AGENTIC-EXTENSIONS.md) | Beyond memory: tool results, codegen pipelines, eval, graph analytics, DuckDB | P2 | 10h |
| **09** | [Implementation Roadmap](./09-IMPLEMENTATION-ROADMAP.md) | Sprint breakdown, dependencies, effort estimates, testing strategy | — | — |

**Total estimated effort:** ~76h across 7 implementation sprints

---

## Relationship to Existing Plans

### ecosystem_plan/05-MEMORY-SHARING.md

The Memory Sharing Protocol defines **what** is shared (SharedSpaces, Provenance, CausalGraph, AgentFile, CRDT, Encryption, Convention). This Arrow plan defines **how** memory data is serialized, transferred, and operated on at the wire/memory level.

| 05-MEMORY-SHARING Feature | Arrow Plan Integration |
|---|---|
| **F1: SharedMemorySpace** | Arrow IPC as the transfer format between space participants (doc 04) |
| **F2: Provenance** | Provenance columns in MemoryFrame schema (doc 02) |
| **F3: CausalGraph** | Causal edges as Arrow Table with dict-encoded entity IDs (doc 05) |
| **F4: AgentFile (.af)** | Arrow IPC as binary section inside .af archive (doc 03) |
| **F5: CRDT** | HLC timestamps as Int64 columns, field-level merge on Arrow vectors (doc 05) |
| **F6: Encryption** | Encrypted envelope stored in `payload_json` column (doc 02) |
| **F7: MultiModal** | Attachment metadata as nested Struct column (doc 02) |
| **F8: Convention** | Convention records as Arrow Table for batch conformance checks (doc 05) |

### memory_plan/

The memory_plan documents (01-10) focus on the StarterForge application layer — feature abstraction, multi-tech-stack generation, RAG cross-stack retrieval. Arrow operates below that layer, providing efficient data transport and batch operations that the application layer benefits from without needing to know about.

---

## Key Architectural Decisions

1. **Arrow is optional** — `@dzipagent/memory` keeps its existing `Record<string, unknown>` API unchanged. Arrow lives in the separate `@dzipagent/memory-ipc` package. Consumers that don't need IPC never pay the `apache-arrow` dependency cost (~2MB).

2. **MemoryFrame as the canonical schema** — a single Arrow Schema with typed columns for all memory metadata (temporal, decay, provenance, scope). This schema IS the interoperability contract.

3. **SharedArrayBuffer for in-process workers** — consolidation, PageRank, and decay batch operations run on piscina worker threads. Arrow + SharedArrayBuffer eliminates JSON serialization overhead (~90x faster).

4. **Arrow IPC over MCP for cross-process** — `memory.export`, `memory.import`, `memory.subscribe` MCP tools exchange Arrow IPC bytes. Base64-encoded for JSON transport compatibility.

5. **A2A Artifacts for external agents** — memory batches sent to external agents as A2A Artifacts with MIME type `application/vnd.apache.arrow.stream`.

6. **Zero breaking changes** — every phase is additive. Existing code continues to work unchanged.

---

## Current Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| MemoryService (namespace-scoped) | Implemented | `@dzipagent/memory` |
| ScopedMemoryService (access policies) | Implemented | `@dzipagent/memory` |
| TemporalMemoryService (bi-temporal) | Implemented | `@dzipagent/memory` |
| WorkingMemory (Zod-validated) | Implemented | `@dzipagent/memory` |
| DualStreamWriter (fast/slow path) | Implemented | `@dzipagent/memory` |
| AdaptiveRetriever (intent-weighted RRF) | Implemented | `@dzipagent/memory` |
| PersistentEntityGraph (inverted index) | Implemented | `@dzipagent/memory` |
| Auto-compress pipeline | Implemented | `@dzipagent/context` |
| ContextTransferService (cross-intent) | Implemented | `@dzipagent/context` |
| PhaseAwareWindowManager | Implemented | `@dzipagent/context` |
| ProgressiveCompress (5-level) | Implemented | `@dzipagent/context` |
| **MemoryFrame Arrow Schema** | **Not started** | `@dzipagent/memory-ipc` (new) |
| **FrameBuilder / FrameReader** | **Not started** | `@dzipagent/memory-ipc` (new) |
| **SharedMemoryChannel** | **Not started** | `@dzipagent/memory-ipc` (new) |
| **MCP memory exchange tools** | **Not started** | `@dzipagent/server` |
| **Cross-framework adapters** | **Not started** | `@dzipagent/memory-ipc` (new) |
| **Columnar batch operations** | **Not started** | `@dzipagent/memory-ipc` (new) |
