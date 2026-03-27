# 02 — MemoryFrame Schema Specification

> **Priority:** P0 | **Effort:** 8h | **Package:** `@dzipagent/memory-ipc`

---

## 1. Schema Overview

The MemoryFrame is a canonical Apache Arrow Schema that defines how DzipAgent memory records are represented in columnar format. It serves as the **interoperability contract** — any system producing or consuming DzipAgent memories must conform to this schema.

### Design Principles

1. **Flat over nested** — scope fields are flattened into individual columns for efficient filtering
2. **Dictionary-encode low-cardinality strings** — `namespace`, `agent_id`, `category` use integer indices
3. **Int64 for timestamps** — maps directly to JavaScript's `Date.now()` epoch milliseconds
4. **Overflow to JSON** — application-specific fields go in `payload_json` to keep schema stable
5. **Nullable by default** — most metadata columns are optional (agents may not use decay, temporal, etc.)

---

## 2. Full Schema Definition

```typescript
import {
  Schema, Field, Table, RecordBatch,
  Utf8, Float64, Int64, Int32, Bool, Struct,
  Dictionary, FixedSizeList, Float32,
} from 'apache-arrow'

export const MEMORY_FRAME_VERSION = 1

export const MEMORY_FRAME_SCHEMA = new Schema([
  // ═══════════════════════════════════════════
  // IDENTITY (3 columns)
  // ═══════════════════════════════════════════

  /** Globally unique record identifier (UUID v7 recommended for time-ordering) */
  new Field('id', new Utf8(), /*nullable*/ false),

  /** Memory namespace, dictionary-encoded (e.g., 'decisions', 'lessons', 'conventions')
   *  Dictionary: maps to Int32 index → Utf8 string lookup table
   *  Typical cardinality: 5-20 unique values per tenant */
  new Field('namespace', new Dictionary(new Utf8(), new Int32()), false),

  /** Record key within namespace (unique per namespace + scope combination) */
  new Field('key', new Utf8(), false),

  // ═══════════════════════════════════════════
  // SCOPE (4 columns, all nullable)
  // ═══════════════════════════════════════════
  // Flattened from Record<string,string> scope.
  // Null means "not applicable" (e.g., agent_id only set for agent-scoped memories).

  /** Tenant/organization identifier */
  new Field('scope_tenant', new Utf8(), true),

  /** Project or workspace identifier */
  new Field('scope_project', new Utf8(), true),

  /** Agent identifier (for agent-scoped memories) */
  new Field('scope_agent', new Utf8(), true),

  /** Session or thread identifier */
  new Field('scope_session', new Utf8(), true),

  // ═══════════════════════════════════════════
  // CONTENT (2 columns)
  // ═══════════════════════════════════════════

  /** Primary searchable text content.
   *  This is the field indexed by PostgresStore for semantic search.
   *  Null for records that are purely structural (entity nodes, causal edges). */
  new Field('text', new Utf8(), true),

  /** JSON-serialized overflow for fields not in the schema.
   *  Contains: custom tags (_tag_*), application metadata, encrypted envelopes,
   *  full provenance lineage chains, CRDT state vectors, attachment arrays.
   *  Null when all data fits in typed columns. */
  new Field('payload_json', new Utf8(), true),

  // ═══════════════════════════════════════════
  // TEMPORAL — Bi-temporal (Graphiti-style 4 timestamps)
  // ═══════════════════════════════════════════

  /** When the record entered our system (epoch ms). Always set. */
  new Field('system_created_at', new Int64(), false),

  /** When we marked the record expired (epoch ms). Null = currently active.
   *  Records are soft-expired, never hard-deleted — enables temporal queries. */
  new Field('system_expired_at', new Int64(), true),

  /** When the fact became true in the real world (epoch ms). Always set. */
  new Field('valid_from', new Int64(), false),

  /** When the fact stopped being true (epoch ms). Null = still valid. */
  new Field('valid_until', new Int64(), true),

  // ═══════════════════════════════════════════
  // DECAY — Ebbinghaus forgetting curve
  // ═══════════════════════════════════════════

  /** Current memory strength (0.0 = forgotten, 1.0 = fresh).
   *  Formula: strength = e^(-elapsed / halfLifeMs)
   *  Null for records without decay tracking. */
  new Field('decay_strength', new Float64(), true),

  /** Half-life in milliseconds. Default 86400000 (24h), doubles per access (max 30 days). */
  new Field('decay_half_life_ms', new Float64(), true),

  /** Last time the record was accessed/reinforced (epoch ms). */
  new Field('decay_last_accessed_at', new Int64(), true),

  /** Total number of times this record has been accessed. */
  new Field('decay_access_count', new Int64(), true),

  // ═══════════════════════════════════════════
  // PROVENANCE — Who created this, how, and with what confidence
  // Integrates with ecosystem_plan/05-MEMORY-SHARING F2
  // ═══════════════════════════════════════════

  /** Agent URI of the record creator (forge:// scheme).
   *  Dictionary-encoded: low cardinality (agents are few). */
  new Field('agent_id', new Dictionary(new Utf8(), new Int32()), true),

  /** Memory category. Dictionary-encoded.
   *  Values: 'episodic', 'semantic', 'procedural', 'affective', 'convention',
   *  'decision', 'lesson', 'observation', 'causal-edge', 'entity-node' */
  new Field('category', new Dictionary(new Utf8(), new Int32()), true),

  /** Importance/confidence score (0.0 – 1.0).
   *  Combines provenance confidence with manual importance assignments.
   *  Used by adaptive retriever for ranking. */
  new Field('importance', new Float64(), true),

  /** Provenance source classification. Dictionary-encoded.
   *  Values: 'user-input', 'llm-generated', 'tool-output', 'shared-space',
   *  'imported', 'derived', 'consolidated' */
  new Field('provenance_source', new Dictionary(new Utf8(), new Int32()), true),

  // ═══════════════════════════════════════════
  // FLAGS
  // ═══════════════════════════════════════════

  /** Derived flag: true when system_expired_at IS NULL.
   *  Materialized for fast filtering without null-checking Int64. */
  new Field('is_active', new Bool(), false),

  // ═══════════════════════════════════════════
  // OPTIONAL: Embedding vector
  // ═══════════════════════════════════════════
  // Uncomment when vector co-location is needed.
  // Most use cases keep embeddings in the vector store (Qdrant, pgvector).
  //
  // new Field('embedding', new FixedSizeList(384,
  //   new Field('dim', new Float32())), true),
],
  // Schema-level metadata
  new Map([
    ['forgeagent.schema.version', String(MEMORY_FRAME_VERSION)],
    ['forgeagent.schema.name', 'MemoryFrame'],
  ]),
)
```

