# 03 — @dzipagent/memory-ipc Package Specification

> **Priority:** P0 | **Effort:** 16h | **Sprint:** 1-2

---

## 1. Package Definition

```json
{
  "name": "@dzipagent/memory-ipc",
  "version": "0.1.0",
  "description": "Arrow-based IPC for inter-agent memory sharing in DzipAgent",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "dependencies": {
    "apache-arrow": "^19.0.0"
  },
  "peerDependencies": {
    "@dzipagent/memory": "workspace:*"
  },
  "peerDependenciesMeta": {
    "@dzipagent/memory": { "optional": true }
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0"
  }
}
```

---

## 2. File Structure

```
packages/forgeagent-memory-ipc/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts                         # Public API re-exports
    schema.ts                        # MEMORY_FRAME_SCHEMA, MEMORY_FRAME_VERSION
    frame-builder.ts                 # FrameBuilder: Record[] → Arrow Table
    frame-reader.ts                  # FrameReader: Arrow Table → Record[]
    ipc-serializer.ts                # tableToIPC / tableFromIPC wrappers
    shared-memory-channel.ts         # SharedArrayBuffer cross-thread channel
    columnar-ops.ts                  # Vectorized batch operations (doc 05)
    blackboard.ts                    # Shared Arrow blackboard (doc 04)
    a2a-memory-artifact.ts           # A2A Artifact wrapper (doc 04)
    mcp-memory-transport.ts          # MCP tool schemas (doc 04)
    memory-service-ext.ts            # exportFrame/importFrame extensions
    adapters/
      types.ts                       # MemoryFrameAdapter interface
      mastra-adapter.ts              # Mastra OM ↔ MemoryFrame
      langgraph-adapter.ts           # LangGraph Store ↔ MemoryFrame
      mem0-adapter.ts                # Mem0 fact format ↔ MemoryFrame
      letta-adapter.ts               # Letta tiers ↔ MemoryFrame
      mcp-kg-adapter.ts              # MCP KG server ↔ MemoryFrame
    frames/                          # Extended frame schemas (doc 08)
      tool-result-frame.ts
      codegen-frame.ts
      eval-frame.ts
      entity-graph-frame.ts
    analytics/
      memory-analytics.ts            # DuckDB-WASM integration (doc 08)
    archival/
      parquet-archival.ts            # Parquet persistence (doc 08)
    __tests__/
      frame-builder.test.ts
      frame-reader.test.ts
      ipc-serializer.test.ts
      shared-memory-channel.test.ts
      columnar-ops.test.ts
      round-trip.test.ts
      adapters.test.ts
```

---

## 3. FrameBuilder — Records to Arrow

### Class API

