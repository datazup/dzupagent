# 07 -- Cross-Framework Memory Adapters

> **Priority:** P1 | **Effort:** 12h | **Package:** `@dzipagent/memory-ipc`
> **Depends on:** 02-MEMORYFRAME-SCHEMA.md (MemoryFrame schema), 03-IPC-PACKAGE.md (FrameBuilder/FrameReader)

---

## Overview

DzipAgent's memory system uses `Record<string, unknown>` with convention-based metadata fields (`_temporal`, `_decay`, `_provenance`). External agent frameworks -- Mastra, LangGraph, Mem0, Letta/MemGPT, and MCP Knowledge Graph servers -- each have their own memory formats. Cross-framework adapters provide bidirectional conversion between these formats and the MemoryFrame Arrow schema.

Each adapter implements the `MemoryFrameAdapter<TExternal>` interface, enabling uniform import/export regardless of the source system.

---

## 1. Adapter Interface

```typescript
// @dzipagent/memory-ipc/src/adapters/adapter-interface.ts

import { Table } from 'apache-arrow'

/**
 * Bidirectional adapter between an external memory format and the
 * DzipAgent MemoryFrame Arrow schema.
 *
 * Adapters are stateless -- they transform data but do not manage connections
 * or persistence. The caller is responsible for fetching/pushing records
 * to/from the external system.
 *
 * @typeParam TExternal  The external framework's record type
 *
 * @example
 * ```ts
 * const adapter = new MastraAdapter()
 *
 * // Import: Mastra observations --> Arrow Table
 * const mastraRecords = await mastraClient.getMemories(threadId)
 * const frame = adapter.toFrame(mastraRecords)
 *
 * // Export: Arrow Table --> Mastra observations
 * const forgeFrame = await memoryIpc.exportFrame('lessons', scope)
 * const mastraFormat = adapter.fromFrame(forgeFrame)
 * await mastraClient.addMemories(mastraFormat)
 * ```
 */
export interface MemoryFrameAdapter<TExternal> {
  /**
   * Identifier for the source system.
   * Used in provenance tracking (provenance_source = `imported:${sourceSystem}`).
   */
  readonly sourceSystem: string

  /**
   * Field mapping from external format to MemoryFrame columns.
   *
   * Keys are MemoryFrame column names, values are dot-paths into the external
   * record type. Used for documentation and debugging -- the actual mapping
   * logic is in toFrame/fromFrame.
   *
   * Example: { 'text': 'observation.content', 'valid_from': 'observation.date' }
   */
  readonly fieldMapping: Record<string, string>

  /**
   * Convert external records to a MemoryFrame Arrow Table.
   *
   * @param records  Array of external records
   * @returns        Arrow Table conforming to MEMORY_FRAME_SCHEMA
   * @throws         Never -- invalid records are skipped with warnings
   */
  toFrame(records: TExternal[]): Table

  /**
   * Convert a MemoryFrame Arrow Table back to external format.
   *
   * @param table  Arrow Table conforming to MEMORY_FRAME_SCHEMA
   * @returns      Array of external records
   */
  fromFrame(table: Table): TExternal[]

  /**
   * Type guard: check if an unknown record matches this adapter's expected format.
   *
   * @param record  Unknown record to check
   * @returns       True if the record can be adapted by this adapter
   */
  canAdapt(record: unknown): record is TExternal

  /**
   * Validate a batch of records and return warnings for any that cannot be adapted.
   *
   * @param records  Array of unknown records
   * @returns        Validation result with valid/invalid counts and warnings
   */
  validate(records: unknown[]): AdapterValidationResult
}

export interface AdapterValidationResult {
  /** Number of records that can be adapted */
  valid: number
  /** Number of records that failed validation */
  invalid: number
  /** Per-record warnings (field missing, type mismatch, etc.) */
  warnings: Array<{
    index: number
    field: string
    message: string
  }>
}

/**
 * Registry of all available adapters, keyed by source system name.
 *
 * @example
 * ```ts
 * const registry = createAdapterRegistry()
 * const adapter = registry.get('mastra')
 * if (adapter && adapter.canAdapt(record)) {
 *   const frame = adapter.toFrame([record])
 * }
 * ```
 */
export interface AdapterRegistry {
  get(sourceSystem: string): MemoryFrameAdapter<unknown> | undefined
  register<T>(adapter: MemoryFrameAdapter<T>): void
  list(): string[]
}

export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<string, MemoryFrameAdapter<unknown>>()
  return {
    get: (name) => adapters.get(name),
    register: (adapter) => adapters.set(adapter.sourceSystem, adapter as MemoryFrameAdapter<unknown>),
    list: () => Array.from(adapters.keys()),
  }
}
```

---

## 2. Adapter 1: Mastra (`mastra-adapter.ts`)

### 2.1 Mastra Memory Model

Mastra (v0.4+) provides three memory types:

1. **Observational Memory**: dated observations with priority scores, extracted by `agent.memory.remember()`. Stored per-thread with `resourceId` (user/tenant ID).
2. **Working Memory**: markdown-formatted scratchpad, auto-updated each turn via XML tags. Contains structured state the agent maintains.
3. **Semantic Recall**: vector-retrieved conversation messages from `MemoryStore`, used for recall across threads.

Mastra's observation format (from `@mastra/memory`):

```typescript
// Mastra types (external, not controlled by us)
interface MastraObservation {
  content: string          // observation text
  date: string             // ISO 8601 date
  priority: number         // 1 (low) - 5 (critical)
  threadId: string         // conversation thread
  resourceId: string       // user/tenant identifier
  agentId?: string         // agent that created it
  tags?: string[]          // optional categorization
  id?: string              // unique ID
  createdAt?: string       // creation timestamp
}

interface MastraWorkingMemory {
  content: string          // markdown scratchpad
  threadId: string
  resourceId: string
  updatedAt: string
}

interface MastraSemanticRecall {
  messages: Array<{
    role: 'user' | 'assistant' | 'system'
    content: string
    threadId: string
    createdAt: string
  }>
  threadId: string
  resourceId: string
}
```

### 2.2 Field Mapping

| MemoryFrame Column | Mastra Source | Transform |
|---|---|---|
| `id` | `observation.id` or generated UUID | Direct or generate |
| `namespace` | `'observations'` (hardcoded for observations) | Static |
| `key` | `observation.id` or `obs-${index}` | Direct or generate |
| `scope_tenant` | `observation.resourceId` | Direct |
| `scope_session` | `observation.threadId` | Direct |
| `scope_agent` | `observation.agentId` | Direct (nullable) |
| `text` | `observation.content` | Direct |
| `payload_json` | `JSON.stringify({ tags: observation.tags })` | Wrap remaining fields |
| `system_created_at` | `Date.parse(observation.createdAt)` or `Date.now()` | Parse ISO to epoch ms |
| `valid_from` | `Date.parse(observation.date)` | Parse ISO to epoch ms |
| `importance` | `observation.priority / 5.0` | Normalize 1-5 to 0.0-1.0 |
| `category` | `'observation'` | Static |
| `agent_id` | `observation.agentId` | Direct |
| `provenance_source` | `'imported'` | Static |
| `is_active` | `true` | Static |
| `decay_strength` | `null` (Mastra has no decay model) | Not mapped |

