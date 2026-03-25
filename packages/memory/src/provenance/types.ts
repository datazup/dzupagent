/**
 * Provenance tracking types for memory records.
 *
 * Tracks who created/modified a memory record, how it was produced,
 * and the full lineage of agents that touched it.
 */

/**
 * Source type indicating how a memory record was created.
 */
export type ProvenanceSource =
  | 'direct'        // Agent directly wrote the record
  | 'derived'       // Computed/transformed from other records
  | 'imported'      // Imported from Agent File or external source
  | 'consolidated'  // Result of consolidation/dedup
  | 'shared'        // Received via shared memory space

/**
 * Provenance metadata attached to memory records.
 */
export interface MemoryProvenance {
  /**
   * Agent URI that originally created this record.
   * MUST follow the `forge://org/agent-name` two-segment format
   * from the ForgeAgent identity spec (Doc 01).
   * When `@forgeagent/core` identity module is available, this
   * will be tightened to a branded `ForgeUri` type.
   */
  createdBy: string
  /** ISO-8601 timestamp of creation */
  createdAt: string
  /** How the record was produced */
  source: ProvenanceSource
  /** Confidence score 0.0 - 1.0 */
  confidence: number
  /** SHA-256 hash of the record content for integrity verification */
  contentHash: string
  /**
   * Ordered chain of agent URIs that touched this record.
   * First entry is the original creator, last is most recent modifier.
   * Each URI MUST follow the `forge://org/agent-name` format.
   */
  lineage: string[]
  /** Optional: keys of source records this was derived from */
  derivedFrom?: string[]
}

/**
 * Options for writing records with provenance.
 */
export interface ProvenanceWriteOptions {
  /**
   * Agent URI performing the write.
   * MUST follow `forge://org/agent-name` format.
   */
  agentUri: string
  /** How the record is being produced (default: 'direct') */
  source?: ProvenanceSource
  /** Confidence 0.0-1.0 (default: 1.0) */
  confidence?: number
  /** Keys of source records (for 'derived' source) */
  derivedFrom?: string[]
}

/**
 * Query options for provenance-based filtering.
 */
export interface ProvenanceQuery {
  /** Filter by creator URI */
  createdBy?: string
  /** Filter by source type */
  source?: ProvenanceSource
  /** Minimum confidence threshold */
  minConfidence?: number
  /** Filter records touched by this agent (appears in lineage) */
  touchedBy?: string
}
