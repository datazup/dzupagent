# 04 — Inter-Agent Memory Sharing Patterns

> **Priority:** P0 | **Effort:** 12h | **Sprint:** 3

---

## 1. Pattern Overview

| Pattern | Boundary | Transport | Copy Cost | Latency | Use Case |
|---------|----------|-----------|-----------|---------|----------|
| **In-Process Workers** | Thread | SharedArrayBuffer | Zero-copy | ~0.1ms | Consolidation, PageRank, batch decay |
| **Cross-Process MCP** | Process | Arrow IPC over HTTP | 1 copy (base64) | ~10ms | Agent-to-agent sharing, server exchange |
| **A2A Artifacts** | Network | Arrow IPC in A2A Artifact | 1 copy (base64) | Variable | External agent interop (Mastra, etc.) |
| **Blackboard** | Thread | SharedArrayBuffer | Zero-copy | ~0.1ms | Pipeline coordination (feature gen) |

---

## 2. Pattern 1: In-Process Sub-Agents (Worker Threads)

### Architecture

```
┌────────────────────────────────────────────────────────────┐
│                  Main Thread (Supervisor)                     │
│                                                              │
│  MemoryService.exportFrame('lessons', scope)                 │
│        │                                                     │
│        ▼                                                     │
│  SharedMemoryChannel.writeTable(table) → handle              │
│        │                                                     │
│        ├────── postMessage(handle) ──────┐                   │
│        ├────── postMessage(handle) ──────┼────┐              │
│        │                                  │    │              │
│  ┌─────▼──────┐  ┌─────────────────┐  ┌──▼────▼────┐       │
│  │ Worker A    │  │ Worker B        │  │ Worker C    │       │
│  │ (piscina)   │  │ (piscina)       │  │ (piscina)   │       │
│  │             │  │                 │  │             │        │
│  │ channel     │  │ channel         │  │ channel     │        │
│  │  .readTable │  │  .readTable     │  │  .readTable │        │
│  │  (handle)   │  │  (handle)       │  │  (handle)   │        │
│  │  ZERO COPY  │  │  ZERO COPY      │  │  ZERO COPY  │        │
│  │             │  │                 │  │             │        │
│  │ Run:        │  │ Run:            │  │ Run:        │        │
│  │ batchDecay  │  │ temporalMask    │  │ PageRank    │        │
│  │ Update()    │  │ ()              │  │ ()          │        │
│  │             │  │                 │  │             │        │
│  │ writeTable  │  │ writeTable      │  │ writeTable  │        │
│  │ (results)   │  │ (results)       │  │ (results)   │        │
│  └──────┬──────┘  └────────┬────────┘  └──────┬──────┘       │
│         │                   │                   │              │
│         └───── results ─────┼───────────────────┘              │
│                             ▼                                  │
│  Merge results → MemoryService.put() for each updated record  │
└────────────────────────────────────────────────────────────────┘
```

### Worker Module

```typescript
// src/worker-ops.ts — runs inside piscina worker thread
import { SharedMemoryChannel } from './shared-memory-channel.js'
import { deserializeFromIPC, serializeToIPC } from './ipc-serializer.js'
import * as ops from './columnar-ops.js'

interface WorkerTask {
  /** SharedArrayBuffer from the channel */
  sharedBuffer: SharedArrayBuffer
  /** Handle to the input data slot */
  inputHandle: { slotIndex: number; offset: number; length: number }
  /** Operation to perform */
  operation: 'batchDecay' | 'temporalFilter' | 'pageRank' | 'hubDampening' | 'findWeak'
  /** Operation-specific parameters */
  params: Record<string, unknown>
}

interface WorkerResult {
  /** Handle to the output data slot (if result is a Table) */
  outputHandle?: { slotIndex: number; offset: number; length: number }
  /** Scalar results (counts, indices) */
  data?: unknown
  /** Execution time in ms */
  durationMs: number
}

export default async function worker(task: WorkerTask): Promise<WorkerResult> {
  const start = performance.now()
  const channel = new SharedMemoryChannel({ existingBuffer: task.sharedBuffer })
  const table = channel.readTable(task.inputHandle)

  let result: unknown

  switch (task.operation) {
    case 'batchDecay': {
      const now = (task.params.now as number) ?? Date.now()
      result = ops.batchDecayUpdate(table, now)
      break
    }
    case 'temporalFilter': {
      const query = task.params.query as { asOf?: number; validAt?: number }
      result = ops.temporalMask(table, query)
      break
    }
    case 'pageRank': {
      const config = task.params as { damping?: number; iterations?: number }
      result = ops.rankByPageRank(table, config)
      break
    }
    case 'hubDampening': {
      result = ops.applyHubDampeningBatch(table, task.params)
      break
    }
    case 'findWeak': {
      const threshold = (task.params.threshold as number) ?? 0.1
      result = ops.findWeakIndices(table, threshold)
      break
    }
  }

  return {
    data: result,
    durationMs: performance.now() - start,
  }
}
```