Reverse mapping (MemoryFrame to Mastra):

| Mastra Field | MemoryFrame Source | Transform |
|---|---|---|
| `content` | `text` | Direct |
| `date` | `valid_from` | Epoch ms to ISO 8601 |
| `priority` | `Math.round(importance * 5)` | Scale 0.0-1.0 to 1-5, clamp to [1,5] |
| `threadId` | `scope_session` | Direct |
| `resourceId` | `scope_tenant` | Direct |
| `agentId` | `scope_agent` or `agent_id` | Direct |
| `tags` | `JSON.parse(payload_json).tags` | Extract from payload |
| `id` | `id` | Direct |
| `createdAt` | `system_created_at` | Epoch ms to ISO 8601 |

### 2.3 Implementation

```typescript
// @dzipagent/memory-ipc/src/adapters/mastra-adapter.ts

import { Table, tableFromArrays, Utf8, Float64, Int64, Int32, Bool, Dictionary } from 'apache-arrow'
import type { MemoryFrameAdapter, AdapterValidationResult } from './adapter-interface.js'
import { MEMORY_FRAME_SCHEMA } from '../memory-frame-schema.js'

/**
 * Mastra observation record -- represents what @mastra/memory produces.
 * This type mirrors Mastra's internal format; we do not import their types
 * to avoid a hard dependency.
 */
export interface MastraObservation {
  content: string
  date: string
  priority: number
  threadId: string
  resourceId: string
  agentId?: string
  tags?: string[]
  id?: string
  createdAt?: string
}

export class MastraAdapter implements MemoryFrameAdapter<MastraObservation> {
  readonly sourceSystem = 'mastra'

  readonly fieldMapping: Record<string, string> = {
    id: 'id',
    namespace: '"observations" (static)',
    key: 'id',
    scope_tenant: 'resourceId',
    scope_session: 'threadId',
    scope_agent: 'agentId',
    text: 'content',
    payload_json: 'JSON.stringify({ tags })',
    system_created_at: 'Date.parse(createdAt)',
    valid_from: 'Date.parse(date)',
    importance: 'priority / 5.0',
    category: '"observation" (static)',
    agent_id: 'agentId',
    provenance_source: '"imported" (static)',
  }

  canAdapt(record: unknown): record is MastraObservation {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>
    return (
      typeof r['content'] === 'string' &&
      typeof r['date'] === 'string' &&
      typeof r['priority'] === 'number' &&
      typeof r['threadId'] === 'string' &&
      typeof r['resourceId'] === 'string'
    )
  }

  validate(records: unknown[]): AdapterValidationResult {
    let valid = 0
    let invalid = 0
    const warnings: AdapterValidationResult['warnings'] = []

    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      if (this.canAdapt(r)) {
        valid++
        // Check optional field quality
        const obs = r as MastraObservation
        if (obs.priority < 1 || obs.priority > 5) {
          warnings.push({ index: i, field: 'priority', message: `Priority ${obs.priority} outside expected range 1-5, will be clamped` })
        }
        if (obs.date && isNaN(Date.parse(obs.date))) {
          warnings.push({ index: i, field: 'date', message: `Invalid date format: ${obs.date}` })
        }
      } else {
        invalid++
        if (r === null || typeof r !== 'object') {
          warnings.push({ index: i, field: '*', message: 'Record is not an object' })
        } else {
          const obj = r as Record<string, unknown>
          if (typeof obj['content'] !== 'string') warnings.push({ index: i, field: 'content', message: 'Missing or non-string content' })
          if (typeof obj['date'] !== 'string') warnings.push({ index: i, field: 'date', message: 'Missing or non-string date' })
          if (typeof obj['priority'] !== 'number') warnings.push({ index: i, field: 'priority', message: 'Missing or non-number priority' })
          if (typeof obj['threadId'] !== 'string') warnings.push({ index: i, field: 'threadId', message: 'Missing or non-string threadId' })
          if (typeof obj['resourceId'] !== 'string') warnings.push({ index: i, field: 'resourceId', message: 'Missing or non-string resourceId' })
        }
      }
    }

    return { valid, invalid, warnings }
  }

  toFrame(records: MastraObservation[]): Table {
    const now = Date.now()

    const ids: string[] = []
    const namespaces: string[] = []
    const keys: string[] = []
    const scopeTenants: (string | null)[] = []
    const scopeSessions: (string | null)[] = []
    const scopeAgents: (string | null)[] = []
    const scopeProjects: (string | null)[] = []
    const texts: (string | null)[] = []
    const payloads: (string | null)[] = []
    const systemCreatedAts: bigint[] = []
    const systemExpiredAts: (bigint | null)[] = []
    const validFroms: bigint[] = []
    const validUntils: (bigint | null)[] = []
    const decayStrengths: (number | null)[] = []
    const decayHalfLifes: (number | null)[] = []
    const decayLastAccessed: (bigint | null)[] = []
    const decayAccessCounts: (bigint | null)[] = []
    const agentIds: (string | null)[] = []
    const categories: (string | null)[] = []
    const importances: (number | null)[] = []
    const provenanceSources: (string | null)[] = []
    const isActives: boolean[] = []

    for (let i = 0; i < records.length; i++) {
      const obs = records[i]
      const id = obs.id ?? `mastra-obs-${i}-${now}`
      const createdMs = obs.createdAt ? Date.parse(obs.createdAt) : now
      const validMs = Date.parse(obs.date) || now

      ids.push(id)
      namespaces.push('observations')
      keys.push(id)
      scopeTenants.push(obs.resourceId)
      scopeSessions.push(obs.threadId)
      scopeAgents.push(obs.agentId ?? null)
      scopeProjects.push(null)
      texts.push(obs.content)
      payloads.push(obs.tags && obs.tags.length > 0 ? JSON.stringify({ tags: obs.tags }) : null)
      systemCreatedAts.push(BigInt(createdMs))
      systemExpiredAts.push(null)
      validFroms.push(BigInt(validMs))
      validUntils.push(null)
      decayStrengths.push(null)
      decayHalfLifes.push(null)
      decayLastAccessed.push(null)
      decayAccessCounts.push(null)
      agentIds.push(obs.agentId ?? null)
      categories.push('observation')
      importances.push(Math.max(0, Math.min(1, obs.priority / 5.0)))
      provenanceSources.push('imported')
      isActives.push(true)
    }

    // Build Arrow Table using MEMORY_FRAME_SCHEMA
    // (Actual implementation uses FrameBuilder from 03-IPC-PACKAGE)
    return tableFromArrays({
      id: ids,
      namespace: namespaces,
      key: keys,
      scope_tenant: scopeTenants,
      scope_project: scopeProjects,
      scope_agent: scopeAgents,
      scope_session: scopeSessions,
      text: texts,
      payload_json: payloads,
      system_created_at: systemCreatedAts,
      system_expired_at: systemExpiredAts,
      valid_from: validFroms,
      valid_until: validUntils,
      decay_strength: decayStrengths,
      decay_half_life_ms: decayHalfLifes,
      decay_last_accessed_at: decayLastAccessed,
      decay_access_count: decayAccessCounts,
      agent_id: agentIds,
      category: categories,
      importance: importances,
      provenance_source: provenanceSources,
      is_active: isActives,
    })
  }

  fromFrame(table: Table): MastraObservation[] {
    const results: MastraObservation[] = []
    const numRows = table.numRows

    const textCol = table.getChild('text')
    const validFromCol = table.getChild('valid_from')
    const importanceCol = table.getChild('importance')
    const sessionCol = table.getChild('scope_session')
    const tenantCol = table.getChild('scope_tenant')
    const agentCol = table.getChild('scope_agent')
    const idCol = table.getChild('id')
    const createdCol = table.getChild('system_created_at')
    const payloadCol = table.getChild('payload_json')

    for (let i = 0; i < numRows; i++) {
      const content = textCol?.get(i) as string | null
      if (content === null) continue // Skip records without text

      const validFrom = validFromCol?.get(i) as bigint | null
      const importance = importanceCol?.get(i) as number | null
      const priority = importance !== null ? Math.max(1, Math.min(5, Math.round(importance * 5))) : 3

      const obs: MastraObservation = {
        content,
        date: validFrom !== null ? new Date(Number(validFrom)).toISOString() : new Date().toISOString(),
        priority,
        threadId: (sessionCol?.get(i) as string | null) ?? 'unknown',
        resourceId: (tenantCol?.get(i) as string | null) ?? 'unknown',
      }

      const agentId = agentCol?.get(i) as string | null
      if (agentId !== null) obs.agentId = agentId

      const id = idCol?.get(i) as string | null
      if (id !== null) obs.id = id

      const created = createdCol?.get(i) as bigint | null
      if (created !== null) obs.createdAt = new Date(Number(created)).toISOString()

      const payload = payloadCol?.get(i) as string | null
      if (payload !== null) {
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>
          if (Array.isArray(parsed['tags'])) {
            obs.tags = parsed['tags'] as string[]
          }
        } catch {
          // Non-fatal: payload parse failure is ignored
        }
      }

      results.push(obs)
    }

    return results
  }
}
```

