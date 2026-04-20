import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { ClarificationPayload } from '@dzupagent/hitl-kit'
import { InMemoryDomainToolRegistry } from '../registry.js'
import type { DomainToolDefinition } from '../types.js'

/**
 * Executable wrapper around a {@link DomainToolDefinition}.
 *
 * The registry stores pure metadata (schemas, permissions). The execution map
 * returned alongside it carries the runtime behaviour. Callers look up a tool
 * by name in the registry, then dispatch execution via the parallel map.
 */
export interface ExecutableDomainTool<
  TInput = Record<string, unknown>,
  TOutput = Record<string, unknown>,
> {
  definition: DomainToolDefinition
  execute(input: TInput): Promise<TOutput>
}

export interface BuiltinToolRegistryBundle {
  registry: InMemoryDomainToolRegistry
  executors: Map<string, ExecutableDomainTool>
  /** Read-only view of the in-memory record.append store, keyed by namespace. */
  recordStore: ReadonlyMap<string, readonly string[]>
}

export interface BuiltinToolOptions {
  /** Root directory for project_docs.* tools. Defaults to `process.cwd()`. */
  rootDir?: string
  /** Callback invoked when human.clarify is executed. */
  onClarify?: (payload: ClarificationPayload) => void | Promise<void>
}

// ---------------------------------------------------------------------------
// project_docs.list
// ---------------------------------------------------------------------------

interface ListInput {
  pattern: string
}

interface ListOutput {
  files: string[]
}

/**
 * Very small glob matcher that supports `*`, `**` and `?`.
 *
 * Good enough for the built-in tool's needs without pulling in `fast-glob`.
 */
function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
        if (pattern[i + 1] === '/') {
          i++
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`
    } else if (c !== undefined) {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

async function walk(dir: string, rootDir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const results: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      results.push(...(await walk(full, rootDir)))
    } else if (entry.isFile()) {
      results.push(path.relative(rootDir, full).split(path.sep).join('/'))
    }
  }
  return results
}

function buildProjectDocsList(rootDir: string): ExecutableDomainTool<ListInput, ListOutput> {
  const definition: DomainToolDefinition = {
    name: 'project_docs.list',
    description: 'List project documentation files matching a glob pattern.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.md' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: { type: 'array', items: { type: 'string' } },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'project_docs',
  }

  return {
    definition,
    async execute(input: ListInput): Promise<ListOutput> {
      const re = globToRegExp(input.pattern)
      const all = await walk(rootDir, rootDir)
      const files = all.filter((f) => re.test(f)).sort()
      return { files }
    },
  }
}

// ---------------------------------------------------------------------------
// project_docs.read
// ---------------------------------------------------------------------------

interface ReadInput {
  path: string
}

interface ReadOutput {
  content: string
}

function buildProjectDocsRead(rootDir: string): ExecutableDomainTool<ReadInput, ReadOutput> {
  const definition: DomainToolDefinition = {
    name: 'project_docs.read',
    description: 'Read the contents of a project documentation file.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path relative to rootDir' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string' },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'project_docs',
  }

  return {
    definition,
    async execute(input: ReadInput): Promise<ReadOutput> {
      const rel = input.path
      if (path.isAbsolute(rel)) {
        throw new Error('project_docs.read requires a path relative to rootDir')
      }
      const resolved = path.resolve(rootDir, rel)
      const relCheck = path.relative(rootDir, resolved)
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        throw new Error('project_docs.read refused to read outside rootDir')
      }
      const content = await fs.readFile(resolved, 'utf-8')
      return { content }
    },
  }
}

// ---------------------------------------------------------------------------
// topics.search
// ---------------------------------------------------------------------------

interface SearchInput {
  query: string
  limit?: number
}

interface SearchResultItem {
  id: string
  title: string
  score: number
}

interface SearchOutput {
  results: SearchResultItem[]
  query: string
}

function buildTopicsSearch(): ExecutableDomainTool<SearchInput, SearchOutput> {
  const definition: DomainToolDefinition = {
    name: 'topics.search',
    description: 'Search topics by query. Stub implementation returning no results.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['results', 'query'],
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'title', 'score'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              score: { type: 'number' },
            },
          },
        },
        query: { type: 'string' },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'topics',
  }

  return {
    definition,
    async execute(input: SearchInput): Promise<SearchOutput> {
      return { results: [], query: input.query }
    },
  }
}

// ---------------------------------------------------------------------------
// human.clarify
// ---------------------------------------------------------------------------

interface ClarifyInput {
  question: string
  context?: string
}

interface ClarifyOutput {
  sent: true
}

function buildHumanClarify(
  onClarify: (payload: ClarificationPayload) => void | Promise<void>,
): ExecutableDomainTool<ClarifyInput, ClarifyOutput> {
  const definition: DomainToolDefinition = {
    name: 'human.clarify',
    description: 'Request clarification from a human operator.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string' },
        context: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['sent'],
      properties: {
        sent: { type: 'boolean', const: true },
      },
    },
    permissionLevel: 'read',
    sideEffects: [
      {
        type: 'sends_notification',
        description: 'Sends a clarification request to a human operator.',
      },
    ],
    namespace: 'human',
  }

  return {
    definition,
    async execute(input: ClarifyInput): Promise<ClarifyOutput> {
      const payload: ClarificationPayload = {
        type: 'clarification',
        runId: '',
        nodeIndex: 0,
        question: input.question,
        expected: 'text',
        ...(input.context !== undefined ? { context: input.context } : {}),
      }
      await onClarify(payload)
      return { sent: true }
    },
  }
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
): ExecutableDomainTool<AppendInput, AppendOutput> {
  const definition: DomainToolDefinition = {
    name: 'record.append',
    description: 'Append an entry to an in-memory namespaced record store.',
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
        description: 'Mutates the in-memory record store.',
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
      return { namespace: ns, count: bucket.length }
    },
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a registry pre-populated with the five built-in domain tools and
 * return it alongside an executor map that carries their runtime behaviour.
 *
 * The registry itself continues to store pure {@link DomainToolDefinition}
 * metadata — runtime execution is provided through the parallel executor
 * map so that the registry contract stays unchanged.
 */
export function createBuiltinToolRegistry(
  opts: BuiltinToolOptions = {},
): BuiltinToolRegistryBundle {
  const rootDir = opts.rootDir ?? process.cwd()
  const onClarify = opts.onClarify ?? (() => undefined)
  const recordStore = new Map<string, string[]>()

  const tools: ExecutableDomainTool[] = [
    buildProjectDocsList(rootDir) as unknown as ExecutableDomainTool,
    buildProjectDocsRead(rootDir) as unknown as ExecutableDomainTool,
    buildTopicsSearch() as unknown as ExecutableDomainTool,
    buildHumanClarify(onClarify) as unknown as ExecutableDomainTool,
    buildRecordAppend(recordStore) as unknown as ExecutableDomainTool,
  ]

  const registry = new InMemoryDomainToolRegistry()
  const executors = new Map<string, ExecutableDomainTool>()
  for (const tool of tools) {
    registry.register(tool.definition)
    executors.set(tool.definition.name, tool)
  }

  return { registry, executors, recordStore }
}
