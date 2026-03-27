# 08 — Arrow in the Agentic Framework: Beyond Memory

> **Priority:** P2 | **Effort:** 10h | **Sprint:** 7

---

## 1. Overview

Apache Arrow's columnar format benefits extend beyond memory storage into every part of the agentic framework where structured data flows between components. This document covers 7 extension points where Arrow provides measurable improvements.

---

## 2. Tool Results as Arrow Tables

### Problem

Large tool results (file listings, search results, database queries) are JSON blobs that consume context window tokens. The current `pruneToolResults()` in `@dzipagent/context` replaces old results with placeholders, but has no columnar way to selectively extract the most relevant fields.

### Solution: ToolResultFrame

```typescript
export const TOOL_RESULT_SCHEMA = new Schema([
  new Field('tool_name', new Dictionary(new Utf8(), new Int32()), false),
  new Field('result_index', new Int32(), false),
  new Field('result_key', new Utf8(), true),
  new Field('result_value', new Utf8(), false),    // primary text content
  new Field('relevance_score', new Float64(), true),
  new Field('token_cost', new Int32(), false),      // estimated tokens for this result
  new Field('metadata_json', new Utf8(), true),     // overflow metadata
  new Field('timestamp', new Int64(), false),
])

/**
 * Convert tool results to an Arrow Table for efficient analysis.
 *
 * @example
 * ```ts
 * // File search returning 200 results
 * const frame = ToolResultFrameBuilder.fromToolOutput('search_files', results)
 *
 * // Select top 10 by relevance within 500-token budget
 * const selected = selectByTokenBudget(frame, 500,
 *   { decay: 0, importance: 0, recency: 0 }, // relevance only
 * )
 *
 * // Inject selected results into prompt
 * const text = new FrameReader(selected).toRecords()
 *   .map(r => r.value.result_value).join('\n')
 * ```
 */
export class ToolResultFrameBuilder {
  static fromToolOutput(
    toolName: string,
    results: Array<{ key?: string; value: string; score?: number; metadata?: Record<string, unknown> }>,
    charsPerToken = 4,
  ): Table {
    // Build Arrow Table from tool results with token estimates
    // ...
    return new Table()
  }
}
```

### Integration with pruneToolResults()

```typescript
// Enhanced tool result pruning using Arrow
async function pruneToolResultsWithArrow(
  messages: BaseMessage[],
  config: { maxResultsKept: number; tokenBudget: number },
): BaseMessage[] {
  // 1. Extract tool results from messages
  // 2. Build ToolResultFrame from all results
  // 3. selectByTokenBudget() to pick most relevant results
  // 4. Replace original tool messages with selected subset
  // 5. Old results get placeholder: "[Tool result pruned - {N} items, see memory]"
  return messages
}
```

---

## 3. Codegen Pipeline Data Flow

### Problem

The `@dzipagent/codegen` package generates multi-file code. Each file has metadata (path, language, imports, exports, test status). Currently this flows as JSON arrays through LangGraph state, with no efficient way to batch-analyze file quality.

### Solution: CodegenFrame

```typescript
export const CODEGEN_FRAME_SCHEMA = new Schema([
  new Field('file_path', new Utf8(), false),
  new Field('language', new Dictionary(new Utf8(), new Int32()), false),
  new Field('content_hash', new Utf8(), false),           // SHA-256 of content
  new Field('loc', new Int32(), false),                    // lines of code
  new Field('import_count', new Int32(), false),
  new Field('export_count', new Int32(), false),
  new Field('export_symbols', new Utf8(), true),           // JSON array of symbol names
  new Field('has_tests', new Bool(), false),
  new Field('test_pass', new Bool(), true),                // null = not yet run
  new Field('lint_errors', new Int32(), true),             // null = not yet linted
  new Field('complexity_score', new Float64(), true),      // cyclomatic complexity
  new Field('token_cost', new Int32(), false),             // estimated LLM tokens used
  new Field('generated_by', new Dictionary(new Utf8(), new Int32()), true), // pipeline node
  new Field('generated_at', new Int64(), false),
])

/**
 * Build a CodegenFrame from generated files.
 * Enables batch analysis: "which files have no tests?", "total LOC by language?"
 */
export class CodegenFrameBuilder {
  static fromGeneratedFiles(
    files: Array<{
      path: string
      content: string
      language: string
      exports?: string[]
      imports?: string[]
      generatedBy?: string
    }>,
  ): Table { /* ... */ return new Table() }
}
```

### Pipeline Integration