### 2.4 Mastra Token Compression Markers

Mastra uses `[COMPRESSED]` markers in working memory when the scratchpad exceeds the token limit. The adapter handles these:

```typescript
/**
 * Detect and handle Mastra's compression markers in working memory content.
 * Returns the uncompressed portions alongside a flag indicating compression.
 */
export function parseMastraWorkingMemory(content: string): {
  sections: Array<{ key: string; value: string }>
  wasCompressed: boolean
}
```

### 2.5 Edge Cases

- Observation with `priority` outside 1-5: clamp to range
- Observation with invalid `date` ISO string: fall back to `Date.now()`
- Missing `agentId`: set `scope_agent` and `agent_id` to null
- Empty `tags` array: set `payload_json` to null (not `{"tags":[]}`)
- Working memory (markdown scratchpad): stored in `payload_json` with `category: 'working-memory'`

### 2.6 Round-Trip Test Cases

| Test | Description |
|------|-------------|
| `mastra-roundtrip-basic` | 5 observations, toFrame then fromFrame, verify content/date/priority equality |
| `mastra-roundtrip-tags` | Observation with tags=['api','auth'], verify tags survive round-trip via payload_json |
| `mastra-roundtrip-priority-normalization` | Priority 3 in Mastra -> importance 0.6 in Arrow -> priority 3 in Mastra |
| `mastra-priority-clamp` | Priority 0 clamped to 1, priority 7 clamped to 5 |
| `mastra-invalid-date` | Date "not-a-date" falls back to current time |
| `mastra-missing-optional` | No agentId, no tags, no id: adapter produces valid frame with nulls |
| `mastra-canAdapt-positive` | Valid Mastra observation object: canAdapt returns true |
| `mastra-canAdapt-negative` | Object missing 'content': canAdapt returns false |
| `mastra-validate-mixed` | 3 valid + 2 invalid records: validate returns valid=3, invalid=2 with warnings |
| `mastra-compression-markers` | Working memory with `[COMPRESSED]` marker: detected and flagged |

---

## 3. Adapter 2: LangGraph Store (`langgraph-adapter.ts`)

### 3.1 LangGraph Store Model

LangGraph's `BaseStore` uses namespace tuples and key-value pairs:

```typescript
// LangGraph types (from @langchain/langgraph)
interface StoreItem {
  value: Record<string, unknown>
  key: string
  namespace: string[]
  createdAt: Date
  updatedAt: Date
}

interface StoreSearchResult extends StoreItem {
  score?: number
}
```

Namespace convention: `[tenantId, category, subcategory, ...]`

### 3.2 Field Mapping

| MemoryFrame Column | LangGraph Source | Transform |
|---|---|---|
| `id` | `item.key` or generated | Direct |
| `namespace` | `item.namespace[1]` (second element) | Extract from tuple |
| `key` | `item.key` | Direct |
| `scope_tenant` | `item.namespace[0]` (first element) | Extract from tuple |
| `scope_project` | `item.namespace[2]` if present | Extract from tuple |
| `text` | `item.value.text` | Direct |
| `payload_json` | `JSON.stringify(remainingFields)` | Remaining value fields |
| `system_created_at` | `item.createdAt.getTime()` | Date to epoch ms |
| `valid_from` | `item.createdAt.getTime()` | Same as system_created_at (LangGraph has no bi-temporal) |
| `importance` | `item.value.confidence` or `item.value.importance` | Extract if present |
| `category` | `item.value.type` or `item.value.category` | Extract if present |
| `is_active` | `true` | Static |
| `provenance_source` | `'imported'` | Static |

Reverse mapping:

| LangGraph Field | MemoryFrame Source | Transform |
|---|---|---|
| `namespace[0]` | `scope_tenant` | Direct |
| `namespace[1]` | `namespace` | Direct |
| `namespace[2]` | `scope_project` (if not null) | Conditional |
| `key` | `key` | Direct |
| `value.text` | `text` | Direct |
| `value.*` | `JSON.parse(payload_json)` | Merge overflow fields |
| `createdAt` | `new Date(system_created_at)` | Epoch ms to Date |
| `updatedAt` | `new Date(system_created_at)` | Same (no separate update time) |

### 3.3 Implementation

```typescript
// @dzipagent/memory-ipc/src/adapters/langgraph-adapter.ts

import { Table } from 'apache-arrow'
import type { MemoryFrameAdapter, AdapterValidationResult } from './adapter-interface.js'

/**
 * LangGraph store item -- mirrors the StoreItem from @langchain/langgraph.
 * We use our own type to avoid a runtime dependency.
 */
export interface LangGraphStoreItem {
  value: Record<string, unknown>
  key: string
  namespace: string[]
  createdAt: Date
  updatedAt: Date
  score?: number
}

export class LangGraphAdapter implements MemoryFrameAdapter<LangGraphStoreItem> {
  readonly sourceSystem = 'langgraph'

  readonly fieldMapping: Record<string, string> = {
    id: 'key',
    namespace: 'namespace[1]',
    key: 'key',
    scope_tenant: 'namespace[0]',
    scope_project: 'namespace[2]',
    text: 'value.text',
    payload_json: 'JSON.stringify(remainingValueFields)',
    system_created_at: 'createdAt.getTime()',
    valid_from: 'createdAt.getTime()',
  }

  canAdapt(record: unknown): record is LangGraphStoreItem {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>
    return (
      typeof r['key'] === 'string' &&
      Array.isArray(r['namespace']) &&
      typeof r['value'] === 'object' &&
      r['value'] !== null &&
      r['createdAt'] instanceof Date
    )
  }

  validate(records: unknown[]): AdapterValidationResult {
    let valid = 0
    let invalid = 0
    const warnings: AdapterValidationResult['warnings'] = []

    for (let i = 0; i < records.length; i++) {
      if (this.canAdapt(records[i])) {
        valid++
        const item = records[i] as LangGraphStoreItem
        if (item.namespace.length < 2) {
          warnings.push({ index: i, field: 'namespace', message: 'Namespace tuple has fewer than 2 elements; namespace column will be empty' })
        }
      } else {
        invalid++
        warnings.push({ index: i, field: '*', message: 'Does not match LangGraphStoreItem shape' })
      }
    }

    return { valid, invalid, warnings }
  }

  toFrame(records: LangGraphStoreItem[]): Table {
    // Build column arrays from records, extracting namespace tuple elements
    // and separating value.text from remaining fields into payload_json
    // (Pattern identical to MastraAdapter.toFrame but with different field extraction)
    // Implementation builds typed arrays and calls tableFromArrays()
    throw new Error('Implementation follows FrameBuilder pattern from 03-IPC-PACKAGE')
  }

  fromFrame(table: Table): LangGraphStoreItem[] {
    const results: LangGraphStoreItem[] = []
    const numRows = table.numRows

    for (let i = 0; i < numRows; i++) {
      const key = table.getChild('key')?.get(i) as string
      const tenant = table.getChild('scope_tenant')?.get(i) as string | null
      const ns = table.getChild('namespace')?.get(i) as string | null
      const project = table.getChild('scope_project')?.get(i) as string | null
      const text = table.getChild('text')?.get(i) as string | null
      const payload = table.getChild('payload_json')?.get(i) as string | null
      const created = table.getChild('system_created_at')?.get(i) as bigint | null

      // Reconstruct namespace tuple
      const namespace: string[] = []
      if (tenant !== null) namespace.push(tenant)
      if (ns !== null) namespace.push(ns)
      if (project !== null) namespace.push(project)

      // Reconstruct value
      const value: Record<string, unknown> = {}
      if (text !== null) value['text'] = text
      if (payload !== null) {
        try {
          Object.assign(value, JSON.parse(payload))
        } catch { /* non-fatal */ }
      }

      const createdAt = created !== null ? new Date(Number(created)) : new Date()

      results.push({
        key,
        namespace,
        value,
        createdAt,
        updatedAt: createdAt,
      })
    }

    return results
  }
}
```

### 3.4 Checkpointer State Integration

LangGraph checkpointers store graph state alongside the store. When importing from a LangGraph checkpoint:

```typescript
/**
 * Extract memory-relevant records from a LangGraph checkpoint.
 *
 * Checkpointer state contains the full graph state including messages,
 * channel values, and metadata. This function filters to only the
 * store items (namespace-keyed records) that represent memory.
 *
 * @param checkpointState  Full checkpoint state from LangGraph
 * @returns                Store items suitable for LangGraphAdapter.toFrame()
 */
export function extractStoreItemsFromCheckpoint(
  checkpointState: Record<string, unknown>,
): LangGraphStoreItem[]
```

### 3.5 Test Cases

| Test | Description |
|------|-------------|
| `langgraph-roundtrip-basic` | 5 store items, toFrame then fromFrame, verify key/namespace/value equality |
| `langgraph-namespace-2-element` | Namespace ['t1', 'decisions'], verify scope_tenant='t1', namespace='decisions' |
| `langgraph-namespace-3-element` | Namespace ['t1', 'decisions', 'arch'], verify scope_project='arch' |
| `langgraph-namespace-1-element` | Namespace ['t1'] only, namespace column gets empty string, warning emitted |
| `langgraph-value-text-extraction` | value.text='hello', verify text column, payload_json excludes text |
| `langgraph-value-no-text` | value has no text field, text column is null |
| `langgraph-canAdapt` | Valid StoreItem: true; missing namespace array: false |

---

## 4. Adapter 3: Mem0 (`mem0-adapter.ts`)

### 4.1 Mem0 Memory Model

Mem0 provides a managed memory layer with:

```typescript
// Mem0 types (from mem0ai package)
interface Mem0Memory {
  id: string
  memory: string           // the core memory text
  user_id: string
  agent_id?: string
  metadata?: Record<string, unknown>
  created_at: string       // ISO 8601
  updated_at: string       // ISO 8601
  hash?: string            // content hash for dedup
  categories?: string[]    // auto-categorized tags
}

interface Mem0GraphMemory {
  entities: Array<{
    source: string
    relation: string
    destination: string
    source_type: string
    destination_type: string
  }>
}

// Mem0 operation types (from add() response)
type Mem0Operation = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP'

interface Mem0AddResult {
  results: Array<{
    id: string
    memory: string
    event: Mem0Operation
    previous_memory?: string
  }>
}
```

### 4.2 Field Mapping