```typescript
import { Table, RecordBatch } from 'apache-arrow'
import type { TemporalQuery } from '@dzipagent/memory'

/** Metadata for a memory record being added to the frame */
interface FrameRecordMeta {
  id?: string           // auto-generated UUID v7 if omitted
  namespace: string
  key: string
  scope: Record<string, string>
}

/**
 * Builds an Arrow Table from DzipAgent memory records.
 *
 * Accumulates records via add()/addBatch(), then produces an Arrow Table
 * conforming to MEMORY_FRAME_SCHEMA via build(). The builder is single-use:
 * call build() once, then discard the builder.
 *
 * For small batches (<50 records), build() returns a lightweight wrapper
 * that delegates to JSON for efficiency. The caller doesn't need to know.
 *
 * @example
 * ```ts
 * const builder = new FrameBuilder()
 * const records = await memoryService.get('decisions', scope)
 * for (const r of records) {
 *   builder.add(r, { namespace: 'decisions', key: r._key, scope })
 * }
 * const table = builder.build()
 * const ipcBytes = builder.toIPC()
 * ```
 */
export class FrameBuilder {
  private records: Array<{ value: Record<string, unknown>; meta: FrameRecordMeta }> = []
  private built = false

  /**
   * Add a single memory record.
   * @param value The record value from MemoryService.get()
   * @param meta  Namespace, key, and scope for this record
   * @returns this (for chaining)
   */
  add(value: Record<string, unknown>, meta: FrameRecordMeta): this {
    if (this.built) throw new Error('FrameBuilder already built. Create a new instance.')
    this.records.push({ value, meta })
    return this
  }

  /**
   * Add multiple records at once.
   * @param records Array of { value, ...meta } objects
   * @returns this (for chaining)
   */
  addBatch(records: Array<{ value: Record<string, unknown> } & FrameRecordMeta>): this {
    for (const r of records) {
      this.add(r.value, { id: r.id, namespace: r.namespace, key: r.key, scope: r.scope })
    }
    return this
  }

  /** Number of records accumulated so far */
  get count(): number {
    return this.records.length
  }

  /**
   * Build an Arrow Table from accumulated records.
   *
   * Implementation:
   * 1. Pre-scan records to build dictionary indices (namespace, agent_id, category)
   * 2. Allocate typed arrays for each column
   * 3. Single pass: extract fields from each record into column arrays
   * 4. Construct RecordBatch from column arrays + MEMORY_FRAME_SCHEMA
   * 5. Wrap in Table
   *
   * @returns Arrow Table conforming to MEMORY_FRAME_SCHEMA
   * @throws Never (returns empty table on error)
   */
  build(): Table {
    if (this.built) throw new Error('FrameBuilder already built.')
    this.built = true
    // ... implementation
    return new Table()
  }

  /**
   * Build and serialize to Arrow IPC bytes.
   * Convenience method: equivalent to `tableToIPC(build())`.
   * @param compression Optional compression ('none' | 'lz4' | 'zstd'), default 'none'
   */
  toIPC(compression?: 'none' | 'lz4' | 'zstd'): Uint8Array {
    const table = this.build()
    return serializeToIPC(table, { compression })
  }

  /**
   * Build and write to SharedArrayBuffer for cross-thread transfer.
   * The returned buffer can be posted to a worker via postMessage.
   */
  toSharedBuffer(): SharedArrayBuffer {
    const ipc = this.toIPC()
    const sab = new SharedArrayBuffer(ipc.byteLength)
    new Uint8Array(sab).set(ipc)
    return sab
  }
}
```

### Field Extraction Logic

```typescript
/** Extract a value from a record, handling convention-based metadata */
function extractField(
  value: Record<string, unknown>,
  meta: FrameRecordMeta,
  field: string,
): unknown {
  switch (field) {
    case 'id': return meta.id ?? `${meta.namespace}:${meta.key}:${Date.now()}`
    case 'namespace': return meta.namespace
    case 'key': return meta.key
    case 'scope_tenant': return meta.scope['tenantId'] ?? null
    case 'scope_project': return meta.scope['projectId'] ?? null
    case 'scope_agent': return meta.scope['agentId'] ?? value['_agent'] ?? null
    case 'scope_session': return meta.scope['sessionId'] ?? null
    case 'text': return typeof value['text'] === 'string' ? value['text'] : null

    // Temporal (from _temporal object)
    case 'system_created_at': return extractNested(value, '_temporal', 'systemCreatedAt') ?? Date.now()
    case 'system_expired_at': return extractNested(value, '_temporal', 'systemExpiredAt') ?? null
    case 'valid_from': return extractNested(value, '_temporal', 'validFrom') ?? Date.now()
    case 'valid_until': return extractNested(value, '_temporal', 'validUntil') ?? null

    // Decay (from _decay object)
    case 'decay_strength': return extractNested(value, '_decay', 'strength') ?? null
    case 'decay_half_life_ms': return extractNested(value, '_decay', 'halfLifeMs') ?? null
    case 'decay_last_accessed_at': return extractNested(value, '_decay', 'lastAccessedAt') ?? null
    case 'decay_access_count': return extractNested(value, '_decay', 'accessCount') ?? null

    // Provenance
    case 'agent_id':
      return extractNested(value, '_provenance', 'createdBy') ?? value['_agent'] ?? null
    case 'category': return value['category'] ?? value['type'] ?? null
    case 'importance':
      return extractNested(value, '_provenance', 'confidence') ?? value['confidence'] ?? null
    case 'provenance_source':
      return extractNested(value, '_provenance', 'source') ?? null

    // Derived
    case 'is_active': {
      const expired = extractNested(value, '_temporal', 'systemExpiredAt')
      return expired === null || expired === undefined
    }

    // Overflow
    case 'payload_json': return buildPayloadJson(value)

    default: return null
  }
}

/** Build payload_json from fields NOT covered by typed columns */
function buildPayloadJson(value: Record<string, unknown>): string | null {
  const TYPED_KEYS = new Set([
    'text', '_temporal', '_decay', '_provenance', '_agent',
    'category', 'type', 'confidence',
  ])
  const overflow: Record<string, unknown> = {}
  let hasOverflow = false
  for (const [k, v] of Object.entries(value)) {
    if (!TYPED_KEYS.has(k)) {
      overflow[k] = v
      hasOverflow = true
    }
  }
  // Full provenance lineage goes to overflow (columns only carry createdBy + source)
  const prov = value['_provenance'] as Record<string, unknown> | undefined
  if (prov?.['lineage']) {
    overflow['_provenance_lineage'] = prov['lineage']
    overflow['_provenance_derivedFrom'] = prov['derivedFrom']
    overflow['_provenance_contentHash'] = prov['contentHash']
    hasOverflow = true
  }
  return hasOverflow ? JSON.stringify(overflow) : null
}
```