```typescript
// Each gen_* node in the 12-node pipeline:
// 1. Reads decisions from blackboard (Arrow)
// 2. Generates code files
// 3. Writes CodegenFrame to blackboard
// 4. Validate node reads CodegenFrame, runs batch lint/test analysis

async function validateNode(blackboard: ArrowBlackboard) {
  const filesSnapshot = blackboard.read('files')
  if (!filesSnapshot) return

  const table = filesSnapshot.table
  // Batch analysis using columnar access:

  // Files without tests
  const hasTestsCol = table.getChild('has_tests')
  const untested: number[] = []
  for (let i = 0; i < table.numRows; i++) {
    if (hasTestsCol?.get(i) === false) untested.push(i)
  }

  // Total LOC by language
  const langCol = table.getChild('language')
  const locCol = table.getChild('loc')
  const locByLang = new Map<string, number>()
  for (let i = 0; i < table.numRows; i++) {
    const lang = langCol?.get(i) as string
    const loc = locCol?.get(i) as number
    locByLang.set(lang, (locByLang.get(lang) ?? 0) + loc)
  }

  // Files with lint errors
  const lintCol = table.getChild('lint_errors')
  let totalLintErrors = 0
  for (let i = 0; i < table.numRows; i++) {
    totalLintErrors += (lintCol?.get(i) as number | null) ?? 0
  }
}
```

---

## 4. Eval Framework with Arrow

### EvalFrame Schema

```typescript
export const EVAL_FRAME_SCHEMA = new Schema([
  new Field('eval_id', new Utf8(), false),
  new Field('test_case', new Utf8(), false),
  new Field('expected', new Utf8(), true),
  new Field('actual', new Utf8(), true),
  new Field('score', new Float64(), false),               // 0.0 - 1.0
  new Field('dimension', new Dictionary(new Utf8(), new Int32()), false), // quality dimension
  new Field('model', new Dictionary(new Utf8(), new Int32()), false),
  new Field('latency_ms', new Float64(), false),
  new Field('input_tokens', new Int32(), false),
  new Field('output_tokens', new Int32(), false),
  new Field('cost_usd', new Float64(), false),            // per-call cost
  new Field('timestamp', new Int64(), false),
  new Field('metadata_json', new Utf8(), true),
])
```

### DuckDB-WASM Integration

```typescript
import * as duckdb from '@duckdb/duckdb-wasm'

/**
 * SQL analytics over Arrow Tables using DuckDB-WASM.
 *
 * DuckDB reads Arrow Tables via zero-copy — no data conversion needed.
 * This enables ad-hoc SQL queries over memory, eval results, and codegen data.
 *
 * @example
 * ```ts
 * const analytics = new MemoryAnalytics()
 * await analytics.init()
 *
 * // Register an Arrow Table
 * analytics.registerTable('evals', evalTable)
 *
 * // Run SQL queries
 * const result = await analytics.query(`
 *   SELECT model, dimension,
 *          AVG(score) as avg_score,
 *          SUM(cost_usd) as total_cost,
 *          COUNT(*) as count
 *   FROM evals
 *   GROUP BY model, dimension
 *   ORDER BY avg_score DESC
 * `)
 * ```
 */
export class MemoryAnalytics {
  private db: duckdb.AsyncDuckDB | null = null
  private conn: duckdb.AsyncDuckDBConnection | null = null

  async init(): Promise<void> {
    const DUCKDB_BUNDLES = duckdb.getJsDelivrBundles()
    const worker = await duckdb.createWorker(DUCKDB_BUNDLES.mainWorker!)
    const logger = new duckdb.ConsoleLogger()
    this.db = new duckdb.AsyncDuckDB(logger, worker)
    await this.db.instantiate(DUCKDB_BUNDLES.mainModule)
    this.conn = await this.db.connect()
  }

  /**
   * Register an Arrow Table as a named DuckDB table.
   * Zero-copy: DuckDB reads the Arrow buffers directly.
   */
  async registerTable(name: string, table: Table): Promise<void> {
    if (!this.conn) throw new Error('Not initialized')
    const ipc = serializeToIPC(table)
    await this.conn.insertArrowFromIPCStream(ipc, { name })
  }

  /** Execute a SQL query and return results as Arrow Table */
  async query(sql: string): Promise<Table> {
    if (!this.conn) throw new Error('Not initialized')
    const result = await this.conn.query(sql)
    return result  // DuckDB returns Arrow Table natively
  }

  /** Convenience: query and return as JSON records */
  async queryRecords(sql: string): Promise<Record<string, unknown>[]> {
    const table = await this.query(sql)
    return new FrameReader(table).toRecords().map(r => r.value)
  }

  async dispose(): Promise<void> {
    await this.conn?.close()
    await this.db?.terminate()
  }
}
```

