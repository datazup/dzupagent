/**
 * Enhanced agent state snapshot with content hashing and compression.
 *
 * Provides tamper-evident, compressible snapshots of agent execution state
 * for checkpointing, debugging, and audit trails.
 */
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

/**
 * A complete, self-contained snapshot of agent execution state.
 */
export interface AgentStateSnapshot {
  /** Schema version for forward compatibility. */
  schemaVersion: '1.0.0'
  /** Unique agent identifier. */
  agentId: string
  /** Human-readable agent name. */
  agentName: string
  /** Serialized conversation messages. */
  messages: unknown[]
  /** Current budget consumption state. */
  budgetState?: {
    tokensUsed: number
    costCents: number
    iterations: number
  }
  /** Agent configuration (sanitized, no secrets). */
  config?: Record<string, unknown>
  /** Names of tools available to the agent. */
  toolNames?: string[]
  /** Working memory key-value pairs. */
  workingMemory?: Record<string, unknown>
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>
  /** SHA-256 hash of the snapshot content for tamper detection. */
  contentHash: string
  /** ISO 8601 timestamp of snapshot creation. */
  createdAt: string
  /** Whether messages are gzip-compressed and base64-encoded. */
  compressed?: boolean
}

/** Params for createSnapshot (auto-generated fields excluded). */
export type CreateSnapshotParams = Omit<AgentStateSnapshot, 'contentHash' | 'createdAt' | 'schemaVersion'>

/**
 * Compute the SHA-256 content hash for a snapshot.
 *
 * Hashes a deterministic JSON representation of the snapshot data
 * (excluding contentHash and createdAt themselves).
 */
function computeHash(params: CreateSnapshotParams): string {
  const hashInput = JSON.stringify({
    agentId: params.agentId,
    agentName: params.agentName,
    messages: params.messages,
    budgetState: params.budgetState,
    config: params.config,
    toolNames: params.toolNames,
    workingMemory: params.workingMemory,
    metadata: params.metadata,
    compressed: params.compressed,
  })
  return createHash('sha256').update(hashInput).digest('hex')
}

/**
 * Create a new agent state snapshot with auto-generated hash and timestamp.
 */
export function createSnapshot(params: CreateSnapshotParams): AgentStateSnapshot {
  const contentHash = computeHash(params)

  return {
    schemaVersion: '1.0.0',
    ...params,
    contentHash,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Verify that a snapshot's content hash matches its data.
 *
 * Returns `true` if the snapshot has not been tampered with.
 */
export function verifySnapshot(snapshot: AgentStateSnapshot): boolean {
  const expected = computeHash({
    agentId: snapshot.agentId,
    agentName: snapshot.agentName,
    messages: snapshot.messages,
    budgetState: snapshot.budgetState,
    config: snapshot.config,
    toolNames: snapshot.toolNames,
    workingMemory: snapshot.workingMemory,
    metadata: snapshot.metadata,
    compressed: snapshot.compressed,
  })
  return expected === snapshot.contentHash
}

/**
 * Compress a snapshot's messages using gzip + base64 encoding.
 *
 * Returns a new snapshot with `compressed: true` and messages replaced
 * by a single base64-encoded gzip string.
 */
export function compressSnapshot(
  snapshot: AgentStateSnapshot,
): AgentStateSnapshot & { compressed: true } {
  if (snapshot.compressed) {
    return snapshot as AgentStateSnapshot & { compressed: true }
  }

  const json = JSON.stringify(snapshot.messages)
  const compressed = gzipSync(Buffer.from(json, 'utf-8'))
  const base64 = compressed.toString('base64')

  const result: CreateSnapshotParams = {
    agentId: snapshot.agentId,
    agentName: snapshot.agentName,
    messages: [base64],
    budgetState: snapshot.budgetState,
    config: snapshot.config,
    toolNames: snapshot.toolNames,
    workingMemory: snapshot.workingMemory,
    metadata: snapshot.metadata,
    compressed: true,
  }

  return {
    schemaVersion: '1.0.0',
    ...result,
    contentHash: computeHash(result),
    createdAt: snapshot.createdAt,
  } as AgentStateSnapshot & { compressed: true }
}

/**
 * Decompress a compressed snapshot back to its original form.
 *
 * If the snapshot is not compressed, returns it unchanged.
 */
export function decompressSnapshot(snapshot: AgentStateSnapshot): AgentStateSnapshot {
  if (!snapshot.compressed) {
    return snapshot
  }

  const base64 = snapshot.messages[0]
  if (typeof base64 !== 'string') {
    throw new Error('Compressed snapshot has invalid messages format: expected base64 string')
  }

  const buffer = gunzipSync(Buffer.from(base64, 'base64'))
  const messages = JSON.parse(buffer.toString('utf-8')) as unknown[]

  const params: CreateSnapshotParams = {
    agentId: snapshot.agentId,
    agentName: snapshot.agentName,
    messages,
    budgetState: snapshot.budgetState,
    config: snapshot.config,
    toolNames: snapshot.toolNames,
    workingMemory: snapshot.workingMemory,
    metadata: snapshot.metadata,
  }

  return {
    schemaVersion: '1.0.0',
    ...params,
    contentHash: computeHash(params),
    createdAt: snapshot.createdAt,
  }
}