| MemoryFrame Column | Mem0 Source | Transform |
|---|---|---|
| `id` | `memory.id` | Direct |
| `namespace` | `'mem0-memories'` or inferred from `categories[0]` | Category-based |
| `key` | `memory.id` | Direct |
| `scope_tenant` | `memory.user_id` | Direct |
| `scope_agent` | `memory.agent_id` | Direct (nullable) |
| `text` | `memory.memory` | Direct |
| `payload_json` | `JSON.stringify({ metadata, categories, hash })` | Wrap extra fields |
| `system_created_at` | `Date.parse(memory.created_at)` | ISO to epoch ms |
| `valid_from` | `Date.parse(memory.created_at)` | Same as created |
| `importance` | `metadata.importance` or `0.5` | Extract if present |
| `category` | `categories[0]` or `'semantic'` | First category |
| `provenance_source` | `'imported'` | Static |
| `is_active` | `true` | Static |

### 4.3 Graph Memory Handling

Mem0's graph memories (entities + relations) map to the CAUSAL_EDGE_SCHEMA (from doc 02):

```typescript
/**
 * Convert Mem0 graph memory (entity triples) to Arrow Table
 * using the CAUSAL_EDGE_SCHEMA.
 *
 * Mem0 triple: { source, relation, destination, source_type, destination_type }
 * Maps to: cause_key=source, effect_key=destination, evidence=relation
 *
 * @param graphMemory  Mem0 graph memory response
 * @returns            Arrow Table with causal edge schema
 */
export function mem0GraphToEdgeFrame(graphMemory: Mem0GraphMemory): Table
```

### 4.4 Mem0 Operation Handling

Mem0's `add()` returns operations (ADD/UPDATE/DELETE/NOOP). The adapter provides helpers:

```typescript
/**
 * Apply Mem0 add() results to an existing MemoryFrame.
 *
 * - ADD: insert new row
 * - UPDATE: replace text for existing ID
 * - DELETE: mark row as inactive (set system_expired_at)
 * - NOOP: no change
 *
 * Returns a new Table with the operations applied.
 */
export function applyMem0Operations(
  existingFrame: Table,
  operations: Mem0AddResult,
): Table
```

### 4.5 Implementation Sketch

```typescript
// @dzipagent/memory-ipc/src/adapters/mem0-adapter.ts

export interface Mem0Memory {
  id: string
  memory: string
  user_id: string
  agent_id?: string
  metadata?: Record<string, unknown>
  created_at: string
  updated_at: string
  hash?: string
  categories?: string[]
}

export class Mem0Adapter implements MemoryFrameAdapter<Mem0Memory> {
  readonly sourceSystem = 'mem0'

  readonly fieldMapping: Record<string, string> = {
    id: 'id',
    text: 'memory',
    scope_tenant: 'user_id',
    scope_agent: 'agent_id',
    system_created_at: 'Date.parse(created_at)',
    category: 'categories[0]',
    payload_json: 'JSON.stringify({ metadata, categories, hash })',
  }

  canAdapt(record: unknown): record is Mem0Memory {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>
    return (
      typeof r['id'] === 'string' &&
      typeof r['memory'] === 'string' &&
      typeof r['user_id'] === 'string' &&
      typeof r['created_at'] === 'string'
    )
  }

  validate(records: unknown[]): AdapterValidationResult {
    // Validate shape, check date parsing, flag missing optional fields
    // Pattern matches MastraAdapter.validate()
    throw new Error('Implementation follows standard validation pattern')
  }

  toFrame(records: Mem0Memory[]): Table {
    // Build columns from Mem0 records
    // Pattern matches MastraAdapter.toFrame()
    throw new Error('Implementation follows FrameBuilder pattern')
  }

  fromFrame(table: Table): Mem0Memory[] {
    const results: Mem0Memory[] = []
    const numRows = table.numRows

    for (let i = 0; i < numRows; i++) {
      const id = table.getChild('id')?.get(i) as string
      const text = table.getChild('text')?.get(i) as string | null
      if (!text) continue

      const tenant = table.getChild('scope_tenant')?.get(i) as string | null
      const agent = table.getChild('scope_agent')?.get(i) as string | null
      const created = table.getChild('system_created_at')?.get(i) as bigint | null
      const payload = table.getChild('payload_json')?.get(i) as string | null

      const mem: Mem0Memory = {
        id,
        memory: text,
        user_id: tenant ?? 'unknown',
        created_at: created !== null ? new Date(Number(created)).toISOString() : new Date().toISOString(),
        updated_at: created !== null ? new Date(Number(created)).toISOString() : new Date().toISOString(),
      }

      if (agent !== null) mem.agent_id = agent

      if (payload !== null) {
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>
          if (parsed['metadata'] && typeof parsed['metadata'] === 'object') {
            mem.metadata = parsed['metadata'] as Record<string, unknown>
          }
          if (Array.isArray(parsed['categories'])) {
            mem.categories = parsed['categories'] as string[]
          }
          if (typeof parsed['hash'] === 'string') {
            mem.hash = parsed['hash']
          }
        } catch { /* non-fatal */ }
      }

      results.push(mem)
    }

    return results
  }
}
```

### 4.6 Test Cases

| Test | Description |
|------|-------------|
| `mem0-roundtrip-basic` | 5 memories, toFrame then fromFrame, verify memory/user_id/id equality |
| `mem0-graph-conversion` | 3 entity triples, mem0GraphToEdgeFrame produces 3-row edge table |
| `mem0-operation-add` | ADD operation inserts new row into frame |
| `mem0-operation-update` | UPDATE replaces text for existing ID |
| `mem0-operation-delete` | DELETE sets system_expired_at, is_active=false |
| `mem0-operation-noop` | NOOP leaves frame unchanged |
| `mem0-categories-to-namespace` | categories=['decision'] maps to category='decision' |
| `mem0-metadata-preservation` | metadata.custom_field survives round-trip in payload_json |
| `mem0-canAdapt` | Valid Mem0Memory: true; missing 'memory' field: false |

---

## 5. Adapter 4: Letta/MemGPT (`letta-adapter.ts`)

### 5.1 Letta Memory Model

Letta (formerly MemGPT) has a 3-tier memory architecture:

```typescript
// Letta types (from letta-client)
interface LettaCoreMemory {
  /** Self-editing memory blocks */
  blocks: Array<{
    label: string        // 'persona' | 'human' | custom
    value: string        // block content (editable by agent)
    limit: number        // max characters
  }>
}

interface LettaArchivalMemory {
  /** Vector-indexed long-term memories */
  passages: Array<{
    id: string
    text: string
    embedding?: number[]
    agent_id: string
    created_at: string
    metadata?: Record<string, unknown>
  }>
}

interface LettaRecallMemory {
  /** Conversation messages stored for recall */
  messages: Array<{
    id: string
    role: 'user' | 'assistant' | 'system' | 'tool'
    text: string
    created_at: string
    agent_id: string
  }>
}
```

