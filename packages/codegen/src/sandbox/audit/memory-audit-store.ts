/**
 * In-memory audit store for development and testing.
 *
 * Implements SandboxAuditStore with hash-chained entries.
 * Uses a simple string-based hash (sum of char codes) since
 * Node.js crypto may not be available in all environments.
 */

import type { SandboxAuditEntry, SandboxAuditStore } from './audit-types.js'

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

/**
 * Simple deterministic hash for audit chain integrity.
 * Not cryptographic — sufficient for tamper detection in dev/test.
 */
function simpleHash(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h = ((h << 5) - h + ch) | 0
  }
  // Convert to unsigned 32-bit hex
  return (h >>> 0).toString(16).padStart(8, '0')
}

function computeEntryHash(entry: {
  id: string
  seq: number
  sandboxId: string
  action: string
  details: Record<string, unknown>
  previousHash: string
}): string {
  const payload = JSON.stringify({
    id: entry.id,
    seq: entry.seq,
    sandboxId: entry.sandboxId,
    action: entry.action,
    details: entry.details,
    previousHash: entry.previousHash,
  })
  return simpleHash(payload)
}

// ---------------------------------------------------------------------------
// InMemoryAuditStore
// ---------------------------------------------------------------------------

export class InMemoryAuditStore implements SandboxAuditStore {
  private readonly chains = new Map<string, SandboxAuditEntry[]>()

  async append(
    entry: Omit<SandboxAuditEntry, 'seq' | 'previousHash' | 'hash'>,
  ): Promise<SandboxAuditEntry> {
    const chain = this.chains.get(entry.sandboxId) ?? []
    if (!this.chains.has(entry.sandboxId)) {
      this.chains.set(entry.sandboxId, chain)
    }

    const seq = chain.length
    const previousHash = seq > 0 ? chain[seq - 1]!.hash : ''

    const full: Omit<SandboxAuditEntry, 'hash'> & { hash: string } = {
      ...entry,
      seq,
      previousHash,
      hash: '', // temporary
    }
    full.hash = computeEntryHash(full)

    chain.push(full)
    return { ...full }
  }

  async getBySandbox(sandboxId: string): Promise<SandboxAuditEntry[]> {
    const chain = this.chains.get(sandboxId) ?? []
    return chain.map((e) => ({ ...e }))
  }

  async verifyChain(
    sandboxId: string,
  ): Promise<{ valid: boolean; brokenAt?: number }> {
    const chain = this.chains.get(sandboxId) ?? []
    if (chain.length === 0) {
      return { valid: true }
    }

    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i]!

      // Verify previous hash link
      if (i === 0) {
        if (entry.previousHash !== '') {
          return { valid: false, brokenAt: i }
        }
      } else {
        const prev = chain[i - 1]!
        if (entry.previousHash !== prev.hash) {
          return { valid: false, brokenAt: i }
        }
      }

      // Verify self-hash
      const expected = computeEntryHash(entry)
      if (entry.hash !== expected) {
        return { valid: false, brokenAt: i }
      }
    }

    return { valid: true }
  }
}
