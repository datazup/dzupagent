/**
 * Agent File — serialization format for exporting/importing agent memory.
 *
 * An AgentFile is a self-contained JSON document that captures an agent's
 * memory namespaces, prompts, state, and metadata. It enables agent
 * portability and memory sharing between agents.
 */
import type { MemoryProvenance } from '../provenance/types.js'

/**
 * Top-level Agent File structure.
 */
export interface AgentFile {
  /** Schema URI for validation */
  $schema: string
  /** File format version */
  version: '1.0.0'
  /** ISO-8601 timestamp of when this file was exported */
  exportedAt: string
  /** forge:// URI of the agent that exported this file */
  exportedBy: string
  /** Agent identity section */
  agent: AgentFileAgentSection
  /** Memory records organized by namespace */
  memory: AgentFileMemorySection
  /** Optional prompt templates */
  prompts?: AgentFilePromptsSection
  /** Optional working memory / metadata state */
  state?: AgentFileStateSection
  /** SHA-256 hex digest over content sections (memory + prompts + state) */
  signature?: string
}

/**
 * Describes the agent that produced this file.
 */
export interface AgentFileAgentSection {
  /** Human-readable agent name */
  name: string
  /** Optional description of the agent's purpose */
  description?: string
  /** Capabilities this agent advertises */
  capabilities?: string[]
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>
}

/**
 * Memory section — namespaces mapped to arrays of records.
 */
export interface AgentFileMemorySection {
  namespaces: Record<string, AgentFileMemoryRecord[]>
}

/**
 * A single memory record within a namespace.
 */
export interface AgentFileMemoryRecord {
  /** Record key (unique within its namespace) */
  key: string
  /** Record value (the stored data) */
  value: Record<string, unknown>
  /** Provenance metadata, if the record was written with provenance */
  provenance?: MemoryProvenance
  /** ISO-8601 timestamp of when this record was created */
  createdAt?: string
}

/**
 * Prompt templates section.
 */
export interface AgentFilePromptsSection {
  templates?: Array<{
    name: string
    content: string
    variables?: string[]
  }>
}

/**
 * State section — ephemeral working memory and metadata.
 */
export interface AgentFileStateSection {
  workingMemory?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

/**
 * Options controlling how an AgentFile is imported.
 */
export interface ImportOptions {
  /** How to handle key conflicts */
  conflictStrategy: 'skip' | 'overwrite' | 'merge'
  /** Namespaces to import (if not specified, all) */
  namespaces?: string[]
  /** Verify signature before importing */
  verifySignature?: boolean
}

/**
 * Result of an import operation.
 */
export interface ImportResult {
  /** Number of records successfully imported */
  imported: number
  /** Number of records skipped (e.g. due to conflict strategy) */
  skipped: number
  /** Number of records that failed to import */
  failed: number
  /** Warning messages collected during import */
  warnings: string[]
}

/** The current AgentFile schema URI */
export const AGENT_FILE_SCHEMA = 'https://forgeagent.dev/schemas/agent-file-v1.json' as const

/** The current AgentFile format version */
export const AGENT_FILE_VERSION = '1.0.0' as const
