/**
 * Cross-framework memory adapters — bidirectional conversion between
 * external agent memory formats and the ForgeAgent MemoryFrame Arrow schema.
 */

// --- Adapter Interface & Registry ---
export {
  createAdapterRegistry,
} from './adapter-interface.js'
export type {
  MemoryFrameAdapter,
  AdapterValidationResult,
  AdapterRegistry,
} from './adapter-interface.js'

// --- Frame Column Helpers ---
export {
  createEmptyColumns,
  buildTable,
  safeParseDate,
  getString,
  getBigInt,
  getFloat,
} from './frame-columns.js'
export type { FrameColumnArrays } from './frame-columns.js'

// --- Mastra Adapter ---
export { MastraAdapter } from './mastra-adapter.js'
export type { MastraObservation } from './mastra-adapter.js'

// --- LangGraph Adapter ---
export { LangGraphAdapter } from './langgraph-adapter.js'
export type { LangGraphStoreItem } from './langgraph-adapter.js'

// --- Mem0 Adapter ---
export { Mem0Adapter } from './mem0-adapter.js'
export type { Mem0Memory } from './mem0-adapter.js'

// --- Letta Adapter ---
export {
  LettaAdapter,
  lettaCoreToWorkingMemory,
  workingMemoryToLettaCore,
} from './letta-adapter.js'
export type {
  LettaArchivalPassage,
  LettaCoreMemory,
  LettaCoreMemoryBlock,
} from './letta-adapter.js'

// --- MCP Knowledge Graph Adapter ---
export {
  MCPKGAdapter,
  flattenMCPKG,
  reconstructMCPKG,
} from './mcp-kg-adapter.js'
export type {
  MCPKGRecord,
  MCPKGEntityObservation,
  MCPKGRelation,
  MCPKGEntity,
} from './mcp-kg-adapter.js'

// --- Default Registry ---

import type { AdapterRegistry } from './adapter-interface.js'
import { createAdapterRegistry } from './adapter-interface.js'
import { MastraAdapter } from './mastra-adapter.js'
import { LangGraphAdapter } from './langgraph-adapter.js'
import { Mem0Adapter } from './mem0-adapter.js'
import { LettaAdapter } from './letta-adapter.js'
import { MCPKGAdapter } from './mcp-kg-adapter.js'

/**
 * Create an adapter registry pre-populated with all 5 built-in adapters:
 * mastra, langgraph, mem0, letta, mcp-knowledge-graph.
 */
export function createDefaultRegistry(): AdapterRegistry {
  const registry = createAdapterRegistry()
  registry.register(new MastraAdapter())
  registry.register(new LangGraphAdapter())
  registry.register(new Mem0Adapter())
  registry.register(new LettaAdapter())
  registry.register(new MCPKGAdapter())
  return registry
}