### Integration with DualStreamWriter

The DualStreamWriter's slow-path callback receives `PendingRecord[]`. With Arrow:

```typescript
const writer = new DualStreamWriter({
  memoryService,
  namespace: 'lessons',
  scope,
  batchSize: 50,
  onSlowPath: async (records) => {
    // Convert pending records to Arrow Table
    const builder = new FrameBuilder()
    for (const r of records) {
      builder.add(r.value, { namespace: 'lessons', key: r.key, scope })
    }
    const table = builder.build()

    // Run enrichment ops on worker thread
    const channel = new SharedMemoryChannel()
    const handle = channel.writeTable(table)

    const pool = new Piscina({ filename: './worker-ops.js' })
    const result = await pool.run({
      sharedBuffer: channel.sharedBuffer,
      inputHandle: handle,
      operation: 'batchDecay',
      params: { now: Date.now() },
    })

    // Apply results back to store
    // ...
    channel.release(handle)
    channel.dispose()
  },
})
```

---

## 3. Pattern 2: Cross-Process via MCP

### MCP Tool Definitions

```typescript
import { z } from 'zod'

// ─── memory.export ──────────────────────────────────────

const exportInput = z.object({
  namespace: z.string().describe('Memory namespace to export'),
  scope: z.record(z.string()).optional().describe('Scope filter (tenantId, projectId, etc.)'),
  query: z.string().optional().describe('Semantic search query to filter records'),
  temporal: z.object({
    asOf: z.number().optional().describe('System time point-in-time query (epoch ms)'),
    validAt: z.number().optional().describe('Real-world time point-in-time query (epoch ms)'),
  }).optional(),
  format: z.enum(['arrow_ipc', 'json']).default('arrow_ipc'),
  limit: z.number().default(100).describe('Maximum records to export'),
})

const exportOutput = z.object({
  data: z.string().describe('Base64-encoded Arrow IPC bytes (or JSON array if format=json)'),
  format: z.enum(['arrow_ipc', 'json']),
  schema_version: z.number(),
  record_count: z.number(),
  namespaces: z.array(z.string()),
  byte_size: z.number(),
})

// ─── memory.import ──────────────────────────────────────

const importInput = z.object({
  data: z.string().describe('Base64-encoded Arrow IPC bytes (or JSON array)'),
  format: z.enum(['arrow_ipc', 'json']).default('arrow_ipc'),
  namespace: z.string().describe('Target namespace for imported records'),
  scope: z.record(z.string()).optional(),
  merge_strategy: z.enum(['upsert', 'append', 'replace']).default('upsert'),
  conflict_resolution: z.enum(['newest_wins', 'highest_importance', 'manual']).default('newest_wins'),
})

const importOutput = z.object({
  imported: z.number(),
  skipped: z.number(),
  conflicts: z.number(),
  warnings: z.array(z.string()),
})

// ─── memory.subscribe ───────────────────────────────────

const subscribeInput = z.object({
  namespace: z.string(),
  scope: z.record(z.string()).optional(),
  since: z.number().optional().describe('Only changes after this epoch ms'),
  format: z.enum(['arrow_ipc_stream', 'ndjson']).default('arrow_ipc_stream'),
})

// memory.subscribe returns streaming RecordBatch messages via SSE

// ─── memory.schema ──────────────────────────────────────

const schemaOutput = z.object({
  schema_version: z.number(),
  fields: z.array(z.object({
    name: z.string(),
    type: z.string(),
    nullable: z.boolean(),
    description: z.string(),
  })),
})
```

### MCP Handler Implementation