---

## 4. FrameReader — Arrow to Records

```typescript
import { Table, Vector, Schema } from 'apache-arrow'
import type { TemporalQuery } from '@dzipagent/memory'

interface FrameRecord {
  id: string
  namespace: string
  key: string
  scope: Record<string, string>
  value: Record<string, unknown>
}

/**
 * Reads an Arrow Table back into DzipAgent memory records.
 *
 * Provides both full deserialization (toRecords()) and columnar access
 * (getColumn(), filter methods) for efficient batch operations.
 *
 * @example
 * ```ts
 * const reader = FrameReader.fromIPC(ipcBytes)
 * const activeDecisions = reader
 *   .filterActive()
 *   .filterByNamespace('decisions')
 *   .filterByDecayAbove(0.3)
 *   .toRecords()
 * ```
 */
export class FrameReader {
  constructor(private readonly table: Table) {}

  // ─── Static Constructors ─────────────────────────────────

  /** Construct from Arrow IPC bytes */
  static fromIPC(bytes: Uint8Array): FrameReader {
    const table = deserializeFromIPC(bytes)
    return new FrameReader(table)
  }

  /** Construct from SharedArrayBuffer (reads IPC bytes from buffer) */
  static fromSharedBuffer(buf: SharedArrayBuffer): FrameReader {
    return FrameReader.fromIPC(new Uint8Array(buf))
  }

  // ─── Accessors ───────────────────────────────────────────

  get schema(): Schema { return this.table.schema }
  get rowCount(): number { return this.table.numRows }

  /** Unique namespaces in this frame (from dictionary) */
  get namespaces(): string[] {
    const col = this.table.getChild('namespace')
    if (!col) return []
    const seen = new Set<string>()
    for (let i = 0; i < col.length; i++) {
      const v = col.get(i)
      if (v !== null) seen.add(v as string)
    }
    return [...seen]
  }

  /** Access a single column as a typed Vector */
  getColumn<T = unknown>(name: string): Vector<T> {
    const col = this.table.getChild(name)
    if (!col) throw new Error(`Column "${name}" not found in MemoryFrame`)
    return col as Vector<T>
  }

  // ─── Full Deserialization ────────────────────────────────

  /**
   * Convert all rows back to DzipAgent record format.
   * Reconstructs _temporal, _decay, _provenance, _agent convention fields.
   */
  toRecords(): FrameRecord[] {
    const results: FrameRecord[] = []
    for (let i = 0; i < this.table.numRows; i++) {
      results.push(this.rowToRecord(i))
    }
    return results
  }

  // ─── Filtering (returns new FrameReader with filtered Table) ──

  /** Keep only rows matching a specific namespace */
  filterByNamespace(ns: string): FrameReader {
    return this.filterByPredicate(i => {
      return this.table.getChild('namespace')?.get(i) === ns
    })
  }

  /** Keep only rows where system_expired_at is null (is_active = true) */
  filterActive(): FrameReader {
    return this.filterByPredicate(i => {
      return this.table.getChild('is_active')?.get(i) === true
    })
  }

  /** Keep only rows where decay_strength >= threshold */
  filterByDecayAbove(threshold: number): FrameReader {
    return this.filterByPredicate(i => {
      const strength = this.table.getChild('decay_strength')?.get(i)
      return strength === null || (strength as number) >= threshold
    })
  }

  /** Keep only rows matching a specific agent_id */
  filterByAgent(agentId: string): FrameReader {
    return this.filterByPredicate(i => {
      return this.table.getChild('agent_id')?.get(i) === agentId
    })
  }

  /** Keep only rows matching a temporal query */
  filterByTemporal(query: TemporalQuery): FrameReader {
    return this.filterByPredicate(i => {
      if (query.asOf !== undefined) {
        const created = this.table.getChild('system_created_at')?.get(i) as number
        const expired = this.table.getChild('system_expired_at')?.get(i) as number | null
        if (created > query.asOf) return false
        if (expired !== null && expired <= query.asOf) return false
      }
      if (query.validAt !== undefined) {
        const from = this.table.getChild('valid_from')?.get(i) as number
        const until = this.table.getChild('valid_until')?.get(i) as number | null
        if (from > query.validAt) return false
        if (until !== null && until <= query.validAt) return false
      }
      return true
    })
  }

  // ─── Private ─────────────────────────────────────────────

  private filterByPredicate(predicate: (rowIndex: number) => boolean): FrameReader {
    // Build index array of matching rows, then slice Table
    const indices: number[] = []
    for (let i = 0; i < this.table.numRows; i++) {
      if (predicate(i)) indices.push(i)
    }
    // Use Arrow's take() or manual RecordBatch construction
    // ... implementation creates new Table with only matching rows
    return new FrameReader(this.table) // placeholder
  }

  private rowToRecord(i: number): FrameRecord {
    // Reconstruct Record<string,unknown> from Arrow columns
    // ... see field mapping in doc 02, section 3.2
    return {} as FrameRecord // placeholder
  }
}
```

