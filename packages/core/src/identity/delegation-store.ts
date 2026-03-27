/**
 * In-memory implementation of DelegationTokenStore.
 *
 * Suitable for testing, development, and single-process deployments.
 * For production use, replace with a persistent store implementation.
 */
import type { DelegationToken, DelegationTokenStore } from './delegation-types.js'

export class InMemoryDelegationTokenStore implements DelegationTokenStore {
  private readonly tokens = new Map<string, DelegationToken>()
  private readonly revoked = new Set<string>()
  private readonly byDelegatee = new Map<string, Set<string>>()

  async save(token: DelegationToken): Promise<void> {
    this.tokens.set(token.id, token)

    let delegateeSet = this.byDelegatee.get(token.delegatee)
    if (!delegateeSet) {
      delegateeSet = new Set<string>()
      this.byDelegatee.set(token.delegatee, delegateeSet)
    }
    delegateeSet.add(token.id)
  }

  async get(tokenId: string): Promise<DelegationToken | undefined> {
    return this.tokens.get(tokenId)
  }

  async getByDelegatee(delegateeUri: string): Promise<DelegationToken[]> {
    const ids = this.byDelegatee.get(delegateeUri)
    if (!ids) return []

    const result: DelegationToken[] = []
    for (const id of ids) {
      const token = this.tokens.get(id)
      if (token) {
        result.push(token)
      }
    }
    return result
  }

  async revoke(tokenId: string): Promise<void> {
    this.revoked.add(tokenId)
  }

  async isRevoked(tokenId: string): Promise<boolean> {
    return this.revoked.has(tokenId)
  }
}