```typescript
// In @dzipagent/server — Hono route handlers

async function handleExportMemories(input: z.infer<typeof exportInput>) {
  const arrowMemory = extendMemoryServiceWithArrow(memoryService)

  if (input.format === 'arrow_ipc') {
    const ipcBytes = await arrowMemory.exportIPC(input.namespace, input.scope ?? {}, {
      query: input.query,
      limit: input.limit,
      temporal: input.temporal,
    })
    return {
      data: ipcToBase64(ipcBytes),
      format: 'arrow_ipc' as const,
      schema_version: MEMORY_FRAME_VERSION,
      record_count: deserializeFromIPC(ipcBytes).numRows,
      namespaces: [input.namespace],
      byte_size: ipcBytes.byteLength,
    }
  }

  // JSON fallback
  const records = await memoryService.search(
    input.namespace, input.scope ?? {}, input.query ?? '', input.limit,
  )
  return {
    data: JSON.stringify(records),
    format: 'json' as const,
    schema_version: MEMORY_FRAME_VERSION,
    record_count: records.length,
    namespaces: [input.namespace],
    byte_size: JSON.stringify(records).length,
  }
}
```

### Integration with SharedMemorySpace (F1)

When a `MemorySpaceManager.share({ mode: 'push' })` is called, and the space has remote participants connected via MCP:

```
Agent A (local)                  MemorySpaceManager            Agent B (MCP client)
     │                                  │                            │
     │── share({mode:'push'}) ────►     │                            │
     │                                  │── store locally ──►        │
     │                                  │── DzipEventBus emit ─►    │
     │                                  │                            │
     │                                  │── if MCP subscribers: ─►   │
     │                                  │   export record as Arrow   │
     │                                  │   IPC RecordBatch          │
     │                                  │── SSE push to subscriber──►│
     │                                  │                            │
     │                                  │                    import Arrow IPC
     │                                  │                    into local store
```

---

## 4. Pattern 3: A2A Memory Artifacts

### Artifact Structure

```typescript
/**
 * A2A Artifact containing DzipAgent memory data as Arrow IPC.
 *
 * Conforms to the A2A Artifact spec:
 * - name: identifies the artifact type
 * - parts[]: content parts with MIME types
 * - metadata on each part carries DzipAgent-specific info
 */
interface MemoryArtifact {
  name: 'forgeagent_memory_batch'
  description: string  // "87 memory records from namespace 'decisions'"
  parts: [{
    kind: 'data'
    mimeType: 'application/vnd.apache.arrow.stream'
    data: string  // base64-encoded Arrow IPC bytes
    metadata: {
      schema_version: number
      record_count: number
      namespaces: string[]
      source_agent: string  // forge:// URI
      temporal_range: {
        earliest: number  // min(system_created_at)
        latest: number    // max(system_created_at)
      }
      /** Fields stripped before export for privacy */
      redacted_fields?: string[]
    }
  }]
}

/**
 * Create a MemoryArtifact from an Arrow Table.
 */
export function createMemoryArtifact(
  table: Table,
  sourceAgent: string,
  description?: string,
): MemoryArtifact {
  const ipcBytes = serializeToIPC(table, { format: 'stream' })
  const reader = new FrameReader(table)

  // Compute temporal range
  const createdAtCol = table.getChild('system_created_at')
  let earliest = Infinity, latest = -Infinity
  if (createdAtCol) {
    for (let i = 0; i < createdAtCol.length; i++) {
      const v = createdAtCol.get(i) as number
      if (v < earliest) earliest = v
      if (v > latest) latest = v
    }
  }

  return {
    name: 'forgeagent_memory_batch',
    description: description ?? `${table.numRows} memory records from ${reader.namespaces.join(', ')}`,
    parts: [{
      kind: 'data',
      mimeType: 'application/vnd.apache.arrow.stream',
      data: ipcToBase64(ipcBytes),
      metadata: {
        schema_version: MEMORY_FRAME_VERSION,
        record_count: table.numRows,
        namespaces: reader.namespaces,
        source_agent: sourceAgent,
        temporal_range: { earliest, latest },
      },
    }],
  }
}

/**
 * Parse a MemoryArtifact back into an Arrow Table.
 */
export function parseMemoryArtifact(artifact: MemoryArtifact): {
  table: Table
  metadata: MemoryArtifact['parts'][0]['metadata']
} {
  const part = artifact.parts[0]
  const ipcBytes = base64ToIPC(part.data)
  const table = deserializeFromIPC(ipcBytes)
  return { table, metadata: part.metadata }
}
```