---

## 5. IPC Serializer

```typescript
import { tableToIPC as arrowToIPC, tableFromIPC as arrowFromIPC, Table } from 'apache-arrow'

interface SerializeOptions {
  /** Compression algorithm. Default: 'none'.
   *  'lz4' and 'zstd' require the respective WASM codecs to be loaded. */
  compression?: 'none' | 'lz4' | 'zstd'
  /** Format: 'file' (random access) or 'stream' (sequential). Default: 'file' */
  format?: 'file' | 'stream'
}

/**
 * Serialize an Arrow Table to IPC bytes.
 *
 * Uses Arrow IPC file format by default (includes footer for random access).
 * Stream format is used for memory.subscribe MCP tool (sequential consumption).
 */
export function serializeToIPC(table: Table, options?: SerializeOptions): Uint8Array {
  try {
    return arrowToIPC(table, options?.format ?? 'file')
  } catch {
    // Non-fatal: return empty IPC on error
    return arrowToIPC(new Table(), 'file')
  }
}

/**
 * Deserialize Arrow IPC bytes to a Table.
 * Handles both file and stream formats automatically.
 */
export function deserializeFromIPC(bytes: Uint8Array): Table {
  try {
    return arrowFromIPC(bytes)
  } catch {
    // Non-fatal: return empty table
    return new Table()
  }
}

/**
 * Encode IPC bytes as base64 string for JSON transport (MCP, REST).
 */
export function ipcToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * Decode base64 string back to IPC bytes.
 */
export function base64ToIPC(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}
```

---

## 6. SharedMemoryChannel

