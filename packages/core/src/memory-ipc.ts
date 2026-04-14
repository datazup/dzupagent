/**
 * Re-exports from @dzupagent/memory-ipc for convenience.
 * Only available when @dzupagent/memory-ipc is installed as a peer dependency.
 */

import { ForgeError } from './errors/forge-error.js'

import type { MemoryFrameColumn } from '@dzupagent/memory-ipc'
import type {
  FrameScope,
  FrameTemporal,
  FrameDecay,
  FrameProvenance,
  FrameRecordMeta,
  FrameRecordValue,
} from '@dzupagent/memory-ipc'
import type { FrameRecord } from '@dzupagent/memory-ipc'
import type { SerializeOptions } from '@dzupagent/memory-ipc'
import type {
  MemoryFrameAdapter,
  AdapterValidationResult,
  AdapterRegistry,
} from '@dzupagent/memory-ipc'
import type { FrameColumnArrays } from '@dzupagent/memory-ipc'
import type {
  CompositeScoreWeights,
  ScoredRecord,
  TokenBudgetAllocation,
  TokenBudgetAllocatorConfig,
} from '@dzupagent/memory-ipc'
import type { ConversationPhase as IPCConversationPhase } from '@dzupagent/memory-ipc'
import type { FrameDelta } from '@dzupagent/memory-ipc'
import type { OverlapAnalysis } from '@dzupagent/memory-ipc'
import type {
  SharedMemoryChannelOptions,
  SlotHandle,
} from '@dzupagent/memory-ipc'
import type {
  ExportFrameOptions,
  ImportFrameResult,
  ImportStrategy,
  MemoryServiceLike,
  MemoryServiceArrowExtension,
} from '@dzupagent/memory-ipc'
import type {
  ExportMemoryInput,
  ExportMemoryOutput,
  ImportMemoryInput,
  ImportMemoryOutput,
  MemorySchemaOutput,
  ExportMemoryDeps,
  ImportMemoryDeps,
} from '@dzupagent/memory-ipc'
import type {
  MemoryArtifact,
  MemoryArtifactPart,
  MemoryArtifactMetadata,
  SanitizeOptions,
} from '@dzupagent/memory-ipc'
import type {
  BlackboardConfig,
  BlackboardTableDef,
  BlackboardSnapshot,
} from '@dzupagent/memory-ipc'
import type {
  ToolResultEntry,
  CodegenFileEntry,
  EvalResultEntry,
  EntityGraphEntry,
} from '@dzupagent/memory-ipc'

import type * as MemoryIpcNs from '@dzupagent/memory-ipc'

type MemoryIpcModule = typeof MemoryIpcNs
type MemoryIpcExportName = keyof MemoryIpcModule

const MEMORY_IPC_PACKAGE = '@dzupagent/memory-ipc'
const MEMORY_IPC_SUBPATH = '@dzupagent/core/memory-ipc'

const REQUIRED_FUNCTION_EXPORTS = [
  'FrameBuilder',
  'FrameReader',
  'serializeToIPC',
  'deserializeFromIPC',
  'ipcToBase64',
  'base64ToIPC',
  'createAdapterRegistry',
  'createEmptyColumns',
  'buildTable',
  'pushDefaults',
  'safeParseDate',
  'getString',
  'getBigInt',
  'getFloat',
  'findWeakIndices',
  'batchDecayUpdate',
  'temporalMask',
  'applyMask',
  'partitionByNamespace',
  'computeCompositeScore',
  'batchTokenEstimate',
  'selectByTokenBudget',
  'rankByPageRank',
  'applyHubDampeningBatch',
  'batchCosineSimilarity',
  'takeRows',
  'selectMemoriesByBudget',
  'TokenBudgetAllocator',
  'phaseWeightedSelection',
  'computeFrameDelta',
  'batchOverlapAnalysis',
  'SharedMemoryChannel',
  'extendMemoryServiceWithArrow',
  'handleExportMemory',
  'handleImportMemory',
  'handleMemorySchema',
  'createMemoryArtifact',
  'parseMemoryArtifact',
  'sanitizeForExport',
  'ArrowBlackboard',
  'ToolResultFrameBuilder',
  'CodegenFrameBuilder',
  'EvalFrameBuilder',
  'EntityGraphFrameBuilder',
] as const satisfies readonly MemoryIpcExportName[]

