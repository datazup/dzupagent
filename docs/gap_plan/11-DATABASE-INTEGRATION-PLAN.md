# 11-DATABASE-INTEGRATION-PLAN.md -- Database & Code Intelligence Enhancements

> **Status**: Proposed
> **Author**: Architecture session 2026-03-26
> **Scope**: 6 work streams, 3 packages affected, ~25 tasks

---

## Table of Contents

1. [Overview](#overview)
2. [Stream 1: LanceDB Vector Store Adapter (P0)](#stream-1-lancedb-vector-store-adapter)
3. [Stream 2: Tree-Sitter Code Intelligence (P0)](#stream-2-tree-sitter-code-intelligence)
4. [Stream 3: DuckDB-WASM Analytics (P1)](#stream-3-duckdb-wasm-analytics)
5. [Stream 4: Drizzle pgvector Enhancement (P1)](#stream-4-drizzle-pgvector-enhancement)
6. [Stream 5: Copy-on-Write VFS Snapshots (P2)](#stream-5-copy-on-write-vfs-snapshots)
7. [Stream 6: Turbopuffer Adapter (P2)](#stream-6-turbopuffer-adapter)
8. [Dependency Graph](#dependency-graph)
9. [ADRs](#adrs)

---

## Overview

### Motivation

The DzipAgent vectordb layer has 4 adapters (Qdrant, Pinecone, pgvector, Chroma) plus InMemory. The symbol extraction in codegen is regex-only. The memory-ipc package has rich Arrow schemas but no analytical query capability. These gaps limit three capabilities:

1. **Embedded vector search** -- no zero-config option exists that avoids an external service
2. **Code understanding** -- regex extraction misses nested symbols, decorators, destructured exports, and all non-TypeScript languages
3. **Memory analytics** -- Arrow data cannot be queried with SQL; no trend/aggregate analysis

### Design Constraints

- All new adapters MUST implement the existing `VectorStore` interface from `core/vectordb/types.ts`
- All new dependencies MUST be optional peer deps with dynamic `import()`
- Tree-sitter MUST NOT become a hard dependency -- regex fallback must remain
- DuckDB-WASM operates on Arrow Tables from memory-ipc, not core (avoids core -> memory-ipc dependency)
- No `any` types. TypeScript strict mode.

### Package Ownership

| Stream | Owner Package | Touches |
|--------|--------------|---------|
| LanceDB | `@dzipagent/core` | vectordb/adapters/, vectordb/auto-detect.ts, vectordb/index.ts |
| Tree-sitter | `@dzipagent/codegen` | repomap/, new chunking/ directory |
| DuckDB-WASM | `@dzipagent/memory-ipc` | new analytics/ directory |
| Drizzle pgvector | `@dzipagent/server` | persistence/drizzle-schema.ts, new persistence/vector-ops.ts |
| CoW VFS | `@dzipagent/codegen` | vfs/ directory |
| Turbopuffer | `@dzipagent/core` | vectordb/adapters/ |

---

## Stream 1: LanceDB Vector Store Adapter

**Priority**: P0
**Rationale**: LanceDB is Arrow-native (zero-copy with memory-ipc), embedded (no external service), and supports hybrid search (BM25 + vector + SQL filters). It is the only vector DB that gives DzipAgent a zero-config production-grade option. Continue.dev validates it for code search at scale.

### ADR-011: LanceDB as Embedded Vector Store

**Context**: Current vector store options all require external services (Qdrant, Pinecone) or are toy (InMemory). Users need a zero-config option that persists to disk and supports hybrid search.

**Decision**: Add a `LanceDBAdapter` implementing `VectorStore` in `@dzipagent/core`. LanceDB becomes the recommended default when no external vector service is configured. Auto-detection priority: explicit VECTOR_PROVIDER > QDRANT_URL > PINECONE_API_KEY > LANCEDB_URI > memory.

**Constraints**:
- `@lancedb/lancedb` is an optional peer dependency (dynamic import)
- Arrow Table round-trip must be zero-copy when memory-ipc is present
- Must support hybrid search mode (vector + FTS) through the existing `VectorQuery` interface
- Local-file and S3 URI schemes both supported via LANCEDB_URI

### 1.1 Interface Contract

```typescript
// File: packages/forgeagent-core/src/vectordb/adapters/lancedb-adapter.ts

import type {
  VectorStore,
  CollectionConfig,
  VectorEntry,
  VectorQuery,
  VectorSearchResult,
  VectorDeleteFilter,
  VectorStoreHealth,
  MetadataFilter,
} from '../types.js'

/** Configuration for the LanceDB adapter */
export interface LanceDBAdapterConfig {
  /**
   * LanceDB connection URI.
   * - Local: "~/.forgeagent/lancedb" or "/tmp/lancedb"
   * - S3: "s3://bucket/path"
   * Defaults to ~/.forgeagent/lancedb
   */
  uri?: string

  /**
   * Enable hybrid search (BM25 full-text + vector similarity).
   * Requires LanceDB FTS index to be built on the 'text' column.
   * Default: true
   */
  hybridSearch?: boolean

  /**
   * Weight for vector similarity in hybrid search (0-1).
   * BM25 weight = 1 - vectorWeight.
   * Default: 0.7
   */
  vectorWeight?: number
}

/**
 * LanceDB vector store adapter.
 *
 * Arrow-native embedded vector database. Supports:
 * - Persistent local storage (no external service)
 * - Hybrid search (BM25 + vector + metadata filters)
 * - Zero-copy Arrow Table exchange with @dzipagent/memory-ipc
 * - S3-backed storage for production deployments
 *
 * @example
 * ```ts
 * const adapter = await LanceDBAdapter.create({ uri: '~/.forgeagent/lancedb' })
 * await adapter.createCollection('memories', { dimensions: 1536 })
 * await adapter.upsert('memories', [{ id: '1', vector: [...], metadata: {}, text: 'hello' }])
 * const results = await adapter.search('memories', { vector: [...], limit: 10 })
 * ```
 */
export class LanceDBAdapter implements VectorStore {
  readonly provider = 'lancedb'

  // Private constructor -- use static create() for async init
  private constructor(db: unknown, config: Required<LanceDBAdapterConfig>) { /* ... */ }

  /**
   * Async factory -- dynamically imports @lancedb/lancedb.
   * Throws ForgeError('MISSING_PEER_DEP') if not installed.
   */
  static async create(config?: LanceDBAdapterConfig): Promise<LanceDBAdapter>

  // --- VectorStore interface ---
  createCollection(name: string, config: CollectionConfig): Promise<void>
  deleteCollection(name: string): Promise<void>
  listCollections(): Promise<string[]>
  collectionExists(name: string): Promise<boolean>
  upsert(collection: string, entries: VectorEntry[]): Promise<void>
  search(collection: string, query: VectorQuery): Promise<VectorSearchResult[]>
  delete(collection: string, filter: VectorDeleteFilter): Promise<void>
  count(collection: string): Promise<number>
  healthCheck(): Promise<VectorStoreHealth>
  close(): Promise<void>

  // --- LanceDB-specific extensions ---

  /**
   * Build a full-text search index on the 'text' column of a collection.
   * Required for hybrid search. Idempotent -- no-ops if index exists.
   */
  buildFTSIndex(collection: string): Promise<void>

  /**
   * Zero-copy upsert from an Apache Arrow Table.
   * Only available when @dzipagent/memory-ipc is installed.
   * Falls back to row-by-row upsert otherwise.
   */
  upsertArrowTable(collection: string, table: unknown): Promise<void>

  /**
   * Return search results as an Arrow Table (zero-copy).
   * Returns null if apache-arrow is not available.
   */
  searchAsArrow(collection: string, query: VectorQuery): Promise<unknown | null>
}
```

### 1.2 Tasks

| ID | Task | Files | Estimate |
|----|------|-------|----------|
| DB-001 | Create `lancedb-adapter.ts` implementing `VectorStore` | `core/src/vectordb/adapters/lancedb-adapter.ts` | 4h |
| DB-002 | Implement `MetadataFilter` -> LanceDB SQL WHERE translation | Same file, `translateFilter()` function | 2h |
| DB-003 | Implement hybrid search (BM25 + vector with configurable weights) | Same file, `search()` method | 3h |
| DB-004 | Add Arrow Table zero-copy methods (`upsertArrowTable`, `searchAsArrow`) | Same file | 2h |
| DB-005 | Add `@lancedb/lancedb` as optional peer dep in core package.json | `core/package.json` | 0.5h |
| DB-006 | Register in adapter barrel export | `core/src/vectordb/adapters/index.ts` | 0.5h |
| DB-007 | Register in vectordb barrel export | `core/src/vectordb/index.ts` | 0.5h |
| DB-008 | Add LanceDB to auto-detection chain (after Pinecone, before memory fallback) | `core/src/vectordb/auto-detect.ts` | 1h |
| DB-009 | Write unit tests with mock LanceDB | `core/src/vectordb/__tests__/lancedb-adapter.test.ts` | 3h |
| DB-010 | Update `createAutoSemanticStore` to prefer LanceDB over InMemory when LANCEDB_URI is set | `core/src/vectordb/auto-detect.ts` | 1h |

### 1.3 Dependencies to Add

```jsonc
// packages/forgeagent-core/package.json
{
  "peerDependencies": {
    "@lancedb/lancedb": ">=0.10.0"  // ADD
  },
  "peerDependenciesMeta": {
    "@lancedb/lancedb": { "optional": true }  // ADD
  }
}
```

### 1.4 Integration Points

- **auto-detect.ts**: `detectVectorProvider()` gains a new detection step: `LANCEDB_URI` env var -> `{ provider: 'lancedb', config: { uri } }`
- **auto-detect.ts**: `createAutoSemanticStore()` uses LanceDBAdapter instead of InMemoryVectorStore when LanceDB is detected
- **memory-ipc**: The `upsertArrowTable()` method accepts `arrow.Table` instances from memory-ipc's `FrameBuilder.toTable()`. This is a runtime integration -- no compile-time dependency from core to memory-ipc
- **server**: Server can wire `LanceDBAdapter` into the memory API routes as an alternative to pgvector

### 1.5 Auto-Detection Priority (Updated)

```
1. VECTOR_PROVIDER env var (explicit override)
2. QDRANT_URL present -> qdrant
3. PINECONE_API_KEY present -> pinecone
4. LANCEDB_URI present -> lancedb (NEW)
5. Falls back to 'lancedb' with default URI ~/.forgeagent/lancedb (NEW -- replaces 'memory')
```

The fallback change from InMemory to LanceDB-with-default-path is significant: it means DzipAgent gets persistent vector search out of the box. InMemory remains available via explicit `VECTOR_PROVIDER=memory`.

---

## Stream 2: Tree-Sitter Code Intelligence

**Priority**: P0
**Rationale**: The current `symbol-extractor.ts` is 104 lines of regex that handles only TypeScript. It cannot parse Python, Go, Rust, or Java. It misses nested classes, decorated functions, destructured exports, and arrow function assignments. Every serious code-gen agent (Cursor, Replit, Windsurf, Aider) uses tree-sitter. This is the single biggest code intelligence gap.

### ADR-012: Tree-Sitter AST Parsing in Codegen

**Context**: `extractSymbols()` in `codegen/src/repomap/symbol-extractor.ts` uses regex patterns. It only handles TypeScript and misses many symbol patterns (nested, decorated, destructured).

**Decision**: Add a `TreeSitterExtractor` in `@dzipagent/codegen` that uses tree-sitter WASM grammars for AST-based symbol extraction. The existing regex extractor remains as the fallback when tree-sitter grammars are not installed. A new `CodeChunker` uses AST boundaries to split files into embedding-ready chunks.

**Constraints**:
- `tree-sitter` and `tree-sitter-wasms` are optional peer deps
- The public API (`extractSymbols()` signature) must remain backward-compatible
- Language grammars are loaded lazily per-file-extension
- No native compilation required -- WASM grammars only

### 2.1 Interface Contract

```typescript
// File: packages/forgeagent-codegen/src/repomap/tree-sitter-extractor.ts

import type { ExtractedSymbol } from './symbol-extractor.js'

/** Supported languages for tree-sitter extraction */
export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'

/** Maps file extensions to tree-sitter language identifiers */
export const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
}

/**
 * Extended symbol information available from AST parsing.
 * Superset of ExtractedSymbol -- backward-compatible.
 */
export interface ASTSymbol extends ExtractedSymbol {
  /** End line of the symbol definition (tree-sitter gives exact ranges) */
  endLine: number
  /** Column start */
  column: number
  /** Column end */
  endColumn: number
  /** Parent symbol name (for nested classes/methods) */
  parent?: string
  /** Language the symbol was extracted from */
  language: SupportedLanguage
  /** JSDoc/docstring if present */
  docstring?: string
  /** Parameters for functions/methods */
  parameters?: string[]
  /** Return type annotation if present */
  returnType?: string
}

/**
 * Extract symbols from source code using tree-sitter AST parsing.
 *
 * Falls back to regex extraction if:
 * - tree-sitter is not installed
 * - No grammar exists for the file's language
 * - Parsing fails for any reason
 *
 * @param filePath - Used to determine language from extension
 * @param content - Source code to parse
 * @returns Array of extracted symbols (ASTSymbol when tree-sitter succeeds, ExtractedSymbol on fallback)
 */
export async function extractSymbolsAST(
  filePath: string,
  content: string,
): Promise<ASTSymbol[]>

/**
 * Check if tree-sitter is available and a grammar exists for the given language.
 */
export function isTreeSitterAvailable(language?: SupportedLanguage): Promise<boolean>
```

```typescript
// File: packages/forgeagent-codegen/src/chunking/ast-chunker.ts

import type { ASTSymbol } from '../repomap/tree-sitter-extractor.js'

/** A code chunk with AST-aware boundaries */
export interface CodeChunk {
  /** Unique identifier: filePath#symbolName or filePath#L{start}-L{end} */
  id: string
  /** File this chunk belongs to */
  filePath: string
  /** The source code of the chunk */
  content: string
  /** Start line (1-indexed) */
  startLine: number
  /** End line (1-indexed) */
  endLine: number
  /** Symbols contained in this chunk */
  symbols: ASTSymbol[]
  /** Language of the source file */
  language: string
  /** Estimated token count */
  estimatedTokens: number
}

/** Configuration for the AST chunker */
export interface ASTChunkerConfig {
  /** Maximum tokens per chunk (default: 512) */
  maxChunkTokens?: number
  /** Minimum tokens per chunk to avoid tiny fragments (default: 64) */
  minChunkTokens?: number
  /** Overlap lines between adjacent chunks (default: 2) */
  overlapLines?: number
}

/**
 * Split source files into embedding-ready chunks using AST boundaries.
 *
 * Strategy:
 * 1. Parse file with tree-sitter to get symbol boundaries
 * 2. Each top-level symbol (class, function, interface) becomes a chunk
 * 3. Large symbols are split at nested boundaries (methods within classes)
 * 4. Small adjacent symbols are merged to meet minChunkTokens
 * 5. Falls back to line-based splitting if tree-sitter is unavailable
 *
 * @param filePath - File path (for language detection and chunk IDs)
 * @param content - Source code to chunk
 * @param config - Chunking parameters
 */
export async function chunkByAST(
  filePath: string,
  content: string,
  config?: ASTChunkerConfig,
): Promise<CodeChunk[]>
```

### 2.2 Tasks

| ID | Task | Files | Estimate |
|----|------|-------|----------|
| TS-001 | Create `tree-sitter-extractor.ts` with per-language query patterns | `codegen/src/repomap/tree-sitter-extractor.ts` | 6h |
| TS-002 | Write tree-sitter query patterns for TypeScript/JavaScript | `codegen/src/repomap/queries/typescript.scm` | 3h |
| TS-003 | Write tree-sitter query patterns for Python | `codegen/src/repomap/queries/python.scm` | 2h |
| TS-004 | Write tree-sitter query patterns for Go | `codegen/src/repomap/queries/go.scm` | 2h |
| TS-005 | Write tree-sitter query patterns for Rust | `codegen/src/repomap/queries/rust.scm` | 2h |
| TS-006 | Write tree-sitter query patterns for Java | `codegen/src/repomap/queries/java.scm` | 2h |
| TS-007 | Create `ast-chunker.ts` with symbol-boundary splitting | `codegen/src/chunking/ast-chunker.ts` | 4h |
| TS-008 | Create chunking barrel export | `codegen/src/chunking/index.ts` | 0.5h |
| TS-009 | Update `extractSymbols()` to try tree-sitter first, regex fallback | `codegen/src/repomap/symbol-extractor.ts` | 2h |
| TS-010 | Update repomap barrel export | `codegen/src/repomap/index.ts` | 0.5h |
| TS-011 | Add peer deps to codegen package.json | `codegen/package.json` | 0.5h |
| TS-012 | Write tests for tree-sitter extractor (all 6 languages) | `codegen/src/__tests__/tree-sitter-extractor.test.ts` | 4h |
| TS-013 | Write tests for AST chunker | `codegen/src/__tests__/ast-chunker.test.ts` | 3h |
| TS-014 | Integration: wire AST chunker into repo-map-builder | `codegen/src/repomap/repo-map-builder.ts` | 2h |

### 2.3 Dependencies to Add

```jsonc
// packages/forgeagent-codegen/package.json
{
  "peerDependencies": {
    "tree-sitter": ">=0.22.0",       // ADD -- WASM-based parser
    "tree-sitter-wasms": ">=0.1.0"   // ADD -- pre-compiled WASM grammars
  },
  "peerDependenciesMeta": {
    "tree-sitter": { "optional": true },
    "tree-sitter-wasms": { "optional": true }
  }
}
```

Note: The `tree-sitter-wasms` package bundles WASM grammars for all major languages. This avoids requiring native compilation of individual `tree-sitter-{lang}` packages. The `tree-sitter` package itself ships a WASM-based runtime since v0.22.

### 2.4 Integration Points

- **repo-map-builder.ts**: `buildRepoMap()` calls `extractSymbolsAST()` instead of `extractSymbols()` for richer symbol info (docstrings, parameters, exact ranges). Falls back transparently.
- **SemanticStore**: The `CodeChunk` output from `chunkByAST()` feeds directly into `SemanticStore.upsert()` for code search. Each chunk's `id` becomes the vector entry ID, `content` becomes the text.
- **code-gen-service.ts**: Can use AST parsing to understand generated code structure for validation.
- **convention-detector.ts**: Can use AST symbols to detect naming conventions more accurately.

### 2.5 Query File Format

Tree-sitter query files (`.scm`) use S-expression syntax. Example for TypeScript:

```scheme
;; typescript.scm -- DzipAgent symbol extraction queries

;; Functions
(function_declaration
  name: (identifier) @function.name) @function.def

;; Arrow functions assigned to const
(lexical_declaration
  (variable_declarator
    name: (identifier) @function.name
    value: (arrow_function))) @function.def

;; Classes
(class_declaration
  name: (type_identifier) @class.name) @class.def

;; Methods
(method_definition
  name: (property_identifier) @method.name) @method.def

;; Interfaces
(interface_declaration
  name: (type_identifier) @interface.name) @interface.def

;; Type aliases
(type_alias_declaration
  name: (type_identifier) @type.name) @type.def

;; Enums
(enum_declaration
  name: (identifier) @enum.name) @enum.def
```

These query files are loaded at runtime and cached per language. They ship as static assets in the codegen package dist.

---

## Stream 3: DuckDB-WASM Analytics

**Priority**: P1
**Rationale**: memory-ipc produces Arrow Tables (21-column schema, multiple frame types). Currently there is no way to run analytical queries over this data. DuckDB-WASM can query Arrow Tables directly with SQL, returning Arrow Tables -- zero serialization overhead. This enables memory analytics (decay trends, namespace stats, token usage patterns) and agent performance dashboards.

### ADR-013: DuckDB-WASM for Arrow Analytics

**Context**: memory-ipc builds Arrow Tables but provides no analytical query capability. Users want decay trend analysis, namespace usage stats, and agent performance metrics.

**Decision**: Add an analytics module in `@dzipagent/memory-ipc` (not core) that uses DuckDB-WASM to run SQL queries over Arrow Tables. This keeps the core dependency-free and leverages memory-ipc's existing Arrow dependency.

**Constraints**:
- `@duckdb/duckdb-wasm` is an optional peer dep of memory-ipc
- DuckDB instance is initialized lazily on first query
- All queries accept Arrow Tables and return Arrow Tables (zero-copy round-trip)
- Module exports a high-level `MemoryAnalytics` class with pre-built queries

### 3.1 Interface Contract

```typescript
// File: packages/forgeagent-memory-ipc/src/analytics/duckdb-engine.ts

import type { Table } from 'apache-arrow'

/** Result of a DuckDB analytics query */
export interface AnalyticsResult<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Result as Arrow Table (zero-copy) */
  arrowTable: Table
  /** Result as plain JS objects (materialized from Arrow) */
  rows: T[]
  /** Query execution time in milliseconds */
  executionMs: number
  /** Number of rows in result */
  rowCount: number
}

/**
 * DuckDB-WASM query engine for Arrow Table analytics.
 *
 * Lazily initializes a DuckDB-WASM instance. Registers Arrow Tables
 * as virtual tables for zero-copy SQL queries.
 *
 * @example
 * ```ts
 * const engine = await DuckDBEngine.create()
 * const result = await engine.query(memoryTable, `
 *   SELECT namespace, COUNT(*) as count, AVG(decay_strength) as avg_strength
 *   FROM memory
 *   GROUP BY namespace
 *   ORDER BY count DESC
 * `)
 * console.log(result.rows)
 * ```
 */
export class DuckDBEngine {
  /**
   * Create and initialize the DuckDB-WASM engine.
   * Throws ForgeError('MISSING_PEER_DEP') if @duckdb/duckdb-wasm is not installed.
   */
  static async create(): Promise<DuckDBEngine>

  /**
   * Run a SQL query against an Arrow Table.
   *
   * The table is registered as a virtual table named 'memory' (or custom alias).
   * Query must reference this table name.
   *
   * @param table - Arrow Table to query
   * @param sql - SQL query string
   * @param alias - Virtual table name (default: 'memory')
   */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    table: Table,
    sql: string,
    alias?: string,
  ): Promise<AnalyticsResult<T>>

  /**
   * Run a SQL query against multiple Arrow Tables.
   * Tables are registered with the provided aliases.
   */
  queryMulti<T extends Record<string, unknown> = Record<string, unknown>>(
    tables: Map<string, Table>,
    sql: string,
  ): Promise<AnalyticsResult<T>>

  /** Release DuckDB-WASM resources */
  close(): Promise<void>
}
```

```typescript
// File: packages/forgeagent-memory-ipc/src/analytics/memory-analytics.ts

import type { Table } from 'apache-arrow'
import type { AnalyticsResult } from './duckdb-engine.js'

/** Decay trend data point */
export interface DecayTrendPoint {
  namespace: string
  bucket: string  // time bucket (hour/day)
  avg_strength: number
  min_strength: number
  max_strength: number
  count: number
}

/** Namespace usage statistics */
export interface NamespaceStats {
  namespace: string
  total_memories: number
  active_memories: number
  avg_strength: number
  avg_importance: number
  oldest_created: number  // epoch ms
  newest_created: number  // epoch ms
}

/** Agent performance metrics */
export interface AgentPerformance {
  agent_id: string
  total_memories: number
  avg_importance: number
  categories: string[]
  active_ratio: number
}

/**
 * Pre-built analytical queries for DzipAgent memory data.
 *
 * Wraps DuckDBEngine with domain-specific queries. All methods accept
 * an Arrow Table (from FrameBuilder.toTable()) and return typed results.
 */
export class MemoryAnalytics {
  /**
   * Create analytics instance. Lazily initializes DuckDB-WASM on first query.
   */
  static async create(): Promise<MemoryAnalytics>

  /** Decay strength trends grouped by namespace and time bucket */
  decayTrends(
    table: Table,
    bucketSize: 'hour' | 'day' | 'week',
  ): Promise<AnalyticsResult<DecayTrendPoint>>

  /** Per-namespace usage statistics */
  namespaceStats(table: Table): Promise<AnalyticsResult<NamespaceStats>>

  /** Per-agent performance metrics */
  agentPerformance(table: Table): Promise<AnalyticsResult<AgentPerformance>>

  /** Memories expiring within the given window (milliseconds from now) */
  expiringMemories(
    table: Table,
    windowMs: number,
  ): Promise<AnalyticsResult<{ id: string; namespace: string; decay_strength: number; expires_in_ms: number }>>

  /** Run a custom SQL query against a memory table */
  custom<T extends Record<string, unknown>>(
    table: Table,
    sql: string,
  ): Promise<AnalyticsResult<T>>

  /** Release resources */
  close(): Promise<void>
}
```

### 3.2 Tasks

| ID | Task | Files | Estimate |
|----|------|-------|----------|
| DK-001 | Create `duckdb-engine.ts` with lazy WASM init and Arrow Table registration | `memory-ipc/src/analytics/duckdb-engine.ts` | 4h |
| DK-002 | Create `memory-analytics.ts` with pre-built queries | `memory-ipc/src/analytics/memory-analytics.ts` | 3h |
| DK-003 | Create analytics barrel export | `memory-ipc/src/analytics/index.ts` | 0.5h |
| DK-004 | Add `@duckdb/duckdb-wasm` as optional peer dep | `memory-ipc/package.json` | 0.5h |
| DK-005 | Update memory-ipc barrel export | `memory-ipc/src/index.ts` | 0.5h |
| DK-006 | Write tests for DuckDBEngine | `memory-ipc/src/__tests__/duckdb-engine.test.ts` | 3h |
| DK-007 | Write tests for MemoryAnalytics | `memory-ipc/src/__tests__/memory-analytics.test.ts` | 3h |

### 3.3 Dependencies to Add

```jsonc
// packages/forgeagent-memory-ipc/package.json
{
  "peerDependencies": {
    "@duckdb/duckdb-wasm": ">=1.29.0"  // ADD
  },
  "peerDependenciesMeta": {
    "@duckdb/duckdb-wasm": { "optional": true }  // ADD
  }
}
```

### 3.4 Integration Points

- **memory-ipc FrameBuilder**: `FrameBuilder.toTable()` output feeds directly into `DuckDBEngine.query()`
- **server memory API**: Server routes can expose `/api/memory/analytics` endpoints that use `MemoryAnalytics`
- **otel package**: `DzipTracer` can dump span data as Arrow Tables for DuckDB analysis
- **playground**: Vue dashboard can fetch analytics results for visualization

---

## Stream 4: Drizzle pgvector Enhancement

**Priority**: P1
**Rationale**: The existing `PgVectorAdapter` in core uses raw parameterized SQL. The server package uses Drizzle ORM for all other persistence. Having two query patterns (raw SQL for vectors, Drizzle for everything else) creates maintenance burden and prevents type-safe vector operations on agent/run tables. Drizzle 0.40+ has first-class pgvector support via `drizzle-orm/pg-core`.

### ADR-014: Drizzle pgvector Column Types in Server Schema

**Context**: `dzip_agents` and `forge_runs` tables use Drizzle. Vector operations use raw SQL via `PgVectorAdapter`. We want type-safe vector columns on existing tables (e.g., agent instruction embeddings, run output embeddings) without duplicating data to a separate vector store.

**Decision**: Add vector columns to the server Drizzle schema using `customType` for pgvector. Create a `vector-ops.ts` module that wraps Drizzle's SQL template for cosine distance, L2 distance, and inner product operations. This does NOT replace `PgVectorAdapter` in core (which remains ORM-agnostic) -- it adds Drizzle-native vector operations to the server layer only.

**Constraints**:
- Requires `pgvector` PostgreSQL extension (migration handles `CREATE EXTENSION IF NOT EXISTS vector`)
- Vector dimension is fixed per column at schema definition time
- Does not introduce a core -> drizzle dependency (server-only)

### 4.1 Interface Contract

```typescript
// File: packages/forgeagent-server/src/persistence/vector-column.ts

import { customType } from 'drizzle-orm/pg-core'

/**
 * Custom Drizzle column type for pgvector's `vector` type.
 *
 * @param dimensions - Fixed dimensionality of the vector
 *
 * @example
 * ```ts
 * const table = pgTable('my_table', {
 *   embedding: vectorColumn('embedding', { dimensions: 1536 }),
 * })
 * ```
 */
export function vectorColumn(name: string, config: { dimensions: number }): ReturnType<typeof customType>
```

```typescript
// File: packages/forgeagent-server/src/persistence/vector-ops.ts

import type { SQL } from 'drizzle-orm'

/**
 * Cosine distance between a column and a query vector.
 * Maps to pgvector's `<=>` operator.
 * Lower values = more similar.
 */
export function cosineDistance(column: unknown, queryVector: number[]): SQL

/**
 * L2 (Euclidean) distance between a column and a query vector.
 * Maps to pgvector's `<->` operator.
 */
export function l2Distance(column: unknown, queryVector: number[]): SQL

/**
 * Negative inner product between a column and a query vector.
 * Maps to pgvector's `<#>` operator.
 */
export function innerProduct(column: unknown, queryVector: number[]): SQL

/**
 * SQL fragment to cast a number array to a pgvector value.
 */
export function toVector(values: number[]): SQL
```

### 4.2 Updated Schema

```typescript
// Additions to packages/forgeagent-server/src/persistence/drizzle-schema.ts

import { vectorColumn } from './vector-column.js'

// Add to dzipAgents table:
//   instructionEmbedding: vectorColumn('instruction_embedding', { dimensions: 1536 }),

// Add to forgeRuns table:
//   inputEmbedding: vectorColumn('input_embedding', { dimensions: 1536 }),
//   outputEmbedding: vectorColumn('output_embedding', { dimensions: 1536 }),

// New table for general-purpose vector storage via Drizzle
export const forgeVectors = pgTable('forge_vectors', {
  id: uuid('id').defaultRandom().primaryKey(),
  collection: varchar('collection', { length: 255 }).notNull(),
  embedding: vectorColumn('embedding', { dimensions: 1536 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  text: text('text'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

### 4.3 Tasks

| ID | Task | Files | Estimate |
|----|------|-------|----------|
| PG-001 | Create `vector-column.ts` custom Drizzle type | `server/src/persistence/vector-column.ts` | 2h |
| PG-002 | Create `vector-ops.ts` distance functions | `server/src/persistence/vector-ops.ts` | 2h |
| PG-003 | Add vector columns to `dzipAgents` and `forgeRuns` | `server/src/persistence/drizzle-schema.ts` | 1h |
| PG-004 | Add `forgeVectors` table for general vector storage | `server/src/persistence/drizzle-schema.ts` | 1h |
| PG-005 | Create Drizzle migration for pgvector extension + new columns | `server/drizzle/` migration file | 1h |
| PG-006 | Write tests for vector-column and vector-ops | `server/src/__tests__/vector-ops.test.ts` | 3h |

### 4.4 Dependencies

No new dependencies. `drizzle-orm` already supports custom types. The `pgvector` PostgreSQL extension must be installed on the database server (standard for Supabase, Neon, Railway).

### 4.5 Integration Points

- **Server memory routes**: Can use Drizzle vector ops for semantic search on agent instructions ("find agents similar to X")
- **Run search**: Embed run inputs/outputs for semantic search across execution history
- **PgVectorAdapter in core**: Remains unchanged -- it uses raw SQL and is ORM-agnostic. The server can use either approach depending on context.

---

## Stream 5: Copy-on-Write VFS Snapshots

**Priority**: P2
**Rationale**: The current VirtualFS is a flat `Map<string, string>` with no branching capability. `toSnapshot()` deep-copies the entire map. For parallel agent execution (parallel sampling, speculative edits), we need efficient forking where a branch shares unchanged files with its parent. The checkpoint-manager.ts handles filesystem checkpoints via shadow git repos but operates on the real filesystem, not the VFS.

### ADR-015: Copy-on-Write Forking for VirtualFS

**Context**: Parallel agent execution (e.g., try 3 different implementations, keep the best) requires forking the VFS cheaply. Current `toSnapshot()` copies all files. For a 500-file project, forking 3 times copies 1500 files instead of just tracking the deltas.

**Decision**: Extend `VirtualFS` with a `fork()` method that creates a copy-on-write child. The child shares the parent's file map by reference and only materializes writes. A `merge()` operation applies a child's changes back to the parent (or another target). A `conflicts()` check detects files modified in both parent and child since the fork point.

**Constraints**:
- Backward-compatible: existing VirtualFS API does not change
- Fork depth is limited (max 3 levels) to prevent memory issues
- Merge strategy is configurable (ours/theirs/manual)

### 5.1 Interface Contract

```typescript
// Additions to packages/forgeagent-codegen/src/vfs/virtual-fs.ts

/** Merge strategy when conflicts exist */
export type MergeStrategy = 'ours' | 'theirs' | 'manual'

/** A conflict detected during merge */
export interface MergeConflict {
  path: string
  parentContent: string
  childContent: string
  /** Content at fork point */
  baseContent: string
}

/** Result of a merge operation */
export interface MergeResult {
  /** Whether the merge completed without conflicts */
  clean: boolean
  /** Files that were merged */
  merged: string[]
  /** Conflicts (only populated when strategy is 'manual') */
  conflicts: MergeConflict[]
}

export class VirtualFS {
  // ... existing API unchanged ...

  /**
   * Create a copy-on-write fork of this VFS.
   *
   * The fork shares the parent's files by reference. Writes to the fork
   * only affect the fork. Reads fall through to the parent for unmodified files.
   *
   * @param label - Human-readable label for debugging (e.g., "attempt-1")
   * @throws if fork depth exceeds MAX_FORK_DEPTH (3)
   */
  fork(label?: string): VirtualFS

  /**
   * Check if this VFS is a fork (has a parent).
   */
  get isFork(): boolean

  /**
   * Get files modified in this fork relative to its parent.
   * Returns empty array if this is not a fork.
   */
  forkDelta(): FileDiff[]

  /**
   * Detect conflicts between this fork and another fork (or parent updates).
   */
  conflicts(other: VirtualFS): MergeConflict[]

  /**
   * Merge a child fork's changes into this VFS.
   *
   * @param child - A fork of this VFS (or any VFS)
   * @param strategy - How to handle conflicts
   * @returns Merge result with applied changes and any conflicts
   */
  merge(child: VirtualFS, strategy?: MergeStrategy): MergeResult

  /**
   * Detach this fork from its parent, materializing all inherited files.
   * After detach, this VFS is standalone and the parent reference is dropped.
   */
  detach(): void
}
```

### 5.2 Tasks

| ID | Task | Files | Estimate |
|----|------|-------|----------|
| COW-001 | Implement CoW fork layer in VirtualFS (parent reference, write overlay, read fall-through) | `codegen/src/vfs/virtual-fs.ts` | 4h |
| COW-002 | Implement `forkDelta()` and `conflicts()` | `codegen/src/vfs/virtual-fs.ts` | 2h |
| COW-003 | Implement `merge()` with ours/theirs/manual strategies | `codegen/src/vfs/virtual-fs.ts` | 3h |
| COW-004 | Implement `detach()` for materializing inherited files | `codegen/src/vfs/virtual-fs.ts` | 1h |
| COW-005 | Add fork depth guard (MAX_FORK_DEPTH = 3) | `codegen/src/vfs/virtual-fs.ts` | 0.5h |
| COW-006 | Write tests for fork/merge/conflict scenarios | `codegen/src/__tests__/vfs-cow.test.ts` | 4h |
| COW-007 | Integration: wire fork into parallel sampling in pipeline | `codegen/src/pipeline/` | 2h |

### 5.3 Dependencies

No new dependencies. Pure TypeScript implementation.

### 5.4 Integration Points

- **Pipeline parallel sampling**: Fork VFS for each candidate implementation, run in parallel, merge the winner
- **Fix escalation**: Fork before applying a fix, merge only if tests pass
- **Sandbox**: Each sandbox execution gets a forked VFS, isolated from the main pipeline state
- **CheckpointManager**: Can snapshot fork state rather than full VFS copies

### 5.5 Internal Implementation Notes

The CoW layer works as follows:

```
VirtualFS (root)
  files: Map<string, string>    // "src/a.ts" -> content, "src/b.ts" -> content
  parent: null
  writes: null

VirtualFS (fork-1)
  files: Map<string, string>    // empty initially
  parent: -> root               // reference to parent
  writes: Set<string>           // tracks which paths were written in this fork
  deletes: Set<string>          // tracks which paths were deleted in this fork
  forkPoint: Map<string, string>  // snapshot of parent files at fork time (lazy, only for conflict detection)
```

`read(path)`:
1. If `deletes.has(path)` return null
2. If `files.has(path)` return files.get(path)
3. If `parent` return parent.read(path)
4. Return null

`write(path, content)`:
1. `files.set(path, content)`
2. `writes.add(path)`
3. `deletes.delete(path)`

`list()`:
1. Merge parent.list() with own files keys
2. Subtract deletes

---

## Stream 6: Turbopuffer Adapter

**Priority**: P2
**Rationale**: Turbopuffer is object-storage-backed (S3), making it 10-50x cheaper than Pinecone/Qdrant for large-scale vector storage. Cursor uses it for their codebase indexing. Relevant for SaaS deployments with many tenants and large memory stores.

### ADR-016: Turbopuffer as Cost-Effective Scale Adapter

**Context**: For multi-tenant SaaS deployments, dedicated vector DB infrastructure (Qdrant, Pinecone) can be expensive. Turbopuffer's object-storage architecture reduces cost at scale.

**Decision**: Add a `TurbopufferAdapter` implementing `VectorStore`. Lower priority than LanceDB (which covers the embedded use case). Turbopuffer covers the hosted-at-scale use case.

### 6.1 Interface Contract

```typescript
// File: packages/forgeagent-core/src/vectordb/adapters/turbopuffer-adapter.ts

import type {
  VectorStore,
  CollectionConfig,
  VectorEntry,
  VectorQuery,
  VectorSearchResult,
  VectorDeleteFilter,
  VectorStoreHealth,
} from '../types.js'

/** Configuration for the Turbopuffer adapter */
export interface TurbopufferAdapterConfig {
  /** Turbopuffer API key */
  apiKey: string
  /** Base URL (default: https://api.turbopuffer.com) */
  baseUrl?: string
  /** Namespace prefix for multi-tenant isolation */
  namespacePrefix?: string
}

/**
 * Turbopuffer vector store adapter.
 *
 * Object-storage-backed vector database. Cost-effective at scale.
 * Uses Turbopuffer's REST API with batch operations.
 */
export class TurbopufferAdapter implements VectorStore {
  readonly provider = 'turbopuffer'

  constructor(config: TurbopufferAdapterConfig)

  // Full VectorStore interface implementation
  createCollection(name: string, config: CollectionConfig): Promise<void>
  deleteCollection(name: string): Promise<void>
  listCollections(): Promise<string[]>
  collectionExists(name: string): Promise<boolean>
  upsert(collection: string, entries: VectorEntry[]): Promise<void>
  search(collection: string, query: VectorQuery): Promise<VectorSearchResult[]>
  delete(collection: string, filter: VectorDeleteFilter): Promise<void>
  count(collection: string): Promise<number>
  healthCheck(): Promise<VectorStoreHealth>
  close(): Promise<void>
}
```

### 6.2 Tasks

| ID | Task | Files | Estimate |
|----|------|-------|----------|
| TP-001 | Create `turbopuffer-adapter.ts` implementing `VectorStore` | `core/src/vectordb/adapters/turbopuffer-adapter.ts` | 4h |
| TP-002 | Implement filter translation for Turbopuffer's query format | Same file | 2h |
| TP-003 | Register in adapter barrel and vectordb barrel | `core/src/vectordb/adapters/index.ts`, `core/src/vectordb/index.ts` | 0.5h |
| TP-004 | Add to auto-detection (TURBOPUFFER_API_KEY) | `core/src/vectordb/auto-detect.ts` | 1h |
| TP-005 | Write tests with mocked HTTP responses | `core/src/vectordb/__tests__/turbopuffer-adapter.test.ts` | 3h |

### 6.3 Dependencies

No new package dependencies. Turbopuffer uses a plain REST API (native `fetch()`), same as the Qdrant adapter pattern.

---

## Dependency Graph

```
Stream 1 (LanceDB)  ──────────── P0, no blockers
Stream 2 (Tree-sitter) ───────── P0, no blockers
   (Streams 1 and 2 can execute in parallel)

Stream 3 (DuckDB-WASM) ───────── P1, no blockers (independent of Streams 1-2)
Stream 4 (Drizzle pgvector) ──── P1, no blockers (independent of Streams 1-3)
   (Streams 3 and 4 can execute in parallel)

Stream 5 (CoW VFS) ───────────── P2, no blockers
Stream 6 (Turbopuffer) ───────── P2, no blockers
   (Streams 5 and 6 can execute in parallel)
```

All 6 streams are independent. The priority ordering reflects value:
- **P0**: LanceDB + Tree-sitter close the two biggest capability gaps
- **P1**: DuckDB analytics + Drizzle pgvector improve existing subsystems
- **P2**: CoW VFS + Turbopuffer are optimization/scale concerns

### Execution Phases

**Phase A (P0)**: Streams 1 + 2 in parallel. ~2 developer-weeks.
**Phase B (P1)**: Streams 3 + 4 in parallel. ~1 developer-week.
**Phase C (P2)**: Streams 5 + 6 in parallel. ~1.5 developer-weeks.

Total estimate: ~4.5 developer-weeks.

---

## ADRs

### Summary of Architecture Decisions

| ADR | Title | Status |
|-----|-------|--------|
| ADR-011 | LanceDB as Embedded Vector Store | Proposed |
| ADR-012 | Tree-Sitter AST Parsing in Codegen | Proposed |
| ADR-013 | DuckDB-WASM for Arrow Analytics | Proposed |
| ADR-014 | Drizzle pgvector Column Types in Server | Proposed |
| ADR-015 | Copy-on-Write Forking for VirtualFS | Proposed |
| ADR-016 | Turbopuffer as Cost-Effective Scale Adapter | Proposed |

### Validation Checklist (all streams)

- [x] Core imports nothing from agent/codegen/server
- [x] No circular dependencies (LanceDB in core, Tree-sitter in codegen, DuckDB in memory-ipc, pgvector in server)
- [x] TypeScript strict mode (no `any` -- all interfaces use proper generics and discriminated unions)
- [x] Works with InMemoryStore (all adapters are alternatives, not replacements)
- [x] Public API is minimal (adapter + config type per stream)
- [x] All new deps are optional peer deps with dynamic import()
- [x] Breaking changes: NONE. All additions are additive.

---

## File Inventory

### New Files (18)

| # | File | Package | Stream |
|---|------|---------|--------|
| 1 | `src/vectordb/adapters/lancedb-adapter.ts` | core | 1 |
| 2 | `src/vectordb/__tests__/lancedb-adapter.test.ts` | core | 1 |
| 3 | `src/repomap/tree-sitter-extractor.ts` | codegen | 2 |
| 4 | `src/repomap/queries/typescript.scm` | codegen | 2 |
| 5 | `src/repomap/queries/python.scm` | codegen | 2 |
| 6 | `src/repomap/queries/go.scm` | codegen | 2 |
| 7 | `src/repomap/queries/rust.scm` | codegen | 2 |
| 8 | `src/repomap/queries/java.scm` | codegen | 2 |
| 9 | `src/chunking/ast-chunker.ts` | codegen | 2 |
| 10 | `src/chunking/index.ts` | codegen | 2 |
| 11 | `src/__tests__/tree-sitter-extractor.test.ts` | codegen | 2 |
| 12 | `src/__tests__/ast-chunker.test.ts` | codegen | 2 |
| 13 | `src/analytics/duckdb-engine.ts` | memory-ipc | 3 |
| 14 | `src/analytics/memory-analytics.ts` | memory-ipc | 3 |
| 15 | `src/analytics/index.ts` | memory-ipc | 3 |
| 16 | `src/__tests__/duckdb-engine.test.ts` | memory-ipc | 3 |
| 17 | `src/__tests__/memory-analytics.test.ts` | memory-ipc | 3 |
| 18 | `src/persistence/vector-column.ts` | server | 4 |
| 19 | `src/persistence/vector-ops.ts` | server | 4 |
| 20 | `src/__tests__/vector-ops.test.ts` | server | 4 |
| 21 | `src/vectordb/adapters/turbopuffer-adapter.ts` | core | 6 |
| 22 | `src/vectordb/__tests__/turbopuffer-adapter.test.ts` | core | 6 |
| 23 | `src/__tests__/vfs-cow.test.ts` | codegen | 5 |

### Modified Files (10)

| # | File | Package | Stream |
|---|------|---------|--------|
| 1 | `src/vectordb/adapters/index.ts` | core | 1, 6 |
| 2 | `src/vectordb/index.ts` | core | 1, 6 |
| 3 | `src/vectordb/auto-detect.ts` | core | 1, 6 |
| 4 | `package.json` | core | 1, 6 |
| 5 | `src/repomap/symbol-extractor.ts` | codegen | 2 |
| 6 | `src/repomap/index.ts` | codegen | 2 |
| 7 | `src/repomap/repo-map-builder.ts` | codegen | 2 |
| 8 | `package.json` | codegen | 2 |
| 9 | `src/index.ts` | memory-ipc | 3 |
| 10 | `package.json` | memory-ipc | 3 |
| 11 | `src/persistence/drizzle-schema.ts` | server | 4 |
| 12 | `src/vfs/virtual-fs.ts` | codegen | 5 |