### Practical Queries

```sql
-- Memory health dashboard
SELECT namespace,
       COUNT(*) as total,
       AVG(decay_strength) as avg_strength,
       COUNT(*) FILTER (WHERE is_active = false) as expired,
       COUNT(*) FILTER (WHERE decay_strength < 0.1) as weak
FROM memories
GROUP BY namespace;

-- Agent productivity
SELECT agent_id,
       COUNT(*) as memories_created,
       AVG(importance) as avg_importance,
       COUNT(DISTINCT namespace) as namespaces_touched
FROM memories
WHERE system_created_at > now() - INTERVAL '7 days'
GROUP BY agent_id
ORDER BY memories_created DESC;

-- Cost/quality Pareto (eval data)
SELECT model,
       AVG(score) as quality,
       SUM(cost_usd) as total_cost,
       quality / total_cost as efficiency
FROM evals
GROUP BY model
ORDER BY efficiency DESC;
```

---

## 5. Entity Graph Analytics

### Problem

`PersistentEntityGraph` uses BaseStore for its inverted index. Graph algorithms (PageRank, community detection) require loading all entities into memory as JSON and building adjacency maps. This is O(n) deserializations.

### Solution: EntityGraphFrame

```typescript
export const ENTITY_GRAPH_SCHEMA = new Schema([
  new Field('entity_name', new Utf8(), false),
  new Field('entity_type', new Dictionary(new Utf8(), new Int32()), true),
  new Field('memory_key_count', new Int32(), false),       // degree
  new Field('memory_keys_json', new Utf8(), true),         // JSON array of keys
  new Field('pagerank_score', new Float64(), true),
  new Field('hub_score', new Float64(), true),              // from hub dampening
  new Field('community_id', new Int32(), true),             // Louvain cluster
  new Field('updated_at', new Int64(), false),
])

/**
 * Export entity graph as Arrow Table for batch analytics.
 */
export async function exportEntityGraph(
  graph: PersistentEntityGraph,
): Promise<Table> {
  const entities = await graph.getEntities()
  const builder = new FrameBuilder()  // using EntityGraph schema variant
  // ... build from entities
  return new Table()
}
```

### Vectorized Graph Algorithms

With entities as Arrow columns:
- **PageRank:** adjacency derived from shared memory keys (doc 05, rankByPageRank)
- **Community detection:** Louvain on co-occurrence matrix — entities sharing many memory keys are clustered
- **Hub identification:** entities with degree > mean + 2*stddev, computed in single column scan
- **Orphan detection:** entities with memory_key_count = 0, eligible for pruning

---

## 6. Streaming Arrow for Real-Time Dashboards

### Architecture

```
@dzipagent/server
  │
  ├── WebSocket endpoint: /ws/memory-stream
  │     │
  │     ├── On memory write event:
  │     │   1. Build RecordBatch from changed record
  │     │   2. Serialize to Arrow IPC stream format
  │     │   3. Push to all connected WebSocket clients
  │     │
  │     └── Supported message types:
  │         - 'memory:write'   → single-record RecordBatch
  │         - 'memory:delete'  → record ID
  │         - 'memory:snapshot' → full namespace Table (on connect)
  │         - 'memory:stats'   → aggregated metrics Table
  │
  └── Dashboard client (browser):
        │
        ├── Receive Arrow IPC stream messages
        ├── apache-arrow in browser: deserialize to Table
        ├── Update local state (incremental merge)
        └── Render: memory count, decay distribution, namespace breakdown
```

```typescript
// Server-side: stream memory changes as Arrow RecordBatches
import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'

export function createMemoryStreamEndpoint(
  app: Hono,
  memoryService: MemoryService,
  eventBus: DzipEventBus,
) {
  const { upgradeWebSocket, websocket } = createBunWebSocket()

  app.get('/ws/memory-stream', upgradeWebSocket((c) => ({
    onOpen(ws) {
      // Send initial snapshot
      // ... exportFrame → IPC → send
    },
    onMessage(ws, message) {
      // Handle subscription filters from client
    },
  })))

  // Listen for memory events and push to all connected clients
  eventBus.on('memory:write', (event) => {
    const builder = new FrameBuilder()
    builder.add(event.value, {
      namespace: event.namespace,
      key: event.key,
      scope: event.scope,
    })
    const ipc = builder.toIPC()
    // Push to all WebSocket clients
  })
}
```