const REQUIRED_VALUE_EXPORTS = [
  'MEMORY_FRAME_SCHEMA',
  'MEMORY_FRAME_VERSION',
  'MEMORY_FRAME_COLUMNS',
  'MEMORY_FRAME_FIELD_COUNT',
  'PHASE_NAMESPACE_WEIGHTS',
  'PHASE_CATEGORY_WEIGHTS',
  'exportMemoryInputSchema',
  'exportMemoryOutputSchema',
  'importMemoryInputSchema',
  'importMemoryOutputSchema',
  'memorySchemaOutputSchema',
  'TOOL_RESULT_SCHEMA',
  'CODEGEN_FRAME_SCHEMA',
  'EVAL_FRAME_SCHEMA',
  'ENTITY_GRAPH_SCHEMA',
] as const satisfies readonly MemoryIpcExportName[]

const STRICT_RUNTIME_EXPORTS = [
  'MEMORY_FRAME_VERSION',
  'FrameBuilder',
  'FrameReader',
  'serializeToIPC',
  'handleExportMemory',
] as const satisfies readonly MemoryIpcExportName[]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readErrorCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined
  return typeof error['code'] === 'string' ? error['code'] : undefined
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function extractMissingModuleSpecifier(error: unknown): string | null {
  const message = readErrorMessage(error)
  const patterns = [
    /Cannot find (?:package|module)\s+['"]([^'"]+)['"]/i,
    /Failed to resolve import\s+['"]([^'"]+)['"]/i,
    /Could not resolve\s+['"]([^'"]+)['"]/i,
  ]

  for (const pattern of patterns) {
    const match = message.match(pattern)
    if (match?.[1]) {
      return match[1]
    }
  }

  return null
}

function isMissingPeerDependencyError(error: unknown): boolean {
  const code = readErrorCode(error)
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    return false
  }

  return extractMissingModuleSpecifier(error) === MEMORY_IPC_PACKAGE
}

function getModuleExportDescriptor(
  module: Partial<MemoryIpcModule>,
  exportName: MemoryIpcExportName,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(module, exportName)
  } catch {
    return undefined
  }
}

function readModuleExportValue(
  module: Partial<MemoryIpcModule>,
  exportName: MemoryIpcExportName,
): unknown {
  return module[exportName]
}

function createMemoryIpcDependencyError(
  message: string,
  suggestion: string,
  context: Record<string, unknown>,
  cause: unknown,
): ForgeError {
  const opts = {
    code: 'MISSING_DEPENDENCY' as const,
    message,
    recoverable: false,
    suggestion,
    context,
    ...(cause instanceof Error ? { cause } : {}),
  }
  return new ForgeError(opts)
}

function getMissingRuntimeExports(module: Partial<MemoryIpcModule>): string[] {
  const missing = new Set<string>()
  const allExports = [...REQUIRED_FUNCTION_EXPORTS, ...REQUIRED_VALUE_EXPORTS] as readonly MemoryIpcExportName[]

  for (const exportName of allExports) {
    const descriptor = getModuleExportDescriptor(module, exportName)
    if (descriptor === undefined) {
      missing.add(exportName)
      continue
    }

    if ('value' in descriptor && descriptor.value === undefined) {
      missing.add(exportName)
    }
  }

  for (const exportName of STRICT_RUNTIME_EXPORTS) {
    const descriptor = getModuleExportDescriptor(module, exportName)
    if (descriptor === undefined) {
      missing.add(exportName)
      continue
    }

    if ('value' in descriptor) {
      if (descriptor.value === undefined) {
        missing.add(exportName)
      }
      continue
    }

    const value = readModuleExportValue(module, exportName)
    if (value === undefined) {
      missing.add(exportName)
    }
  }

  return [...missing]
}

async function loadMemoryIpcModule(): Promise<MemoryIpcModule> {
  try {
    const module = await import('@dzupagent/memory-ipc')
    const missingExports = getMissingRuntimeExports(module)
    if (missingExports.length > 0) {
      throw createMemoryIpcDependencyError(
        'The @dzupagent/memory-ipc peer dependency is installed, but it does not expose the required runtime API for @dzupagent/core/memory-ipc.',
        'Install a compatible @dzupagent/memory-ipc version, or avoid importing @dzupagent/core/memory-ipc when Arrow IPC support is not needed.',
        {
          packageName: MEMORY_IPC_PACKAGE,
          subpath: MEMORY_IPC_SUBPATH,
          missingExports,
        },
        new Error('Resolved @dzupagent/memory-ipc, but the module did not expose the expected runtime API.'),
      )
    }
    return module
  } catch (error) {
    if (isMissingPeerDependencyError(error)) {
      throw createMemoryIpcDependencyError(
        'The @dzupagent/core/memory-ipc subpath requires the optional peer dependency @dzupagent/memory-ipc, but it is unavailable.',
        'Install @dzupagent/memory-ipc in the consuming workspace, or avoid importing @dzupagent/core/memory-ipc when Arrow IPC support is not needed.',
        {
          packageName: MEMORY_IPC_PACKAGE,
          subpath: MEMORY_IPC_SUBPATH,
        },
        error,
      )
    }
    throw error
  }
}