```typescript
/**
 * Zero-copy memory channel between main thread and worker threads.
 *
 * Uses SharedArrayBuffer so Arrow IPC data is written once and read by any
 * number of worker threads without serialization. Implements a simple
 * slot-based allocation with Atomics for synchronization.
 *
 * Concurrency model: Single-Writer-Multi-Reader (SWMR) per slot.
 * - Main thread writes IPC bytes to a slot
 * - Workers read from the slot (zero-copy via Uint8Array view)
 * - Workers write results to separate slots
 * - Main thread reads results after Atomics.wait() signal
 *
 * Memory layout:
 *   [0..3]    = Int32: header (slot count)
 *   [4..7]    = Int32: next free slot index
 *   [8..N]    = Slot metadata: [offset: Int32, length: Int32, state: Int32] per slot
 *   [N+1..]   = Data region: raw IPC bytes
 *
 * Slot states:
 *   0 = free
 *   1 = writing (locked by writer)
 *   2 = ready (available for readers)
 *   3 = reading (locked by a reader for exclusive result writing)
 */

interface SharedMemoryChannelOptions {
  /** Maximum total buffer size in bytes. Default: 64MB */
  maxBytes?: number
  /** Maximum number of concurrent slots. Default: 16 */
  maxSlots?: number
}

interface SlotHandle {
  slotIndex: number
  offset: number
  length: number
}

export class SharedMemoryChannel {
  private readonly buffer: SharedArrayBuffer
  private readonly view: DataView
  private readonly int32View: Int32Array
  private readonly maxSlots: number
  private readonly headerSize: number
  private readonly dataOffset: number

  constructor(options?: SharedMemoryChannelOptions) {
    const maxBytes = options?.maxBytes ?? 64 * 1024 * 1024  // 64MB
    this.maxSlots = options?.maxSlots ?? 16
    // Header: 2 Int32 + slot metadata: 3 Int32 per slot
    this.headerSize = 8 + this.maxSlots * 12
    this.dataOffset = Math.ceil(this.headerSize / 8) * 8  // align to 8 bytes
    this.buffer = new SharedArrayBuffer(maxBytes)
    this.view = new DataView(this.buffer)
    this.int32View = new Int32Array(this.buffer)
    // Initialize header
    this.view.setInt32(0, this.maxSlots, true)  // slot count
    this.view.setInt32(4, 0, true)               // next free slot
  }

  /**
   * Write Arrow IPC bytes to the channel.
   * Returns a SlotHandle that workers use to read the data.
   */
  write(ipcBytes: Uint8Array): SlotHandle {
    const slotIndex = this.allocateSlot()
    const offset = this.allocateData(ipcBytes.byteLength)

    // Copy IPC bytes to shared buffer
    new Uint8Array(this.buffer, offset, ipcBytes.byteLength).set(ipcBytes)

    // Update slot metadata
    const slotBase = 8 + slotIndex * 12
    this.view.setInt32(slotBase, offset, true)           // offset
    this.view.setInt32(slotBase + 4, ipcBytes.byteLength, true)  // length

    // Mark slot as ready (state = 2) and notify waiters
    Atomics.store(this.int32View, (slotBase + 8) / 4, 2)
    Atomics.notify(this.int32View, (slotBase + 8) / 4)

    return { slotIndex, offset, length: ipcBytes.byteLength }
  }

  /**
   * Write an Arrow Table to the channel (convenience: serializes to IPC first).
   */
  writeTable(table: Table): SlotHandle {
    const ipc = serializeToIPC(table)
    return this.write(ipc)
  }

  /**
   * Read Arrow IPC bytes from a slot (zero-copy view into SharedArrayBuffer).
   * The returned Uint8Array is a VIEW into the shared buffer — no copy.
   */
  read(handle: SlotHandle): Uint8Array {
    const slotBase = 8 + handle.slotIndex * 12
    // Wait until slot is ready (state = 2)
    while (Atomics.load(this.int32View, (slotBase + 8) / 4) !== 2) {
      Atomics.wait(this.int32View, (slotBase + 8) / 4, 1, 100)
    }
    return new Uint8Array(this.buffer, handle.offset, handle.length)
  }

  /**
   * Read and deserialize to Arrow Table.
   */
  readTable(handle: SlotHandle): Table {
    const bytes = this.read(handle)
    return deserializeFromIPC(bytes)
  }

  /**
   * Release a slot for reuse.
   */
  release(handle: SlotHandle): void {
    const slotBase = 8 + handle.slotIndex * 12
    Atomics.store(this.int32View, (slotBase + 8) / 4, 0)  // state = free
  }

  /** Get the underlying SharedArrayBuffer for posting to workers */
  get sharedBuffer(): SharedArrayBuffer {
    return this.buffer
  }

  /** Release all resources */
  dispose(): void {
    // Reset all slots to free
    for (let i = 0; i < this.maxSlots; i++) {
      const slotBase = 8 + i * 12
      Atomics.store(this.int32View, (slotBase + 8) / 4, 0)
    }
  }

  // ─── Private ──────────────────────────────────────────

  private allocateSlot(): number {
    const next = Atomics.add(this.int32View, 1, 1) % this.maxSlots
    return next
  }

  private allocateData(size: number): number {
    // Simple bump allocator in the data region
    // Production: replace with proper free-list allocator
    // For now: slots are short-lived, channel is reset between batches
    return this.dataOffset  // simplified
  }
}
```