### Privacy Filtering Before Export

```typescript
/**
 * Strip sensitive columns before creating an A2A artifact.
 * Respects ScopedMemoryService policies and namespace-level sensitivity.
 */
export function sanitizeForExport(
  table: Table,
  options: {
    /** Columns to strip entirely */
    redactColumns?: string[]
    /** Namespaces to exclude */
    excludeNamespaces?: string[]
    /** Strip payload_json (removes all overflow/custom fields) */
    stripPayload?: boolean
  },
): { table: Table; redactedFields: string[] } {
  // Implementation: create new Table without redacted columns
  // Filter out rows from excluded namespaces
  // Optionally null-out payload_json column
  return { table, redactedFields: options.redactColumns ?? [] }
}
```

---

## 5. Pattern 4: Blackboard Architecture

### Use Case: Feature Generation Pipeline

The 12-node feature generator pipeline (intake → clarify → plan → gen_db → gen_backend → gen_frontend → gen_tests → run_tests → validate → fix → review → publish) needs shared context. Currently this is LangGraph state (JSON). With Arrow:

```
┌──────────────────────────────────────────────────────────────┐
│                Arrow Blackboard (SharedArrayBuffer)             │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ decisions: Table    (append-only, written by planner)    │  │
│  │ conventions: Table  (versioned, written by validator)    │  │
│  │ files: Table        (append-only, written by gen_*)      │  │
│  │ test_results: Table (append-only, written by run_tests)  │  │
│  │ errors: Table       (append-only, written by fix node)   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  Per-table metadata:                                           │
│    write_seq: Atomics Int32 (incremented on each write)        │
│    writer_id: string (agent URI owning write access)           │
│    last_write_at: Int64 (epoch ms)                             │
│                                                                │
│  Concurrency: SWMR per table                                   │
│    - One designated writer per table                           │
│    - All pipeline nodes can read any table                     │
│    - New RecordBatches appended (never modify existing)        │
│    - Readers check write_seq to detect new data                │
└──────┬──────────────┬──────────────┬──────────────┬───────────┘
       │              │              │              │
  ┌────▼───┐    ┌────▼───┐    ┌────▼───┐    ┌────▼───┐
  │Plan    │    │Gen DB  │    │Gen API │    │Gen FE  │
  │(writes │    │(reads  │    │(reads  │    │(reads  │
  │decisions│   │decisions│   │decisions│   │decisions│
  │table)   │   │writes  │   │writes  │   │writes  │
  │         │   │files)  │    │files)  │    │files)  │
  └────────┘    └────────┘    └────────┘    └────────┘
```

### Blackboard Class

```typescript
interface BlackboardConfig {
  /** SharedMemoryChannel for underlying buffer management */
  channel: SharedMemoryChannel
  /** Table definitions: name → writer agent URI */
  tables: Record<string, { writer: string; schema: Schema }>
  /** Optional DzipEventBus for change notifications */
  eventBus?: DzipEventBus
}

interface BlackboardSnapshot {
  table: Table
  writeSeq: number
  lastWriteAt: number
}

export class ArrowBlackboard {
  private readonly tableHandles = new Map<string, SlotHandle>()
  private readonly writeSeqs = new Map<string, number>()

  constructor(private readonly config: BlackboardConfig) {}

  /**
   * Append records to a blackboard table.
   * Only the designated writer agent can call this.
   * Readers see the new data on their next read (via write_seq check).
   */
  async append(
    tableName: string,
    writerUri: string,
    records: Table,
  ): Promise<void> {
    const def = this.config.tables[tableName]
    if (!def) throw new Error(`Unknown blackboard table: ${tableName}`)
    if (def.writer !== writerUri) {
      throw new Error(`Agent ${writerUri} is not the writer for table ${tableName}`)
    }

    // Get existing data + append new records
    const existing = this.tableHandles.get(tableName)
    let merged: Table
    if (existing) {
      const current = this.config.channel.readTable(existing)
      merged = concatTables(current, records)  // Arrow concat
      this.config.channel.release(existing)
    } else {
      merged = records
    }

    // Write merged table to channel
    const handle = this.config.channel.writeTable(merged)
    this.tableHandles.set(tableName, handle)

    // Increment write sequence
    const seq = (this.writeSeqs.get(tableName) ?? 0) + 1
    this.writeSeqs.set(tableName, seq)

    // Notify via event bus
    this.config.eventBus?.emit({
      type: 'blackboard:write',
      tableName,
      writerUri,
      writeSeq: seq,
      recordCount: merged.numRows,
    })
  }

  /**
   * Read a blackboard table. Any agent can read any table.
   * Returns null if the table hasn't been written yet.
   */
  read(tableName: string): BlackboardSnapshot | null {
    const handle = this.tableHandles.get(tableName)
    if (!handle) return null

    return {
      table: this.config.channel.readTable(handle),
      writeSeq: this.writeSeqs.get(tableName) ?? 0,
      lastWriteAt: Date.now(),
    }
  }

  /**
   * Check if a table has new data since last read.
   * Cheap: only reads the atomic write sequence number.
   */
  hasUpdates(tableName: string, lastSeenSeq: number): boolean {
    return (this.writeSeqs.get(tableName) ?? 0) > lastSeenSeq
  }

  /** Get write sequence for a table */
  getWriteSeq(tableName: string): number {
    return this.writeSeqs.get(tableName) ?? 0
  }

  /** Dispose all table handles */
  dispose(): void {
    for (const handle of this.tableHandles.values()) {
      this.config.channel.release(handle)
    }
    this.tableHandles.clear()
  }
}
```