let memoryIpcModule: MemoryIpcModule | undefined

try {
  memoryIpcModule = await loadMemoryIpcModule()
} catch (error: unknown) {
  // Only swallow errors that indicate the optional peer dependency is missing
  // or incompatible. Re-throw unexpected errors (e.g. transitive dependency
  // failures from other packages like apache-arrow).
  if (error instanceof ForgeError && error.code === 'MISSING_DEPENDENCY') {
    memoryIpcModule = undefined
  } else {
    throw error
  }
}

/**
 * Returns `true` when the optional `@dzupagent/memory-ipc` peer dependency
 * was successfully loaded and all expected exports are available.
 */
export function isMemoryIpcAvailable(): boolean {
  return memoryIpcModule !== undefined
}

/**
 * Returns the loaded module or throws a clear `ForgeError` when the
 * optional peer dependency is not installed.
 */
function requireMemoryIpc(): MemoryIpcModule {
  if (!memoryIpcModule) {
    throw new ForgeError({
      code: 'MISSING_DEPENDENCY',
      message:
        '@dzupagent/memory-ipc is required for this feature. Install it: yarn add @dzupagent/memory-ipc',
      recoverable: false,
    })
  }
  return memoryIpcModule
}

/* ------------------------------------------------------------------ */
/*  Guarded re-exports                                                 */
/* ------------------------------------------------------------------ */

/** @throws {ForgeError} when `@dzupagent/memory-ipc` is not installed */
export function getMemoryIpc(): MemoryIpcModule {
  return requireMemoryIpc()
}

// Named re-exports — each accessor guards on availability so consumers
// get a clear error instead of a cryptic top-level-await crash.