### 5.2 Field Mapping

**Archival Memory (primary adapter target):**

| MemoryFrame Column | Letta Source | Transform |
|---|---|---|
| `id` | `passage.id` | Direct |
| `namespace` | `'archival'` | Static |
| `key` | `passage.id` | Direct |
| `scope_agent` | `passage.agent_id` | Direct |
| `text` | `passage.text` | Direct |
| `payload_json` | `JSON.stringify({ metadata })` | Wrap metadata |
| `system_created_at` | `Date.parse(passage.created_at)` | ISO to epoch ms |
| `valid_from` | `Date.parse(passage.created_at)` | Same |
| `provenance_source` | `'imported'` | Static |
| `is_active` | `true` | Static |

**Core Memory blocks -> WorkingMemory:**

Letta's core memory blocks map to DzipAgent's `WorkingMemory` concept, not to MemoryFrame records. The adapter provides a separate conversion function:

```typescript
/**
 * Convert Letta core memory blocks to DzipAgent WorkingMemory format.
 *
 * Letta's self-editing blocks (persona, human, custom) map to
 * WorkingMemory key-value pairs. The block `label` becomes the
 * WorkingMemory field name.
 *
 * @param coreMemory  Letta core memory with blocks
 * @returns           WorkingMemory-compatible record
 */
export function lettaCoreToWorkingMemory(
  coreMemory: LettaCoreMemory,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const block of coreMemory.blocks) {
    result[block.label] = block.value
  }
  return result
}

/**
 * Convert DzipAgent WorkingMemory to Letta core memory blocks.
 *
 * Each top-level string field becomes a block with label=fieldName.
 * Non-string fields are JSON.stringify'd.
 *
 * @param workingMemory  DzipAgent WorkingMemory state
 * @param blockLimit     Max characters per block (default: 2000)
 * @returns              Letta core memory blocks
 */
export function workingMemoryToLettaCore(
  workingMemory: Record<string, unknown>,
  blockLimit?: number,
): LettaCoreMemory
```

### 5.3 Agent File (.af) Integration

Letta has its own Agent File concept. The adapter provides conversion between Letta's agent state export and DzipAgent's `.af` format:

```typescript
/**
 * Convert a Letta agent state export to DzipAgent's AgentFile format.
 *
 * Maps:
 * - Letta core memory -> AgentFile.memory.workingMemory
 * - Letta archival memory -> AgentFile.memory.namespaces['archival']
 * - Letta recall memory -> AgentFile.state.conversationSummary (summarized)
 * - Letta system prompt -> AgentFile.agent.systemPrompt
 *
 * @param lettaExport  Full Letta agent state
 * @returns            DzipAgent AgentFile
 */
export function lettaExportToAgentFile(
  lettaExport: {
    coreMemory: LettaCoreMemory
    archivalMemory: LettaArchivalMemory
    recallMemory: LettaRecallMemory
    systemPrompt: string
    agentName: string
    agentId: string
  },
): AgentFile
```

### 5.4 Implementation Sketch

```typescript
// @dzipagent/memory-ipc/src/adapters/letta-adapter.ts

export interface LettaArchivalPassage {
  id: string
  text: string
  embedding?: number[]
  agent_id: string
  created_at: string
  metadata?: Record<string, unknown>
}

export class LettaAdapter implements MemoryFrameAdapter<LettaArchivalPassage> {
  readonly sourceSystem = 'letta'

  readonly fieldMapping: Record<string, string> = {
    id: 'id',
    text: 'text',
    scope_agent: 'agent_id',
    system_created_at: 'Date.parse(created_at)',
    payload_json: 'JSON.stringify({ metadata })',
  }

  canAdapt(record: unknown): record is LettaArchivalPassage {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>
    return (
      typeof r['id'] === 'string' &&
      typeof r['text'] === 'string' &&
      typeof r['agent_id'] === 'string' &&
      typeof r['created_at'] === 'string'
    )
  }

  validate(records: unknown[]): AdapterValidationResult {
    // Standard validation pattern
    throw new Error('Implementation follows standard validation pattern')
  }

  toFrame(records: LettaArchivalPassage[]): Table {
    // NOTE: if passage.embedding is present, it can optionally be stored
    // in the embedding extension column (FixedSizeList<Float32>).
    // This requires the caller to enable the embedding schema extension.
    throw new Error('Implementation follows FrameBuilder pattern')
  }

  fromFrame(table: Table): LettaArchivalPassage[] {
    const results: LettaArchivalPassage[] = []
    const numRows = table.numRows

    for (let i = 0; i < numRows; i++) {
      const id = table.getChild('id')?.get(i) as string
      const text = table.getChild('text')?.get(i) as string | null
      if (!text) continue

      const agent = table.getChild('scope_agent')?.get(i) as string | null
      const created = table.getChild('system_created_at')?.get(i) as bigint | null
      const payload = table.getChild('payload_json')?.get(i) as string | null

      const passage: LettaArchivalPassage = {
        id,
        text,
        agent_id: agent ?? 'unknown',
        created_at: created !== null ? new Date(Number(created)).toISOString() : new Date().toISOString(),
      }

      if (payload !== null) {
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>
          if (parsed['metadata'] && typeof parsed['metadata'] === 'object') {
            passage.metadata = parsed['metadata'] as Record<string, unknown>
          }
        } catch { /* non-fatal */ }
      }

      // Embedding column (optional extension)
      // If the table has an 'embedding' column, extract it
      const embeddingCol = table.getChild('embedding')
      if (embeddingCol) {
        const embeddingRow = embeddingCol.get(i)
        if (embeddingRow !== null) {
          passage.embedding = Array.from(embeddingRow as Float32Array)
        }
      }

      results.push(passage)
    }

    return results
  }
}
```

### 5.5 Test Cases

| Test | Description |
|------|-------------|
| `letta-roundtrip-archival` | 5 archival passages, toFrame then fromFrame, verify text/id/agent_id |
| `letta-core-to-working` | Core blocks [persona, human], converted to { persona: '...', human: '...' } |
| `letta-working-to-core` | WorkingMemory { goal: '...', context: '...' } -> 2 blocks |
| `letta-embedding-preserved` | Passage with 384-dim embedding, verify round-trip via extension column |
| `letta-embedding-absent` | Passage without embedding, verify null in frame, undefined in output |
| `letta-agent-file-conversion` | Full Letta export -> AgentFile, verify all sections mapped |
| `letta-canAdapt` | Valid passage: true; missing text: false |
| `letta-metadata-preservation` | metadata.source='api' survives round-trip in payload_json |

---

## 6. Adapter 5: MCP Knowledge Graph (`mcp-kg-adapter.ts`)