### Pipeline Integration Example

```typescript
// Feature generation pipeline using Arrow blackboard

const channel = new SharedMemoryChannel({ maxBytes: 128 * 1024 * 1024 })
const blackboard = new ArrowBlackboard({
  channel,
  tables: {
    decisions: { writer: 'forge://t1/agent/planner', schema: MEMORY_FRAME_SCHEMA },
    files: { writer: 'forge://t1/agent/codegen', schema: CODEGEN_FRAME_SCHEMA },
    test_results: { writer: 'forge://t1/agent/tester', schema: EVAL_FRAME_SCHEMA },
  },
})

// Plan node writes decisions
async function planNode(state: PipelineState) {
  const decisions = await planFeature(state.featureSpec)
  const builder = new FrameBuilder()
  for (const d of decisions) {
    builder.add({ text: d.description, type: 'decision' }, {
      namespace: 'decisions', key: d.id, scope: state.scope,
    })
  }
  await blackboard.append('decisions', 'forge://t1/agent/planner', builder.build())
}

// Gen DB node reads decisions, writes files
async function genDbNode(state: PipelineState) {
  const snapshot = blackboard.read('decisions')
  if (!snapshot) return

  const reader = new FrameReader(snapshot.table)
  const decisions = reader.filterByNamespace('decisions').toRecords()

  const files = await generateDbSchema(decisions, state.featureSpec)
  // ... write files to blackboard.files
}
```

---

## 6. Testing Strategy

| Test | Pattern | Description |
|------|---------|-------------|
| `worker-round-trip` | 1 | Main writes Table, worker reads, processes, writes back |
| `worker-concurrent-read` | 1 | 1 writer, 4 concurrent readers via piscina pool |
| `worker-large-batch` | 1 | 10K records through SharedArrayBuffer |
| `mcp-export-arrow` | 2 | Export via MCP tool, verify valid Arrow IPC in response |
| `mcp-import-arrow` | 2 | Import Arrow IPC via MCP tool, verify records in store |
| `mcp-subscribe-stream` | 2 | Subscribe, write 5 records, receive 5 RecordBatch SSE events |
| `mcp-json-fallback` | 2 | Export with format=json, verify JSON array response |
| `a2a-create-artifact` | 3 | Create MemoryArtifact, verify structure and MIME type |
| `a2a-parse-artifact` | 3 | Parse MemoryArtifact, verify Table matches original |
| `a2a-sanitize-export` | 3 | Sanitize before export, verify redacted columns absent |
| `blackboard-append-read` | 4 | Append to table, read from another "agent", verify data |
| `blackboard-writer-check` | 4 | Non-writer agent attempts write, verify rejection |
| `blackboard-has-updates` | 4 | Check writeSeq before/after append |
| `blackboard-pipeline-flow` | 4 | Simulate 3-node pipeline with blackboard coordination |