export const MEMORY_FRAME_SCHEMA   = memoryIpcModule?.MEMORY_FRAME_SCHEMA
export const MEMORY_FRAME_VERSION  = memoryIpcModule?.MEMORY_FRAME_VERSION
export const MEMORY_FRAME_COLUMNS  = memoryIpcModule?.MEMORY_FRAME_COLUMNS
export const MEMORY_FRAME_FIELD_COUNT = memoryIpcModule?.MEMORY_FRAME_FIELD_COUNT
export const FrameBuilder          = memoryIpcModule?.FrameBuilder
export const FrameReader           = memoryIpcModule?.FrameReader
export const serializeToIPC        = memoryIpcModule?.serializeToIPC
export const deserializeFromIPC    = memoryIpcModule?.deserializeFromIPC
export const ipcToBase64           = memoryIpcModule?.ipcToBase64
export const base64ToIPC           = memoryIpcModule?.base64ToIPC
export const createAdapterRegistry = memoryIpcModule?.createAdapterRegistry
export const createEmptyColumns    = memoryIpcModule?.createEmptyColumns
export const buildTable            = memoryIpcModule?.buildTable
export const pushDefaults          = memoryIpcModule?.pushDefaults
export const safeParseDate         = memoryIpcModule?.safeParseDate
export const getString             = memoryIpcModule?.getString
export const getBigInt             = memoryIpcModule?.getBigInt
export const getFloat              = memoryIpcModule?.getFloat
export const findWeakIndices       = memoryIpcModule?.findWeakIndices
export const batchDecayUpdate      = memoryIpcModule?.batchDecayUpdate
export const temporalMask          = memoryIpcModule?.temporalMask
export const applyMask             = memoryIpcModule?.applyMask
export const partitionByNamespace  = memoryIpcModule?.partitionByNamespace
export const computeCompositeScore = memoryIpcModule?.computeCompositeScore
export const batchTokenEstimate    = memoryIpcModule?.batchTokenEstimate
export const selectByTokenBudget   = memoryIpcModule?.selectByTokenBudget
export const rankByPageRank        = memoryIpcModule?.rankByPageRank
export const applyHubDampeningBatch = memoryIpcModule?.applyHubDampeningBatch
export const batchCosineSimilarity = memoryIpcModule?.batchCosineSimilarity
export const takeRows              = memoryIpcModule?.takeRows
export const selectMemoriesByBudget = memoryIpcModule?.selectMemoriesByBudget
export const TokenBudgetAllocator  = memoryIpcModule?.TokenBudgetAllocator
export const phaseWeightedSelection = memoryIpcModule?.phaseWeightedSelection
export const PHASE_NAMESPACE_WEIGHTS = memoryIpcModule?.PHASE_NAMESPACE_WEIGHTS
export const PHASE_CATEGORY_WEIGHTS = memoryIpcModule?.PHASE_CATEGORY_WEIGHTS
export const computeFrameDelta     = memoryIpcModule?.computeFrameDelta
export const batchOverlapAnalysis  = memoryIpcModule?.batchOverlapAnalysis
export const SharedMemoryChannel   = memoryIpcModule?.SharedMemoryChannel
export const extendMemoryServiceWithArrow = memoryIpcModule?.extendMemoryServiceWithArrow
export const exportMemoryInputSchema  = memoryIpcModule?.exportMemoryInputSchema
export const exportMemoryOutputSchema = memoryIpcModule?.exportMemoryOutputSchema
export const importMemoryInputSchema  = memoryIpcModule?.importMemoryInputSchema
export const importMemoryOutputSchema = memoryIpcModule?.importMemoryOutputSchema
export const memorySchemaOutputSchema = memoryIpcModule?.memorySchemaOutputSchema
export const handleExportMemory    = memoryIpcModule?.handleExportMemory
export const handleImportMemory    = memoryIpcModule?.handleImportMemory
export const handleMemorySchema    = memoryIpcModule?.handleMemorySchema
export const createMemoryArtifact  = memoryIpcModule?.createMemoryArtifact
export const parseMemoryArtifact   = memoryIpcModule?.parseMemoryArtifact
export const sanitizeForExport     = memoryIpcModule?.sanitizeForExport
export const ArrowBlackboard       = memoryIpcModule?.ArrowBlackboard
export const TOOL_RESULT_SCHEMA    = memoryIpcModule?.TOOL_RESULT_SCHEMA
export const ToolResultFrameBuilder = memoryIpcModule?.ToolResultFrameBuilder
export const CODEGEN_FRAME_SCHEMA  = memoryIpcModule?.CODEGEN_FRAME_SCHEMA
export const CodegenFrameBuilder   = memoryIpcModule?.CodegenFrameBuilder
export const EVAL_FRAME_SCHEMA     = memoryIpcModule?.EVAL_FRAME_SCHEMA
export const EvalFrameBuilder      = memoryIpcModule?.EvalFrameBuilder
export const ENTITY_GRAPH_SCHEMA   = memoryIpcModule?.ENTITY_GRAPH_SCHEMA
export const EntityGraphFrameBuilder = memoryIpcModule?.EntityGraphFrameBuilder

export type { MemoryFrameColumn }
export type {
  FrameScope,
  FrameTemporal,
  FrameDecay,
  FrameProvenance,
  FrameRecordMeta,
  FrameRecordValue,
}
export type { FrameRecord }
export type { SerializeOptions }
export type {
  MemoryFrameAdapter,
  AdapterValidationResult,
  AdapterRegistry,
}
export type { FrameColumnArrays }
export type {
  CompositeScoreWeights,
  ScoredRecord,
  TokenBudgetAllocation,
  TokenBudgetAllocatorConfig,
}
export type { IPCConversationPhase }
export type { FrameDelta }
export type { OverlapAnalysis }
export type {
  SharedMemoryChannelOptions,
  SlotHandle,
}
export type {
  ExportFrameOptions,
  ImportFrameResult,
  ImportStrategy,
  MemoryServiceLike,
  MemoryServiceArrowExtension,
}
export type {
  ExportMemoryInput,
  ExportMemoryOutput,
  ImportMemoryInput,
  ImportMemoryOutput,
  MemorySchemaOutput,
  ExportMemoryDeps,
  ImportMemoryDeps,
}
export type {
  MemoryArtifact,
  MemoryArtifactPart,
  MemoryArtifactMetadata,
  SanitizeOptions,
}
export type {
  BlackboardConfig,
  BlackboardTableDef,
  BlackboardSnapshot,
}
export type {
  ToolResultEntry,
  CodegenFileEntry,
  EvalResultEntry,
  EntityGraphEntry,
}