---

## 3. Field Mapping: Record<string,unknown> ↔ Arrow Columns

### 3.1 From MemoryService Records to Arrow

| Source (Record value field) | Arrow Column | Transform |
|---|---|---|
| (generated) | `id` | UUID v7 or `${namespace}:${key}:${timestamp}` |
| (from namespace config) | `namespace` | Direct string |
| (from put() call) | `key` | Direct string |
| scope['tenantId'] | `scope_tenant` | Direct string |
| scope['projectId'] | `scope_project` | Direct string |
| scope['agentId'] or _agent | `scope_agent` | Direct string |
| scope['sessionId'] | `scope_session` | Direct string |
| value.text | `text` | Direct string |
| (remaining fields) | `payload_json` | `JSON.stringify(remaining)` |
| value._temporal.systemCreatedAt | `system_created_at` | Direct Int64 |
| value._temporal.systemExpiredAt | `system_expired_at` | Int64 or null |
| value._temporal.validFrom | `valid_from` | Direct Int64 |
| value._temporal.validUntil | `valid_until` | Int64 or null |
| value._decay.strength | `decay_strength` | Direct Float64 |
| value._decay.halfLifeMs | `decay_half_life_ms` | Direct Float64 |
| value._decay.lastAccessedAt | `decay_last_accessed_at` | Direct Int64 |
| value._decay.accessCount | `decay_access_count` | Direct Int64 |
| value._provenance.createdBy or value._agent | `agent_id` | Direct string (dict-encoded) |
| value.category or value.type | `category` | Direct string (dict-encoded) |
| value._provenance.confidence or value.confidence | `importance` | Direct Float64 |
| value._provenance.source | `provenance_source` | Direct string (dict-encoded) |
| (derived) | `is_active` | `system_expired_at === null` |