### 6.1 MCP Knowledge Graph Model

The official `@modelcontextprotocol/server-memory` implements a knowledge graph with JSONL persistence:

```typescript
// MCP Knowledge Graph types (from server-memory)
interface KGEntity {
  name: string
  entityType: string
  observations: string[]   // facts known about this entity
}

interface KGRelation {
  from: string             // entity name
  to: string               // entity name
  relationType: string     // e.g., 'works_at', 'depends_on'
}

// The 7 MCP tools:
// create_entities, create_relations, add_observations,
// delete_entities, delete_observations, delete_relations,
// read_graph, search_nodes, open_nodes
```

### 6.2 Entity Mapping

Each MCP entity becomes one or more MemoryFrame rows. Each observation becomes a separate row linked to the entity via the key.

| MemoryFrame Column | MCP Entity Source | Transform |
|---|---|---|
| `id` | `entity.name + '-' + obsIndex` | Generated composite |
| `namespace` | `'entities'` | Static |
| `key` | `entity.name + '-obs-' + obsIndex` | Generated |
| `text` | `observation` | Direct (one row per observation) |
| `payload_json` | `JSON.stringify({ entityName, entityType })` | Entity metadata |
| `category` | `'entity-node'` | Static |
| `importance` | `observations.length / maxObservations` (heuristic) | Proportional to knowledge |
| `is_active` | `true` | Static |

### 6.3 Relation Mapping to Causal Edge Schema

MCP relations map to the CAUSAL_EDGE_SCHEMA from doc 02:

| CAUSAL_EDGE Column | MCP Relation Source | Transform |
|---|---|---|
| `cause_key` | `relation.from` | Direct (entity name as key) |
| `cause_namespace` | `'entities'` | Static |
| `effect_key` | `relation.to` | Direct |
| `effect_namespace` | `'entities'` | Static |
| `confidence` | `1.0` (MCP has no confidence) | Static default |
| `evidence` | `relation.relationType` | Relation type as evidence |
| `created_at` | `Date.now()` | Current time |

### 6.4 Implementation

```typescript
// @dzipagent/memory-ipc/src/adapters/mcp-kg-adapter.ts

import { Table } from 'apache-arrow'
import type { MemoryFrameAdapter, AdapterValidationResult } from './adapter-interface.js'

/**
 * MCP Knowledge Graph entity -- one row per observation.
 * The adapter flattens entities with multiple observations into
 * multiple records (one per observation) for granular retrieval.
 */
export interface MCPKGEntityObservation {
  /** Entity name */
  entityName: string
  /** Entity type (e.g., 'person', 'technology', 'concept') */
  entityType: string
  /** Single observation about this entity */
  observation: string
  /** Index of this observation within the entity's observation list */
  observationIndex: number
  /** Total observations for this entity (for importance calculation) */
  totalObservations: number
}

/**
 * MCP Knowledge Graph relation triple.
 */
export interface MCPKGRelation {
  from: string
  to: string
  relationType: string
}

/**
 * MCP Knowledge Graph combined input.
 * Passed as the generic TExternal type.
 */
export interface MCPKGRecord {
  type: 'entity-observation' | 'relation'
  entityObservation?: MCPKGEntityObservation
  relation?: MCPKGRelation
}

export class MCPKGAdapter implements MemoryFrameAdapter<MCPKGRecord> {
  readonly sourceSystem = 'mcp-knowledge-graph'

  readonly fieldMapping: Record<string, string> = {
    id: 'entityName + "-obs-" + observationIndex',
    key: 'entityName + "-obs-" + observationIndex',
    text: 'observation',
    namespace: '"entities" (static)',
    category: '"entity-node" (static)',
    payload_json: 'JSON.stringify({ entityName, entityType })',
  }

  canAdapt(record: unknown): record is MCPKGRecord {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>
    if (r['type'] === 'entity-observation') {
      const eo = r['entityObservation'] as Record<string, unknown> | undefined
      return (
        eo !== undefined &&
        typeof eo['entityName'] === 'string' &&
        typeof eo['entityType'] === 'string' &&
        typeof eo['observation'] === 'string'
      )
    }
    if (r['type'] === 'relation') {
      const rel = r['relation'] as Record<string, unknown> | undefined
      return (
        rel !== undefined &&
        typeof rel['from'] === 'string' &&
        typeof rel['to'] === 'string' &&
        typeof rel['relationType'] === 'string'
      )
    }
    return false
  }

  validate(records: unknown[]): AdapterValidationResult {
    let valid = 0
    let invalid = 0
    const warnings: AdapterValidationResult['warnings'] = []

    for (let i = 0; i < records.length; i++) {
      if (this.canAdapt(records[i])) {
        valid++
      } else {
        invalid++
        warnings.push({ index: i, field: '*', message: 'Does not match MCPKGRecord shape' })
      }
    }

    return { valid, invalid, warnings }
  }

  toFrame(records: MCPKGRecord[]): Table {
    // Separate entity observations from relations
    // Entity observations -> MEMORY_FRAME_SCHEMA
    // Relations -> stored in payload_json with category 'causal-edge'
    //
    // For entity observations:
    //   id = `${entityName}-obs-${observationIndex}`
    //   text = observation
    //   category = 'entity-node'
    //   importance = totalObservations / maxObservationsAcrossEntities (heuristic)
    //   payload_json = { entityName, entityType }
    //
    // For relations:
    //   id = `rel-${from}-${relationType}-${to}`
    //   text = `${from} ${relationType} ${to}`
    //   category = 'causal-edge'
    //   payload_json = { from, to, relationType }
    throw new Error('Implementation follows FrameBuilder pattern')
  }

  fromFrame(table: Table): MCPKGRecord[] {
    const results: MCPKGRecord[] = []
    const numRows = table.numRows

    for (let i = 0; i < numRows; i++) {
      const category = table.getChild('category')?.get(i) as string | null
      const text = table.getChild('text')?.get(i) as string | null
      const payload = table.getChild('payload_json')?.get(i) as string | null

      if (!text) continue

      if (category === 'causal-edge' && payload) {
        // Reconstruct relation
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>
          results.push({
            type: 'relation',
            relation: {
              from: parsed['from'] as string,
              to: parsed['to'] as string,
              relationType: parsed['relationType'] as string,
            },
          })
        } catch { /* non-fatal */ }
      } else {
        // Reconstruct entity observation
        let entityName = 'unknown'
        let entityType = 'unknown'

        if (payload) {
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>
            if (typeof parsed['entityName'] === 'string') entityName = parsed['entityName']
            if (typeof parsed['entityType'] === 'string') entityType = parsed['entityType']
          } catch { /* non-fatal */ }
        }

        results.push({
          type: 'entity-observation',
          entityObservation: {
            entityName,
            entityType,
            observation: text,
            observationIndex: 0,
            totalObservations: 1,
          },
        })
      }
    }

    return results
  }
}

/**
 * Convenience: flatten MCP KG entities into MCPKGRecord[] for the adapter.
 *
 * Each entity with N observations becomes N MCPKGRecord entries.
 * This flattening enables per-observation granularity in the MemoryFrame.
 *
 * @param entities   MCP Knowledge Graph entities
 * @param relations  MCP Knowledge Graph relations
 * @returns          Flattened records suitable for MCPKGAdapter.toFrame()
 */
export function flattenMCPKG(
  entities: Array<{ name: string; entityType: string; observations: string[] }>,
  relations: MCPKGRelation[],
): MCPKGRecord[] {
  const records: MCPKGRecord[] = []

  for (const entity of entities) {
    for (let i = 0; i < entity.observations.length; i++) {
      records.push({
        type: 'entity-observation',
        entityObservation: {
          entityName: entity.name,
          entityType: entity.entityType,
          observation: entity.observations[i],
          observationIndex: i,
          totalObservations: entity.observations.length,
        },
      })
    }
  }

  for (const relation of relations) {
    records.push({ type: 'relation', relation })
  }

  return records
}

/**
 * Reconstruct MCP KG entities from MCPKGRecord[] (reverse of flatten).
 *
 * Groups entity observations by entityName and reassembles
 * the observations array.
 */
export function reconstructMCPKG(
  records: MCPKGRecord[],
): {
  entities: Array<{ name: string; entityType: string; observations: string[] }>
  relations: MCPKGRelation[]
} {
  const entityMap = new Map<string, { entityType: string; observations: string[] }>()
  const relations: MCPKGRelation[] = []

  for (const record of records) {
    if (record.type === 'entity-observation' && record.entityObservation) {
      const eo = record.entityObservation
      const existing = entityMap.get(eo.entityName)
      if (existing) {
        existing.observations.push(eo.observation)
      } else {
        entityMap.set(eo.entityName, {
          entityType: eo.entityType,
          observations: [eo.observation],
        })
      }
    } else if (record.type === 'relation' && record.relation) {
      relations.push(record.relation)
    }
  }

  const entities = Array.from(entityMap.entries()).map(([name, data]) => ({
    name,
    entityType: data.entityType,
    observations: data.observations,
  }))

  return { entities, relations }
}
```

