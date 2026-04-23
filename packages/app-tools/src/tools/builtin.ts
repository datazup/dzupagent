import type { ApprovalPayload, ClarificationPayload } from '@dzupagent/hitl-kit'
import { createRenameSymbolTool } from '@dzupagent/code-edit-kit'
import type { McpClient } from '@dzupagent/code-edit-kit'
import type { DomainToolDefinition } from '../types.js'
import { InMemoryDomainToolRegistry } from '../registry.js'
import { buildHumanTools } from './human.js'
import {
  buildPmTools,
  InMemoryPmTaskStore,
  type PmTaskStore,
} from './pm.js'
import { buildProjectDocsTools } from './project_docs.js'
import { buildRecordTools, type RecordToolOptions } from './record.js'
import type { ExecutableDomainTool } from './shared.js'
import { buildTopicsTools, type TopicRecord } from './topics.js'
import {
  buildWorkflowTools,
  InMemoryWorkflowRunner,
  type WorkflowDefinition,
  type WorkflowRunner,
} from './workflow.js'

export type { ExecutableDomainTool } from './shared.js'

/**
 * Structural shape of `ToolResolver` from `@dzupagent/flow-ast`.
 * Declared inline so `@dzupagent/app-tools` avoids a hard dep on flow-ast
 * while remaining structurally compatible at the call site.
 */
export interface ResolvedToolLike {
  ref: string
  /**
   * Legacy convenience field retained for backward compatibility with older
   * callers/tests that only checked the resolved name.
   */
  name: string
  kind: 'skill'
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  handle: {
    kind: 'skill'
    id: string
    displayName: string
    execute: (input: unknown, ctx: unknown) => Promise<unknown>
    inputSchema: Record<string, unknown>
    outputSchema?: Record<string, unknown>
  }
}

export interface ToolResolverLike {
  resolve(ref: string): ResolvedToolLike | null
  listAvailable(): string[]
}

export interface BuiltinToolRegistryBundle {
  registry: InMemoryDomainToolRegistry
  executors: Map<string, ExecutableDomainTool>
  /** Read-only view of the in-memory record.append store, keyed by namespace. */
  recordStore: ReadonlyMap<string, readonly string[]>
  /** PM task store backing pm.* tools. */
  pmStore: PmTaskStore
  /** Workflow definition catalog backing workflow.list. */
  workflowDefinitions: ReadonlyMap<string, WorkflowDefinition>
  /** Workflow runner backing workflow.run / workflow.status. */
  workflowRunner: WorkflowRunner
  /** Topic catalog backing topics.* tools. */
  topicCatalog: ReadonlyMap<string, TopicRecord>
  /**
   * Returns a {@link ToolResolverLike} backed by this bundle's registry.
   * Structurally compatible with `ToolResolver` from `@dzupagent/flow-ast` —
   * pass directly to `CompileRouteConfig.toolResolver`.
   */
  toToolResolver(): ToolResolverLike
}

export interface BuiltinToolOptions {
  /** Root directory for project_docs.* tools. Defaults to `process.cwd()`. */
  rootDir?: string
  /** Callback invoked when human.clarify is executed. */
  onClarify?: (payload: ClarificationPayload) => void | Promise<void>
  /** Callback invoked when human.approve is executed. */
  onApprove?: (payload: ApprovalPayload) => void | Promise<void>
  /** Inject a custom PM task store; defaults to {@link InMemoryPmTaskStore}. */
  pmStore?: PmTaskStore
  /** Id factory for new PM tasks; defaults to a monotonically increasing counter. */
  pmIdFactory?: () => string
  /** Clock for pm.create_task timestamps; defaults to `new Date()`. */
  now?: () => Date
  /** Seed workflow definitions available via workflow.list / workflow.run. */
  workflows?: Iterable<WorkflowDefinition>
  /** Inject a workflow runner; defaults to {@link InMemoryWorkflowRunner}. */
  workflowRunner?: WorkflowRunner
  /** Seed topic catalog entries for topics.* tools. */
  topics?: Iterable<TopicRecord>
  /**
   * Directory for durable record storage.
   * When provided, `record.append` writes each entry as a JSONL line to
   * `{recordsDir}/{namespace}.jsonl` in addition to the in-memory store.
   * Defaults to in-memory only.
   */
  recordsDir?: string
  /**
   * Opt-in: register the AST-aware `rename_symbol` tool from
   * `@dzupagent/code-edit-kit`. When `true`, the tool is added to the registry
   * and executors map under the name `code_edit.rename_symbol`. The underlying
   * implementation requires `ts-morph` as an optional peer dependency.
   * Defaults to `false`.
   */
  renameSymbol?: boolean
  /**
   * Optional MCP client to forward to the underlying `rename_symbol` tool.
   * When set alongside `renameSymbol: true`, the client is passed through to
   * `createRenameSymbolTool(mcpClient)` so downstream adapters can delegate
   * edits to an MCP-aware code-editing server. Has no effect when
   * `renameSymbol` is `false` or omitted.
   */
  mcpClient?: McpClient
}

/**
 * JSON Schema mirror of the rename-symbol LangChain tool's Zod schema. Declared
 * statically so the registry exposes the same contract whether or not the
 * optional peer is active at runtime.
 */
const RENAME_SYMBOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['tsconfigPath', 'filePath', 'symbolName', 'newName'],
  properties: {
    tsconfigPath: { type: 'string' },
    filePath: { type: 'string' },
    symbolName: { type: 'string' },
    newName: { type: 'string' },
  },
}