### 3.2 From Arrow Back to Record<string,unknown>

The reverse mapping reconstructs the convention-based `Record<string, unknown>`:

```typescript
function arrowRowToRecord(reader: FrameReader, rowIndex: number): {
  value: Record<string, unknown>
  namespace: string
  key: string
  scope: Record<string, string>
} {
  const value: Record<string, unknown> = {}

  // Text content
  const text = reader.getColumn('text').get(rowIndex)
  if (text !== null) value.text = text

  // Temporal metadata (reconstruct _temporal object)
  const systemCreatedAt = reader.getColumn('system_created_at').get(rowIndex)
  if (systemCreatedAt !== null) {
    value._temporal = {
      systemCreatedAt,
      systemExpiredAt: reader.getColumn('system_expired_at').get(rowIndex),
      validFrom: reader.getColumn('valid_from').get(rowIndex),
      validUntil: reader.getColumn('valid_until').get(rowIndex),
    }
  }

  // Decay metadata (reconstruct _decay object)
  const strength = reader.getColumn('decay_strength').get(rowIndex)
  if (strength !== null) {
    value._decay = {
      strength,
      halfLifeMs: reader.getColumn('decay_half_life_ms').get(rowIndex),
      lastAccessedAt: reader.getColumn('decay_last_accessed_at').get(rowIndex),
      accessCount: reader.getColumn('decay_access_count').get(rowIndex),
      createdAt: reader.getColumn('system_created_at').get(rowIndex),
    }
  }

  // Provenance (reconstruct _provenance stub; full lineage in payload_json)
  const agentId = reader.getColumn('agent_id').get(rowIndex)
  if (agentId !== null) value._agent = agentId

  // Overflow fields from payload_json
  const payload = reader.getColumn('payload_json').get(rowIndex)
  if (payload !== null) {
    Object.assign(value, JSON.parse(payload))
  }

  // Scope reconstruction
  const scope: Record<string, string> = {}
  const tenant = reader.getColumn('scope_tenant').get(rowIndex)
  if (tenant !== null) scope.tenantId = tenant
  // ... etc for project, agent, session

  return {
    value,
    namespace: reader.getColumn('namespace').get(rowIndex),
    key: reader.getColumn('key').get(rowIndex),
    scope,
  }
}
```

---

## 4. Schema Versioning Strategy

### 4.1 Version Field

The schema version is stored in Arrow Schema metadata:
```
forgeagent.schema.version = "1"
```

### 4.2 Evolution Rules

| Change Type | Allowed? | Version Bump? |
|---|---|---|
| Add nullable column | Yes | Minor (metadata only) |
| Add non-nullable column | No (breaks readers) | — |
| Remove column | No (breaks readers) | — |
| Rename column | No (breaks readers) | — |
| Change column type | No (breaks readers) | — |
| Add dictionary value | Yes | No |
| Change column nullability (nullable → non-nullable) | No | — |
| Change column nullability (non-nullable → nullable) | Yes | Minor |

### 4.3 Forward Compatibility

Readers MUST ignore unknown columns. When a reader encounters a MemoryFrame with version > its known version, it reads only the columns it recognizes and ignores the rest. This allows newer writers to add columns without breaking older readers.

### 4.4 Migration Transform

```typescript
/** Apply migration transforms for older schema versions */
function migrateFrame(table: Table, fromVersion: number): Table {
  if (fromVersion === MEMORY_FRAME_VERSION) return table

  // v1 → v2 migration example (hypothetical):
  // if (fromVersion < 2) {
  //   // Add new column with default values
  //   table = addColumnWithDefault(table, 'sensitivity', new Utf8(), 'internal')
  // }

  return table
}
```