### 6.5 MCP Tool Integration

The adapter provides helpers for the 7 MCP KG tools:

```typescript
/**
 * Convert a create_entities MCP tool call into MCPKGRecords.
 *
 * @param args  The tool call arguments: { entities: [{ name, entityType, observations }] }
 * @returns     MCPKGRecords ready for adapter.toFrame()
 */
export function fromCreateEntities(
  args: { entities: Array<{ name: string; entityType: string; observations: string[] }> },
): MCPKGRecord[]

/**
 * Convert a create_relations MCP tool call into MCPKGRecords.
 */
export function fromCreateRelations(
  args: { relations: Array<{ from: string; to: string; relationType: string }> },
): MCPKGRecord[]

/**
 * Build create_entities tool arguments from a MemoryFrame.
 * Used when exporting DzipAgent memories to MCP KG format.
 */
export function toCreateEntitiesArgs(
  table: Table,
): { entities: Array<{ name: string; entityType: string; observations: string[] }> }
```

### 6.6 Test Cases

| Test | Description |
|------|-------------|
| `mcp-kg-flatten-reconstruct` | 3 entities with 2,3,1 observations + 2 relations: flatten then reconstruct, verify equality |
| `mcp-kg-entity-to-frame` | Entity with 3 observations: produces 3 rows, each with correct text and entityName in payload |
| `mcp-kg-relation-to-frame` | Relation A->B: produces 1 row with category='causal-edge' |
| `mcp-kg-roundtrip` | 5 entities + 3 relations, toFrame then fromFrame, verify entity/relation equality |
| `mcp-kg-importance-heuristic` | Entity with 10 observations gets higher importance than entity with 1 |
| `mcp-kg-from-create-entities` | MCP create_entities args -> MCPKGRecord array |
| `mcp-kg-to-create-entities` | MemoryFrame -> MCP create_entities args (reverse) |
| `mcp-kg-canAdapt-entity` | Valid entity-observation record: true |
| `mcp-kg-canAdapt-relation` | Valid relation record: true |
| `mcp-kg-canAdapt-invalid` | Missing required fields: false |

---

## Appendix: File Structure

```
packages/forgeagent-memory-ipc/src/
  adapters/
    adapter-interface.ts          # MemoryFrameAdapter<T>, AdapterRegistry
    mastra-adapter.ts             # MastraAdapter, parseMastraWorkingMemory
    langgraph-adapter.ts          # LangGraphAdapter, extractStoreItemsFromCheckpoint
    mem0-adapter.ts               # Mem0Adapter, mem0GraphToEdgeFrame, applyMem0Operations
    letta-adapter.ts              # LettaAdapter, lettaCoreToWorkingMemory, workingMemoryToLettaCore
    mcp-kg-adapter.ts             # MCPKGAdapter, flattenMCPKG, reconstructMCPKG
    index.ts                      # Re-exports all adapters + createAdapterRegistry

  __tests__/
    mastra-adapter.test.ts
    langgraph-adapter.test.ts
    mem0-adapter.test.ts
    letta-adapter.test.ts
    mcp-kg-adapter.test.ts
```

**Total: 6 source files + 5 test files + 1 index = 12 files**
**Estimated effort: 12h**

---

## Appendix: Error Handling Philosophy

All adapters follow DzipAgent's "non-fatal by default" principle:

1. **`toFrame()` never throws** -- invalid records are skipped and logged via warnings
2. **`fromFrame()` never throws** -- rows with missing required columns are skipped
3. **`canAdapt()` is a pure type guard** -- no side effects, no I/O
4. **`validate()` is informational** -- returns warnings but does not prevent adaptation
5. **JSON.parse failures in payload_json** -- silently ignored, extra fields lost but core fields preserved
6. **Date parsing failures** -- fall back to `Date.now()` for timestamp columns
7. **Unknown columns in input Tables** -- ignored per forward-compatibility rules (doc 02, section 4.3)

---

## Appendix: Dependency Policy

Each adapter file mirrors the external system's types without importing them. This avoids runtime dependencies on `@mastra/memory`, `@langchain/langgraph`, `mem0ai`, `letta-client`, or `@modelcontextprotocol/server-memory`. The adapter only depends on `apache-arrow` (peer) and `@dzipagent/memory-ipc` internals.

If consumers want type-safe integration, they install both the adapter and the external SDK, then pass real objects through the adapter.