const RENAME_SYMBOL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['renamedCount', 'affectedFiles'],
  properties: {
    renamedCount: { type: 'number' },
    affectedFiles: { type: 'array', items: { type: 'string' } },
  },
}

interface RenameSymbolExecInput {
  tsconfigPath: string
  filePath: string
  symbolName: string
  newName: string
}

interface RenameSymbolExecOutput {
  renamedCount: number
  affectedFiles: string[]
  raw: string
}

/**
 * Wrap the LangChain `rename_symbol` tool in the {@link ExecutableDomainTool}
 * shape used by the registry. The domain tool keeps JSON Schema metadata
 * (registry contract) while delegating execution to the underlying tool's
 * `invoke` method.
 *
 * @param mcpClient - Optional MCP client forwarded to {@link createRenameSymbolTool}.
 */
function buildRenameSymbolTool(mcpClient?: McpClient): ExecutableDomainTool<
  RenameSymbolExecInput,
  RenameSymbolExecOutput
> {
  const lcTool = createRenameSymbolTool(mcpClient)
  const definition: DomainToolDefinition = {
    name: 'code_edit.rename_symbol',
    description:
      'AST-aware rename of a TypeScript symbol (function, class, interface, type alias, ' +
      'enum, or const) across a whole project. Propagates the rename to every cross-file ' +
      'reference via ts-morph.',
    inputSchema: RENAME_SYMBOL_INPUT_SCHEMA,
    outputSchema: RENAME_SYMBOL_OUTPUT_SCHEMA,
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'writes_file',
        description: 'Rewrites every source file that references the renamed symbol.',
      },
    ],
    namespace: 'code_edit',
  }

  return {
    definition,
    async execute(input: RenameSymbolExecInput): Promise<RenameSymbolExecOutput> {
      const raw = (await lcTool.invoke(input)) as string
      if (raw.startsWith('rename_symbol failed:')) {
        throw new Error(raw)
      }
      const parsed = JSON.parse(raw) as { renamedCount: number; affectedFiles: string[] }
      return { ...parsed, raw }
    },
  }
}

function buildDefaultIdFactory(): () => string {
  let seq = 0
  return () => {
    seq += 1
    return `task_${seq}`
  }
}

/**
 * Build a registry pre-populated with the built-in domain tools and return it
 * alongside an executor map that carries their runtime behaviour.
 *
 * Namespaces included:
 *
 * - `project_docs.*` — list, read
 * - `pm.*`           — create_task, update_task, get_task, list_tasks
 * - `workflow.*`     — list, run, status
 * - `human.*`        — clarify, approve
 * - `record.*`       — append, list, clear
 * - `topics.*`       — list, search, get
 *
 * The registry stores pure {@link import('../types.js').DomainToolDefinition}
 * metadata — runtime execution is provided through the parallel executor map
 * so that the registry contract stays unchanged.
 */
export function createBuiltinToolRegistry(
  opts: BuiltinToolOptions = {},
): BuiltinToolRegistryBundle {
  const rootDir = opts.rootDir ?? process.cwd()
  const onClarify = opts.onClarify ?? (() => undefined)
  const onApprove = opts.onApprove ?? (() => undefined)
  const now = opts.now ?? (() => new Date())
  const pmIdFactory = opts.pmIdFactory ?? buildDefaultIdFactory()
  const pmStore = opts.pmStore ?? new InMemoryPmTaskStore()

  const workflowDefinitions = new Map<string, WorkflowDefinition>()
  if (opts.workflows) {
    for (const def of opts.workflows) {
      workflowDefinitions.set(def.id, def)
    }
  }
  const workflowRunner =
    opts.workflowRunner ?? new InMemoryWorkflowRunner(workflowDefinitions, now)

  const topicCatalog = new Map<string, TopicRecord>()
  if (opts.topics) {
    for (const topic of opts.topics) {
      topicCatalog.set(topic.id, topic)
    }
  }

  const recordStore = new Map<string, string[]>()
  const recordOpts: RecordToolOptions = opts.recordsDir ? { recordsDir: opts.recordsDir } : {}

  const tools: ExecutableDomainTool[] = [
    ...buildProjectDocsTools(rootDir),
    ...buildPmTools(pmStore, pmIdFactory, now),
    ...buildWorkflowTools(workflowDefinitions, workflowRunner),
    ...buildHumanTools(onClarify, onApprove),
    ...buildRecordTools(recordStore, recordOpts),
    ...buildTopicsTools(topicCatalog),
  ]

  if (opts.renameSymbol === true) {
    tools.push(buildRenameSymbolTool(opts.mcpClient) as unknown as ExecutableDomainTool)
  }

  const registry = new InMemoryDomainToolRegistry()
  const executors = new Map<string, ExecutableDomainTool>()
  for (const tool of tools) {
    registry.register(tool.definition)
    executors.set(tool.definition.name, tool)
  }

  return {
    registry,
    executors,
    recordStore,
    pmStore,
    workflowDefinitions,
    workflowRunner,
    topicCatalog,
    toToolResolver(): ToolResolverLike {
      return {
        resolve(ref: string) {
          const def = registry.get(ref)
          const executable = executors.get(ref)
          if (!def || !executable) return null
          return {
            ref: def.name,
            name: def.name,
            kind: 'skill',
            inputSchema: def.inputSchema,
            ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
            handle: {
              kind: 'skill',
              id: def.name,
              displayName: def.name,
              execute: async (input: unknown) => executable.execute(input as never),
              inputSchema: def.inputSchema,
              ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
            },
          }
        },
        listAvailable() {
          return registry.list().map((d) => d.name)
        },
      }
    },
  }
}
