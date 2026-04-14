/**
 * SyncProtocol — the core sync engine for CRDT memory replication.
 *
 * Handles the full sync message flow:
 * 1. sync:hello -> sync:digest (for matching namespaces)
 * 2. sync:digest -> sync:request-delta (if digests differ)
 * 3. sync:request-delta -> sync:delta (compute and send delta)
 * 4. sync:delta -> sync:ack (apply delta, report results)
 *
 * Also supports periodic anti-entropy via startAntiEntropy().
 */

import type { HLC } from '../crdt/hlc.js'
import type { SharedMemoryNamespace } from '../shared-namespace.js'
import { MerkleDigest } from './merkle-digest.js'
import type {
  SyncConfig,
  SyncDelta,
  SyncDigest,
  SyncMessage,
  SyncTransport,
} from './types.js'

export class SyncProtocol {
  private readonly config: Required<Pick<SyncConfig, 'maxBatchSize'>> & SyncConfig
  private readonly namespaceName: string

  constructor(
    config: SyncConfig,
    private readonly namespace: SharedMemoryNamespace,
    private readonly hlc: HLC,
  ) {
    this.config = {
      ...config,
      maxBatchSize: config.maxBatchSize ?? 100,
    }
    // Derive a stable namespace name from config
    this.namespaceName = config.namespaces?.[0] ?? 'default'
  }

  /**
   * Handle an incoming sync message. Returns zero or more response messages.
   *
   * This is a pure state-machine step: it reads the current namespace state,
   * processes the message, applies mutations if needed, and returns responses.
   */
  handleMessage(message: SyncMessage): SyncMessage[] {
    switch (message.type) {
      case 'sync:hello':
        return this.handleHello(message)
      case 'sync:digest':
        return this.handleDigest(message)
      case 'sync:request-delta':
        return this.handleRequestDelta(message)
      case 'sync:delta':
        return this.handleDelta(message)
      case 'sync:ack':
        // Ack is terminal — no response needed
        return []
      case 'sync:error':
        // Error is terminal — no response needed
        return []
    }
  }

  /** Generate a digest for the current namespace state. */
  generateDigest(): SyncDigest {
    return MerkleDigest.fromNamespace(this.config.nodeId, this.namespace, this.hlc)
  }

  /** Generate a delta based on a remote node's version map. */
  generateDelta(remoteVersionMap: Record<string, number>): SyncDelta {
    const localEntries = this.namespace.list()
    let deltaEntries = MerkleDigest.findDelta(localEntries, remoteVersionMap)

    // Respect max batch size
    if (deltaEntries.length > (this.config.maxBatchSize ?? 100)) {
      // Sort by version ascending so the receiver gets oldest-first (causal order)
      deltaEntries = deltaEntries
        .sort((a, b) => a.version - b.version)
        .slice(0, this.config.maxBatchSize ?? 100)
    }

    return {
      sourceNodeId: this.config.nodeId,
      entries: deltaEntries,
      generatedAt: this.hlc.now(),
    }
  }

  /**
   * Apply a received delta by merging into the local namespace.
   *
   * Returns the merge result with accepted/rejected/conflicts counts.
   */
  applyDelta(delta: SyncDelta): { accepted: number; rejected: number; conflicts: number } {
    // Advance local HLC based on the remote's timestamp
    this.hlc.receive(delta.generatedAt)

    const report = this.namespace.merge(delta.entries)
    return {
      accepted: report.accepted,
      rejected: report.rejected,
      conflicts: report.conflicts,
    }
  }

  /**
   * Start the anti-entropy loop.
   *
   * Periodically sends a digest to the peer so both sides can detect drift
   * and request deltas. Returns a stop function to cancel the loop.
   */
  startAntiEntropy(transport: SyncTransport): () => void {
    const intervalMs = this.config.antiEntropyIntervalMs ?? 30_000

    const tick = (): void => {
      const digest = this.generateDigest()
      transport.send({
        type: 'sync:digest',
        digest,
        namespace: this.namespaceName,
      }).catch(() => {
        // Non-fatal: transport errors are handled at the session level
      })
    }

    const handle = setInterval(tick, intervalMs)

    return () => {
      clearInterval(handle)
    }
  }

  // -------------------------------------------------------------------------
  // Private message handlers
  // -------------------------------------------------------------------------

  private handleHello(message: SyncMessage & { type: 'sync:hello' }): SyncMessage[] {
    // Respond with our digest for each namespace the peer wants
    const requestedNamespaces = message.namespaces
    if (
      requestedNamespaces.length === 0 ||
      requestedNamespaces.includes(this.namespaceName)
    ) {
      return [
        {
          type: 'sync:digest',
          digest: this.generateDigest(),
          namespace: this.namespaceName,
        },
      ]
    }
    return []
  }

  private handleDigest(message: SyncMessage & { type: 'sync:digest' }): SyncMessage[] {
    const localDigest = this.generateDigest()

    // If root hashes match, no sync needed
    if (localDigest.rootHash === message.digest.rootHash) {
      return []
    }

    // Request delta with our version map so remote can compute what we're missing
    return [
      {
        type: 'sync:request-delta',
        namespace: message.namespace,
        sinceVersionMap: localDigest.versionMap,
      },
    ]
  }

  private handleRequestDelta(
    message: SyncMessage & { type: 'sync:request-delta' },
  ): SyncMessage[] {
    const delta = this.generateDelta(message.sinceVersionMap)

    if (delta.entries.length === 0) {
      return []
    }

    return [
      {
        type: 'sync:delta',
        delta,
        namespace: message.namespace,
      },
    ]
  }

  private handleDelta(message: SyncMessage & { type: 'sync:delta' }): SyncMessage[] {
    const result = this.applyDelta(message.delta)

    return [
      {
        type: 'sync:ack',
        namespace: message.namespace,
        acceptedCount: result.accepted,
        rejectedCount: result.rejected,
      },
    ]
  }
}
