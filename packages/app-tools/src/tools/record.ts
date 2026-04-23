import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { DomainToolDefinition } from '../types.js'
import type { ExecutableDomainTool } from './shared.js'

/**
 * record.* — namespaced append-only record store tools.
 *
 * The underlying store is an injected `Map<string, string[]>`. This keeps the
 * tools stateless with respect to module loading while letting callers share
 * a single store across tools, hold a read-only reference for inspection, or
 * swap in a persistent implementation.
 *
 * When `RecordToolOptions.recordsDir` is provided, `record.append` also writes
 * each entry as a JSONL line to `{recordsDir}/{namespace}.jsonl` for durable
 * persistence. The in-memory store is always updated regardless.
 */

export interface RecordToolOptions {
  /**
   * Directory for durable record storage. When set, `record.append` appends
   * each entry as a JSONL line to `{recordsDir}/{namespace}.jsonl`.
   * Defaults to in-memory only when omitted.
   */
  recordsDir?: string
}

// ---------------------------------------------------------------------------
// record.append
// ---------------------------------------------------------------------------

interface AppendInput {
  entry: string
  namespace?: string
}

interface AppendOutput {
  namespace: string
  count: number
}

function buildRecordAppend(
  store: Map<string, string[]>,
  opts: RecordToolOptions,
): ExecutableDomainTool<AppendInput, AppendOutput> {
  const { recordsDir } = opts
  const description = recordsDir
    ? 'Append an entry to a namespaced record store backed by JSONL files.'
    : 'Append an entry to an in-memory namespaced record store.'
  const sideEffectDesc = recordsDir
    ? 'Mutates the in-memory store and appends to a JSONL file on disk.'
    : 'Mutates the in-memory record store.'

  const definition: DomainToolDefinition = {
    name: 'record.append',
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['entry'],
      properties: {
        entry: { type: 'string' },
        namespace: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['namespace', 'count'],
      properties: {
        namespace: { type: 'string' },
        count: { type: 'integer', minimum: 0 },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: sideEffectDesc,
      },
    ],
    namespace: 'record',
  }

  return {
    definition,
    async execute(input: AppendInput): Promise<AppendOutput> {
      const ns = input.namespace ?? 'default'
      const bucket = store.get(ns) ?? []
      bucket.push(input.entry)
      store.set(ns, bucket)

      if (recordsDir) {
        const filePath = path.join(recordsDir, `${ns}.jsonl`)
        const line = JSON.stringify({ entry: input.entry, ts: new Date().toISOString() }) + '\n'
        await fs.mkdir(recordsDir, { recursive: true })
        await fs.appendFile(filePath, line, 'utf8')
      }

      return { namespace: ns, count: bucket.length }
    },
  }
}

// ---------------------------------------------------------------------------
// record.list
// ---------------------------------------------------------------------------

interface ListInput {
  namespace?: string
}

interface ListOutput {
  namespace: string
  entries: string[]
}

function buildRecordList(
  store: Map<string, string[]>,
): ExecutableDomainTool<ListInput, ListOutput> {
  const definition: DomainToolDefinition = {
    name: 'record.list',
    description: 'List all entries for a given record namespace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        namespace: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['namespace', 'entries'],
      properties: {
        namespace: { type: 'string' },
        entries: { type: 'array', items: { type: 'string' } },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'record',
  }

  return {
    definition,
    async execute(input: ListInput): Promise<ListOutput> {
      const ns = input.namespace ?? 'default'
      const bucket = store.get(ns) ?? []
      return { namespace: ns, entries: [...bucket] }
    },
  }
}

// ---------------------------------------------------------------------------
// record.clear
// ---------------------------------------------------------------------------

interface ClearInput {
  namespace?: string
}

interface ClearOutput {
  namespace: string
  cleared: number
}

function buildRecordClear(
  store: Map<string, string[]>,
): ExecutableDomainTool<ClearInput, ClearOutput> {
  const definition: DomainToolDefinition = {
    name: 'record.clear',
    description: 'Clear all entries for a given record namespace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        namespace: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['namespace', 'cleared'],
      properties: {
        namespace: { type: 'string' },
        cleared: { type: 'integer', minimum: 0 },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Drops all entries in a record namespace.',
      },
    ],
    namespace: 'record',
  }

  return {
    definition,
    async execute(input: ClearInput): Promise<ClearOutput> {
      const ns = input.namespace ?? 'default'
      const bucket = store.get(ns) ?? []
      const cleared = bucket.length
      store.set(ns, [])
      return { namespace: ns, cleared }
    },
  }
}

export function buildRecordTools(
  store: Map<string, string[]>,
  opts: RecordToolOptions = {},
): ExecutableDomainTool[] {
  return [
    buildRecordAppend(store, opts) as unknown as ExecutableDomainTool,
    buildRecordList(store) as unknown as ExecutableDomainTool,
    buildRecordClear(store) as unknown as ExecutableDomainTool,
  ]
}