---

## 7. MemoryService Extension Methods

```typescript
import { Table } from 'apache-arrow'
import type { TemporalQuery } from './temporal.js'

/**
 * Extension methods added to MemoryService.
 * These are added via a mixin or wrapper pattern — MemoryService itself
 * does NOT import apache-arrow.
 *
 * Usage: call `extendMemoryServiceWithArrow(memoryService)` to add these methods.
 */

interface ExportFrameOptions {
  query?: string
  limit?: number
  temporal?: TemporalQuery
}

interface ImportFrameResult {
  imported: number
  skipped: number
  conflicts: number
}

type ImportStrategy = 'upsert' | 'append' | 'replace'

/**
 * Extend a MemoryService instance with Arrow frame export/import methods.
 *
 * @example
 * ```ts
 * import { extendMemoryServiceWithArrow } from '@dzipagent/memory-ipc'
 *
 * const memoryService = new MemoryService(store, namespaces)
 * const arrowMemory = extendMemoryServiceWithArrow(memoryService)
 *
 * // Export as Arrow Table
 * const table = await arrowMemory.exportFrame('decisions', scope)
 *
 * // Export as IPC bytes (for MCP/A2A transfer)
 * const bytes = await arrowMemory.exportIPC('decisions', scope)
 *
 * // Import from Arrow Table
 * const result = await arrowMemory.importFrame('decisions', scope, table)
 *
 * // Import from IPC bytes
 * const result2 = await arrowMemory.importIPC('decisions', scope, bytes)
 * ```
 */
export function extendMemoryServiceWithArrow(memoryService: MemoryService) {
  return {
    /** All original MemoryService methods */
    ...memoryService,

    /**
     * Export namespace records as an Arrow Table.
     * Fetches records from BaseStore and converts to columnar format.
     */
    async exportFrame(
      namespace: string,
      scope: Record<string, string>,
      options?: ExportFrameOptions,
    ): Promise<Table> {
      const records = options?.query
        ? await memoryService.search(namespace, scope, options.query, options.limit ?? 1000)
        : await memoryService.get(namespace, scope)

      const builder = new FrameBuilder()
      for (const r of records) {
        builder.add(r, {
          namespace,
          key: (r as Record<string, unknown>)['_key'] as string ?? `${namespace}-${Date.now()}`,
          scope,
        })
      }
      return builder.build()
    },

    /**
     * Import records from an Arrow Table.
     * Converts columnar data back to records and writes via MemoryService.put().
     */
    async importFrame(
      namespace: string,
      scope: Record<string, string>,
      table: Table,
      strategy: ImportStrategy = 'upsert',
    ): Promise<ImportFrameResult> {
      const reader = new FrameReader(table)
      const records = reader.toRecords()
      let imported = 0, skipped = 0, conflicts = 0

      for (const record of records) {
        try {
          if (strategy === 'append') {
            await memoryService.put(namespace, scope, record.key, record.value)
            imported++
          } else if (strategy === 'upsert') {
            const existing = await memoryService.get(namespace, scope, record.key)
            if (existing.length > 0) conflicts++
            await memoryService.put(namespace, scope, record.key, record.value)
            imported++
          } else if (strategy === 'replace') {
            await memoryService.put(namespace, scope, record.key, record.value)
            imported++
          }
        } catch {
          skipped++
        }
      }

      return { imported, skipped, conflicts }
    },

    /** Export to IPC bytes (for MCP/A2A transfer) */
    async exportIPC(
      namespace: string,
      scope: Record<string, string>,
      options?: ExportFrameOptions,
    ): Promise<Uint8Array> {
      const table = await this.exportFrame(namespace, scope, options)
      return serializeToIPC(table)
    },

    /** Import from IPC bytes */
    async importIPC(
      namespace: string,
      scope: Record<string, string>,
      ipcBytes: Uint8Array,
      strategy?: ImportStrategy,
    ): Promise<ImportFrameResult> {
      const table = deserializeFromIPC(ipcBytes)
      return this.importFrame(namespace, scope, table, strategy)
    },
  }
}
```