---

## 5. Encoding Details

### 5.1 Dictionary Encoding Benefit

For a batch of 1,000 records with 5 unique namespaces:

| Encoding | Size |
|----------|------|
| Plain Utf8 | 1,000 × ~12 bytes avg = 12KB |
| Dictionary (Int32 index + 5 strings) | 1,000 × 4 bytes + 5 × 12 bytes = 4.06KB |
| **Savings** | **66%** |

`agent_id` (typically 3-10 unique agents) and `category` (10 fixed values) see similar savings.

### 5.2 Null Bitmap Efficiency

Arrow uses 1 bit per value for null tracking. For 1,000 records with `system_expired_at` being null on 900 records:

| Approach | Storage |
|----------|---------|
| JSON (null values serialized) | 1,000 × ~5 bytes = 5KB |
| Arrow null bitmap | 1,000 bits = 125 bytes + 100 × 8 bytes (non-null values) = 925 bytes |
| **Savings** | **82%** |

### 5.3 Alignment and Padding

Arrow buffers are aligned to 64-byte boundaries for SIMD compatibility. For a column of 1,000 Int64 values:
- Data: 1,000 × 8 bytes = 8,000 bytes
- Padded: 8,000 bytes (already 64-byte aligned)
- Null bitmap: ceil(1,000/8) = 125 bytes, padded to 128 bytes

---

## 6. Extension Points

### 6.1 Embedding Column (Optional)

For use cases requiring vector co-location (local consolidation, offline similarity):

```typescript
// Add to schema when needed
new Field('embedding', new FixedSizeList(384,
  new Field('dim', new Float32(), false)), true)
```

Size impact: 384 × 4 bytes = 1,536 bytes per record. For 1,000 records, adds ~1.5MB.

### 6.2 CRDT Columns (Optional, for F5 integration)

```typescript
// HLC timestamp for CRDT-enabled records
new Field('crdt_wall_ms', new Int64(), true),
new Field('crdt_counter', new Int32(), true),
new Field('crdt_node_id', new Dictionary(new Utf8(), new Int32()), true),
```

### 6.3 Causal Edge Columns (Optional, for F3 integration)

For representing causal graph edges as an Arrow Table:

```typescript
export const CAUSAL_EDGE_SCHEMA = new Schema([
  new Field('cause_key', new Utf8(), false),
  new Field('cause_namespace', new Dictionary(new Utf8(), new Int32()), false),
  new Field('effect_key', new Utf8(), false),
  new Field('effect_namespace', new Dictionary(new Utf8(), new Int32()), false),
  new Field('confidence', new Float64(), false),
  new Field('evidence', new Utf8(), true),
  new Field('created_at', new Int64(), false),
  new Field('created_by', new Dictionary(new Utf8(), new Int32()), true),
])
```

### 6.4 Attachment Columns (Optional, for F7 integration)

```typescript
// Nested struct for attachment metadata
new Field('attachment_count', new Int32(), true),
new Field('attachment_types', new Utf8(), true), // JSON array of types
new Field('attachment_total_bytes', new Int64(), true),
```

---

## 7. Testing Checklist

| Test | Description |
|------|-------------|
| Schema construction | Verify MEMORY_FRAME_SCHEMA creates valid Arrow Schema |
| Round-trip: Record → Arrow → Record | 100 diverse records, verify field equality after round-trip |
| Null handling | Records without _temporal, _decay, _provenance map to null columns correctly |
| Dictionary encoding | Verify namespace, agent_id, category use integer indices |
| Schema version in metadata | Verify version stored and retrievable |
| Forward compat: unknown columns ignored | Reader with v1 schema reads v2 table (extra columns) without error |
| Large batch: 10K records | Verify schema handles 10K records without OOM |
| Timestamp precision | Int64 epoch ms values survive round-trip without loss |
| UTF-8 content | Multi-byte Unicode in text/payload_json preserved |
| Empty batch | Zero records produces valid but empty Table |
