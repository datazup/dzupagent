# ADR-001: Qdrant Tenant Isolation Strategy

**Status:** Decided  
**Date:** 2026-04-20

## Context

The `@dzupagent/rag` package ships two distinct Qdrant integration strategies:

| File | Strategy | Tenant isolation |
|------|----------|-----------------|
| `src/qdrant-factory.ts` | **Option B** — `createQdrantRagPipeline` | One collection per tenant (`rag_<tenantId>`). Uses `QdrantAdapter` from `@dzupagent/core`. |
| `src/providers/qdrant.ts` | **Option A** — `QdrantVectorStore` / `createQdrantRetriever` | Single shared collection with `tenantId` payload filter. Dynamically imports `@qdrant/js-client-rest`. |

Both files exist today and both are exported from the package. The question is: which is the recommended default?

## Decision

**Use Option A (`providers/qdrant.ts`) as the default for new code that hooks into `HybridRetriever`.**  
**Use Option B (`qdrant-factory.ts`) when creating a full `RagPipeline` with ingestion, chunking, and retrieval.**

### Rationale

| Concern | Option A (shared collection) | Option B (per-tenant collection) |
|---------|-----------------------------|---------------------------------|
| Operational footprint | Low — one collection, no provisioning per tenant | High — N collections to manage |
| Qdrant RBAC | Relies on payload filter; weaker boundary | Each collection is its own RBAC boundary |
| Multi-tenant scale | Works up to ~millions of points before partitioning becomes necessary | Ideal when each tenant has a large, distinct corpus |
| RagPipeline integration | `createQdrantRetriever` returns raw search functions for `HybridRetriever` | `createQdrantRagPipeline` returns a full `RagPipeline` |
| Optional dep | Dynamic import (`@qdrant/js-client-rest` optional) | Static import via `@dzupagent/core` |

### When to use Option B instead

- When strict collection-level RBAC is required (e.g., regulated industries).
- When a tenant's corpus is large enough that shared-collection scan costs dominate.
- When you need the full `RagPipeline` API (chunking, ingestion, context assembly) out of the box.

## Consequences

- No code is removed. Both strategies remain available.
- New rag-service integrations that need only retrieval should prefer `createQdrantRetriever` (Option A).
- `createQdrantRagPipeline` (Option B) is recommended when the full `RagPipeline` lifecycle is needed.
- The comment at the top of `src/providers/qdrant.ts` already captures this intent; this ADR formalises it.