---

## 8. Error Handling Strategy

All Arrow operations follow the same **non-fatal** pattern as the existing memory service:

| Scenario | Behavior |
|----------|----------|
| FrameBuilder.build() fails | Returns empty Table, logs warning |
| FrameReader.fromIPC() with invalid bytes | Returns empty FrameReader (0 rows) |
| SharedMemoryChannel.write() exceeds buffer | Throws (caller must handle — buffer full is a real error) |
| SharedMemoryChannel.read() timeout | Returns empty Uint8Array after 5s timeout |
| exportFrame() store error | Returns empty Table (MemoryService.get() already non-fatal) |
| importFrame() per-record failure | Increments `skipped` counter, continues with next record |
| IPC serialization failure | Returns IPC of empty Table |
| Column type mismatch on read | Returns null for that field, continues |

---

## 9. Testing Checklist

| Test | Category | Description |
|------|----------|-------------|
| `frame-builder-empty` | Unit | Builder with 0 records produces empty Table |
| `frame-builder-single` | Unit | Single record with all metadata fields |
| `frame-builder-batch-1k` | Unit | 1K records, verify column counts match |
| `frame-builder-missing-fields` | Unit | Records without _temporal, _decay produce null columns |
| `frame-builder-dictionary` | Unit | namespace, agent_id use dictionary encoding |
| `frame-reader-round-trip` | Unit | 100 records: build → toRecords, verify equality |
| `frame-reader-filter-namespace` | Unit | Filter 3 namespaces, verify correct subset |
| `frame-reader-filter-active` | Unit | Mix of active/expired, verify filter |
| `frame-reader-filter-decay` | Unit | Filter by threshold, verify boundary |
| `frame-reader-filter-temporal` | Unit | asOf and validAt queries |
| `ipc-serialize-deserialize` | Unit | Table → IPC → Table, verify equality |
| `ipc-base64-round-trip` | Unit | IPC → base64 → IPC, verify bytes match |
| `shared-channel-write-read` | Unit | Write IPC, read back, verify content |
| `shared-channel-multi-reader` | Integration | 1 writer, 3 readers, all get same data |
| `shared-channel-dispose` | Unit | Dispose resets all slots |
| `export-frame-from-store` | Integration | Write 50 records to MemoryService, exportFrame, verify |
| `import-frame-upsert` | Integration | Import over existing records, verify merge |
| `import-frame-replace` | Integration | Import with replace, verify overwrite |
| `full-round-trip` | Integration | MemoryService → Arrow → IPC → Arrow → MemoryService |
| `payload-json-overflow` | Unit | Custom fields survive round-trip via payload_json |
| `provenance-round-trip` | Unit | _provenance lineage survives via payload_json |
| `unicode-content` | Unit | Multi-byte UTF-8 in text column preserved |