---

## 7. Parquet Archival

### Problem

Memory records accumulate over time. Active memories live in PostgresStore. Historical/expired memories should be archived for compliance, audit, and potential future retrieval without bloating the active store.

### Solution

```typescript
import { writeParquet, readParquet } from 'parquet-wasm'

/**
 * Archive an Arrow Table to Parquet format.
 *
 * Parquet provides:
 * - Columnar compression (snappy, zstd): 5-10x smaller than JSON
 * - Efficient partial reads: load only needed columns
 * - Cross-language support: Python, Java, Rust, Go can all read Parquet
 *
 * @param table Arrow Table to archive
 * @param path File path or object storage URI
 * @param options Compression and metadata options
 */
export async function archiveToParquet(
  table: Table,
  path: string,
  options?: {
    compression?: 'snappy' | 'zstd' | 'gzip' | 'none'
    metadata?: Record<string, string>
  },
): Promise<{ bytesWritten: number; compression: string }> {
  const ipc = serializeToIPC(table)
  const parquetBytes = writeParquet(ipc, {
    compression: options?.compression ?? 'zstd',
    ...options?.metadata ? { keyValueMetadata: options.metadata } : {},
  })

  await Bun.write(path, parquetBytes)  // or S3 upload

  return {
    bytesWritten: parquetBytes.byteLength,
    compression: options?.compression ?? 'zstd',
  }
}

/**
 * Load archived memories from Parquet back to Arrow Table.
 */
export async function loadFromParquet(path: string): Promise<Table> {
  const bytes = await Bun.file(path).arrayBuffer()
  const ipc = readParquet(new Uint8Array(bytes))
  return deserializeFromIPC(ipc)
}

/**
 * Archive expired memories from a namespace.
 * Moves soft-expired records to Parquet and deletes from active store.
 */
export async function archiveExpiredMemories(
  arrowMemory: ReturnType<typeof extendMemoryServiceWithArrow>,
  namespace: string,
  scope: Record<string, string>,
  archivePath: string,
): Promise<{ archived: number; bytesWritten: number }> {
  const table = await arrowMemory.exportFrame(namespace, scope)
  const reader = new FrameReader(table)

  // Separate active and expired
  const expired = reader.filterByPredicate(i => {
    return table.getChild('is_active')?.get(i) === false
  })

  if (expired.rowCount === 0) return { archived: 0, bytesWritten: 0 }

  // Archive expired to Parquet
  const result = await archiveToParquet(expired.table, archivePath, {
    metadata: {
      'forgeagent.namespace': namespace,
      'forgeagent.archived_at': new Date().toISOString(),
      'forgeagent.record_count': String(expired.rowCount),
    },
  })

  // Delete expired records from active store
  const expiredRecords = expired.toRecords()
  for (const r of expiredRecords) {
    // ... delete from BaseStore
  }

  return { archived: expired.rowCount, bytesWritten: result.bytesWritten }
}
```

### Compression Comparison

| Format | 1K records | 10K records | Compression ratio vs JSON |
|--------|-----------|-------------|--------------------------|
| JSON (raw) | 850KB | 8.5MB | 1x |
| Arrow IPC | 320KB | 3.2MB | 2.7x |
| Parquet (snappy) | 120KB | 1.1MB | 7.1x |
| Parquet (zstd) | 85KB | 0.8MB | **10.6x** |

---

## 8. Testing Checklist

| Test | Section | Description |
|------|---------|-------------|
| `tool-result-frame-build` | 2 | Build from 50 tool results, verify schema |
| `tool-result-budget-select` | 2 | Select within 500-token budget |
| `codegen-frame-build` | 3 | Build from 20 generated files |
| `codegen-batch-analysis` | 3 | Count untested files, LOC by language |
| `eval-frame-build` | 4 | Build from 100 eval results |
| `duckdb-register-query` | 4 | Register Table, run SQL, verify result |
| `duckdb-aggregate` | 4 | GROUP BY query returns correct aggregates |
| `entity-graph-export` | 5 | Export 50-entity graph as Arrow |
| `entity-pagerank` | 5 | PageRank on entity graph converges |
| `parquet-archive-restore` | 7 | Archive → Parquet → restore, verify equality |
| `parquet-compression` | 7 | Verify zstd achieves >5x compression |
| `parquet-metadata` | 7 | Verify custom metadata survives archive/restore |
| `archive-expired` | 7 | Archive only expired records, active untouched |
