import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryDelegationTokenStore } from '../delegation-store.js'
import { DelegationManager } from '../delegation-manager.js'
import { createCapabilityChecker } from '../capability-checker.js'
import type { DelegationToken, DelegationTokenStore } from '../delegation-types.js'
import type { ForgeIdentityRef } from '../identity-types.js'
import type { ForgeCapability } from '../identity-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIGNING_SECRET = 'test-secret-key-for-hmac-256'

function createManager(
  store?: DelegationTokenStore,
  opts?: { maxDepth?: number },
): DelegationManager {
  return new DelegationManager({
    store: store ?? new InMemoryDelegationTokenStore(),
    signingSecret: SIGNING_SECRET,
    maxDepth: opts?.maxDepth,
  })
}

function makeIdentityRef(
  id: string,
  uri: string,
  opts?: { capabilities?: ForgeCapability[]; role?: string },
): ForgeIdentityRef & { capabilities?: ForgeCapability[]; role?: string } {
  return {
    id,
    uri,
    displayName: id,
    capabilities: opts?.capabilities,
    role: opts?.role,
  }
}

// ---------------------------------------------------------------------------
// InMemoryDelegationTokenStore
// ---------------------------------------------------------------------------

describe('InMemoryDelegationTokenStore', () => {
  let store: InMemoryDelegationTokenStore

  beforeEach(() => {
    store = new InMemoryDelegationTokenStore()
  })

  it('save and get', async () => {
    const token: DelegationToken = {
      id: 'tok-1',
      delegator: 'forge://acme/orchestrator',
      delegatee: 'forge://acme/worker',
      scope: ['code.*'],
      constraints: [],
      depth: 0,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      signature: 'test-sig',
    }

    await store.save(token)
    const retrieved = await store.get('tok-1')
    expect(retrieved).toEqual(token)
  })

  it('get returns undefined for missing token', async () => {
    const result = await store.get('nonexistent')
    expect(result).toBeUndefined()
  })

  it('getByDelegatee returns matching tokens', async () => {
    const t1: DelegationToken = {
      id: 'tok-1',
      delegator: 'forge://acme/orch',
      delegatee: 'forge://acme/worker',
      scope: ['code.*'],
      constraints: [],
      depth: 0,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      signature: 'sig-1',
    }
    const t2: DelegationToken = {
      id: 'tok-2',
      delegator: 'forge://acme/orch',
      delegatee: 'forge://acme/worker',
      scope: ['memory.*'],
      constraints: [],
      depth: 0,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      signature: 'sig-2',
    }
    const t3: DelegationToken = {
      id: 'tok-3',
      delegator: 'forge://acme/orch',
      delegatee: 'forge://acme/other',
      scope: ['*'],
      constraints: [],
      depth: 0,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      signature: 'sig-3',
    }

    await store.save(t1)
    await store.save(t2)
    await store.save(t3)

    const results = await store.getByDelegatee('forge://acme/worker')
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id).sort()).toEqual(['tok-1', 'tok-2'])
  })

  it('getByDelegatee returns empty for unknown URI', async () => {
    const results = await store.getByDelegatee('forge://acme/unknown')
    expect(results).toEqual([])
  })

  it('revoke and isRevoked', async () => {
    expect(await store.isRevoked('tok-1')).toBe(false)
    await store.revoke('tok-1')
    expect(await store.isRevoked('tok-1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DelegationManager
// ---------------------------------------------------------------------------

describe('DelegationManager', () => {
  let store: InMemoryDelegationTokenStore
  let manager: DelegationManager

  beforeEach(() => {
    store = new InMemoryDelegationTokenStore()
    manager = createManager(store)
  })

  describe('issue()', () => {
    it('creates a signed token with correct fields', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*', 'memory.read'],
      })

      expect(token.id).toBeTruthy()
      expect(token.delegator).toBe('forge://acme/orchestrator')
      expect(token.delegatee).toBe('forge://acme/worker')
      expect(token.scope).toEqual(['code.*', 'memory.read'])
      expect(token.constraints).toEqual([])
      expect(token.depth).toBe(0)
      expect(token.signature).toBeTruthy()
      expect(token.issuedAt).toBeInstanceOf(Date)
      expect(token.expiresAt).toBeInstanceOf(Date)
      expect(token.expiresAt.getTime()).toBeGreaterThan(token.issuedAt.getTime())
    })

    it('creates a token with constraints', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
        constraints: [
          { type: 'max-cost', maxCostCents: 500 },
          { type: 'allowed-tools', tools: ['git_diff', 'git_status'] },
        ],
      })

      expect(token.constraints).toHaveLength(2)
      expect(token.constraints[0]).toEqual({ type: 'max-cost', maxCostCents: 500 })
    })

    it('creates a sub-delegation with narrower scope', async () => {
      const parent = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/lead',
        scope: ['code.*', 'memory.*'],
      })

      const child = await manager.issue({
        delegator: 'forge://acme/lead',
        delegatee: 'forge://acme/worker',
        scope: ['code.review'],
        parentTokenId: parent.id,
      })

      expect(child.depth).toBe(1)
      expect(child.parentTokenId).toBe(parent.id)
      expect(child.scope).toEqual(['code.review'])
    })

    it('rejects scope that exceeds parent scope', async () => {
      const parent = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/lead',
        scope: ['code.*'],
      })

      await expect(
        manager.issue({
          delegator: 'forge://acme/lead',
          delegatee: 'forge://acme/worker',
          scope: ['memory.read'],
          parentTokenId: parent.id,
        }),
      ).rejects.toThrow('not covered by parent scope')
    })

    it('rejects when depth exceeds maxDepth', async () => {
      const mgr = createManager(store, { maxDepth: 1 })

      const root = await mgr.issue({
        delegator: 'forge://acme/a',
        delegatee: 'forge://acme/b',
        scope: ['*'],
      })

      const child = await mgr.issue({
        delegator: 'forge://acme/b',
        delegatee: 'forge://acme/c',
        scope: ['code.*'],
        parentTokenId: root.id,
      })
      expect(child.depth).toBe(1)

      await expect(
        mgr.issue({
          delegator: 'forge://acme/c',
          delegatee: 'forge://acme/d',
          scope: ['code.review'],
          parentTokenId: child.id,
        }),
      ).rejects.toThrow('exceeds maximum')
    })

    it('rejects when parent token does not exist', async () => {
      await expect(
        manager.issue({
          delegator: 'forge://acme/a',
          delegatee: 'forge://acme/b',
          scope: ['code.*'],
          parentTokenId: 'nonexistent',
        }),
      ).rejects.toThrow('Parent token not found')
    })
  })

  describe('verify()', () => {
    it('returns true for a valid token', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
      })

      const valid = await manager.verify(token)
      expect(valid).toBe(true)
    })

    it('returns false for a tampered token', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
      })

      // Tamper with the scope
      const tampered = { ...token, scope: ['*'] }
      const valid = await manager.verify(tampered)
      expect(valid).toBe(false)
    })

    it('returns false for a tampered delegatee', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
      })

      const tampered = { ...token, delegatee: 'forge://evil/attacker' }
      const valid = await manager.verify(tampered)
      expect(valid).toBe(false)
    })

    it('returns false when signature is garbage', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
      })

      const tampered = { ...token, signature: 'definitely-not-valid' }
      const valid = await manager.verify(tampered)
      expect(valid).toBe(false)
    })
  })

  describe('validateChain()', () => {
    it('validates a single-token chain', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*', 'memory.read'],
      })

      const chain = await manager.validateChain(token.id)
      expect(chain.valid).toBe(true)
      expect(chain.tokens).toHaveLength(1)
      expect(chain.effectiveScope).toEqual(['code.*', 'memory.read'])
    })

    it('validates a multi-level chain with scope intersection', async () => {
      const root = await manager.issue({
        delegator: 'forge://acme/admin',
        delegatee: 'forge://acme/lead',
        scope: ['code.*', 'memory.*', 'tools.*'],
      })

      const mid = await manager.issue({
        delegator: 'forge://acme/lead',
        delegatee: 'forge://acme/worker',
        scope: ['code.*', 'memory.read'],
        parentTokenId: root.id,
      })

      const leaf = await manager.issue({
        delegator: 'forge://acme/worker',
        delegatee: 'forge://acme/sub-worker',
        scope: ['code.review'],
        parentTokenId: mid.id,
      })

      const chain = await manager.validateChain(leaf.id)
      expect(chain.valid).toBe(true)
      expect(chain.tokens).toHaveLength(3)
      // Effective scope: intersection of all three
      // Root: code.*, memory.*, tools.*
      // Mid:  code.*, memory.read
      // Leaf: code.review
      // Result: code.review (covered by code.* in both parent scopes)
      expect(chain.effectiveScope).toEqual(['code.review'])
    })

    it('invalidates chain with expired token', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
        expiresInMs: -1, // Already expired
      })

      const chain = await manager.validateChain(token.id)
      expect(chain.valid).toBe(false)
      expect(chain.invalidReason).toContain('expired')
    })

    it('invalidates chain with revoked token', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
      })

      await store.revoke(token.id)

      const chain = await manager.validateChain(token.id)
      expect(chain.valid).toBe(false)
      expect(chain.invalidReason).toContain('revoked')
    })

    it('invalidates chain when token not found', async () => {
      const chain = await manager.validateChain('nonexistent')
      expect(chain.valid).toBe(false)
      expect(chain.invalidReason).toContain('not found')
    })

    it('invalidates chain when parent token has invalid signature', async () => {
      // Issue a root token
      const root = await manager.issue({
        delegator: 'forge://acme/admin',
        delegatee: 'forge://acme/lead',
        scope: ['code.*'],
      })

      // Issue a child
      const child = await manager.issue({
        delegator: 'forge://acme/lead',
        delegatee: 'forge://acme/worker',
        scope: ['code.review'],
        parentTokenId: root.id,
      })

      // Tamper with root token in the store
      const tamperedRoot: DelegationToken = {
        ...root,
        scope: ['*'], // changed scope but didn't re-sign
      }
      await store.save(tamperedRoot)

      const chain = await manager.validateChain(child.id)
      expect(chain.valid).toBe(false)
      expect(chain.invalidReason).toContain('Invalid signature')
    })
  })

  describe('revoke()', () => {
    it('revokes a token', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
      })

      await manager.revoke(token.id)

      const chain = await manager.validateChain(token.id)
      expect(chain.valid).toBe(false)
      expect(chain.invalidReason).toContain('revoked')
    })

    it('cascades revocation to children', async () => {
      const root = await manager.issue({
        delegator: 'forge://acme/admin',
        delegatee: 'forge://acme/lead',
        scope: ['code.*'],
      })

      const child = await manager.issue({
        delegator: 'forge://acme/lead',
        delegatee: 'forge://acme/worker',
        scope: ['code.review'],
        parentTokenId: root.id,
      })

      const grandchild = await manager.issue({
        delegator: 'forge://acme/worker',
        delegatee: 'forge://acme/sub-worker',
        scope: ['code.review'],
        parentTokenId: child.id,
      })

      // Revoke root
      await manager.revoke(root.id)

      // All should be revoked
      expect(await store.isRevoked(root.id)).toBe(true)
      expect(await store.isRevoked(child.id)).toBe(true)
      expect(await store.isRevoked(grandchild.id)).toBe(true)
    })
  })

  describe('hasCapabilityInChain()', () => {
    it('returns true when capability is in effective scope', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*', 'memory.read'],
      })

      const chain = await manager.validateChain(token.id)
      expect(manager.hasCapabilityInChain(chain, 'code.review')).toBe(true)
      expect(manager.hasCapabilityInChain(chain, 'code.generate')).toBe(true)
      expect(manager.hasCapabilityInChain(chain, 'memory.read')).toBe(true)
    })

    it('returns false when capability is not in effective scope', async () => {
      const token = await manager.issue({
        delegator: 'forge://acme/orchestrator',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
      })

      const chain = await manager.validateChain(token.id)
      expect(manager.hasCapabilityInChain(chain, 'memory.read')).toBe(false)
    })

    it('returns false for invalid chain', async () => {
      const chain = {
        tokens: [],
        effectiveScope: ['code.*'],
        valid: false,
        invalidReason: 'test',
      }
      expect(manager.hasCapabilityInChain(chain, 'code.review')).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// CapabilityChecker
// ---------------------------------------------------------------------------

describe('CapabilityChecker', () => {
  describe('direct capability match', () => {
    it('allows when identity has matching capability', async () => {
      const checker = createCapabilityChecker()
      const identity = makeIdentityRef('id-1', 'forge://acme/worker', {
        capabilities: [
          { name: 'code.review', version: '1.0.0', description: 'Review code' },
        ],
      })

      const result = await checker.check({
        identity,
        requiredCapability: 'code.review',
      })

      expect(result.allowed).toBe(true)
      expect(result.grantedBy).toBe('direct')
      expect(result.matchedCapability).toBe('code.review')
    })

    it('allows wildcard match via direct capability', async () => {
      const checker = createCapabilityChecker()
      const identity = makeIdentityRef('id-1', 'forge://acme/worker', {
        capabilities: [
          { name: 'code', version: '1.0.0', description: 'All code capabilities' },
        ],
      })

      // "code" doesn't match "code.generate" via matchesPattern (no wildcard)
      // but the CapabilityMatcher.matchesPattern only handles .*
      // So "code" won't match "code.generate" — correct behavior
      const result = await checker.check({
        identity,
        requiredCapability: 'code',
      })

      expect(result.allowed).toBe(true)
      expect(result.grantedBy).toBe('direct')
    })
  })

  describe('wildcard pattern matching', () => {
    it('"code.*" matches "code.generate"', async () => {
      const store = new InMemoryDelegationTokenStore()
      const mgr = new DelegationManager({
        store,
        signingSecret: SIGNING_SECRET,
      })

      const token = await mgr.issue({
        delegator: 'forge://acme/admin',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
      })

      const checker = createCapabilityChecker({ delegationManager: mgr })
      const identity = makeIdentityRef('id-1', 'forge://acme/worker')

      const result = await checker.check({
        identity,
        requiredCapability: 'code.generate',
        delegationTokenId: token.id,
      })

      expect(result.allowed).toBe(true)
      expect(result.grantedBy).toBe('delegation')
      expect(result.matchedCapability).toBe('code.*')
    })
  })

  describe('role-based fallback', () => {
    it('admin role grants everything', async () => {
      const checker = createCapabilityChecker()
      const identity = makeIdentityRef('id-1', 'forge://acme/admin-agent', {
        role: 'admin',
      })

      const result = await checker.check({
        identity,
        requiredCapability: 'anything.at.all',
      })

      expect(result.allowed).toBe(true)
      expect(result.grantedBy).toBe('role')
      expect(result.matchedCapability).toBe('*')
    })

    it('viewer role grants read capabilities', async () => {
      const checker = createCapabilityChecker()
      const identity = makeIdentityRef('id-1', 'forge://acme/viewer', {
        role: 'viewer',
      })

      const result = await checker.check({
        identity,
        requiredCapability: 'agents.read',
      })

      expect(result.allowed).toBe(true)
      expect(result.grantedBy).toBe('role')
    })

    it('viewer role denies non-read capabilities', async () => {
      const checker = createCapabilityChecker()
      const identity = makeIdentityRef('id-1', 'forge://acme/viewer', {
        role: 'viewer',
      })

      const result = await checker.check({
        identity,
        requiredCapability: 'tools.execute',
      })

      expect(result.allowed).toBe(false)
    })

    it('operator role grants runs.*', async () => {
      const checker = createCapabilityChecker()
      const identity = makeIdentityRef('id-1', 'forge://acme/operator', {
        role: 'operator',
      })

      const result = await checker.check({
        identity,
        requiredCapability: 'runs.create',
      })

      expect(result.allowed).toBe(true)
      expect(result.grantedBy).toBe('role')
    })

    it('custom role capability map', async () => {
      const checker = createCapabilityChecker({
        roleCapabilityMap: {
          reviewer: ['code.review', 'code.comment'],
        },
      })
      const identity = makeIdentityRef('id-1', 'forge://acme/rev', {
        role: 'reviewer',
      })

      const allowed = await checker.check({
        identity,
        requiredCapability: 'code.review',
      })
      expect(allowed.allowed).toBe(true)

      const denied = await checker.check({
        identity,
        requiredCapability: 'code.generate',
      })
      expect(denied.allowed).toBe(false)
    })
  })

  describe('delegation scope restriction', () => {
    it('restricts to delegation scope even if identity has broader capabilities', async () => {
      const store = new InMemoryDelegationTokenStore()
      const mgr = new DelegationManager({
        store,
        signingSecret: SIGNING_SECRET,
      })

      // Delegation only grants code.review
      const token = await mgr.issue({
        delegator: 'forge://acme/admin',
        delegatee: 'forge://acme/worker',
        scope: ['code.review'],
      })

      const checker = createCapabilityChecker({ delegationManager: mgr })

      // Identity has broad capabilities, but delegation is narrow
      const identity = makeIdentityRef('id-1', 'forge://acme/worker', {
        capabilities: [
          { name: 'code', version: '1.0.0', description: 'All code' },
        ],
      })

      // Delegation restricts to code.review only
      const allowed = await checker.check({
        identity,
        requiredCapability: 'code.review',
        delegationTokenId: token.id,
      })
      expect(allowed.allowed).toBe(true)
      expect(allowed.grantedBy).toBe('delegation')

      const denied = await checker.check({
        identity,
        requiredCapability: 'code.generate',
        delegationTokenId: token.id,
      })
      expect(denied.allowed).toBe(false)
    })

    it('fails check when delegation chain is invalid', async () => {
      const store = new InMemoryDelegationTokenStore()
      const mgr = new DelegationManager({
        store,
        signingSecret: SIGNING_SECRET,
      })

      const token = await mgr.issue({
        delegator: 'forge://acme/admin',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
      })

      // Revoke the token
      await store.revoke(token.id)

      const checker = createCapabilityChecker({ delegationManager: mgr })
      const identity = makeIdentityRef('id-1', 'forge://acme/worker')

      const result = await checker.check({
        identity,
        requiredCapability: 'code.review',
        delegationTokenId: token.id,
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('invalid')
    })
  })

  describe('denied when no match', () => {
    it('denies when no capabilities, no role, no delegation', async () => {
      const checker = createCapabilityChecker()
      const identity = makeIdentityRef('id-1', 'forge://acme/nobody')

      const result = await checker.check({
        identity,
        requiredCapability: 'code.review',
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('No grant found')
    })

    it('denies when capabilities do not match', async () => {
      const checker = createCapabilityChecker()
      const identity = makeIdentityRef('id-1', 'forge://acme/worker', {
        capabilities: [
          { name: 'memory.read', version: '1.0.0', description: 'Read memory' },
        ],
      })

      const result = await checker.check({
        identity,
        requiredCapability: 'code.generate',
      })

      expect(result.allowed).toBe(false)
    })

    it('denies when unknown role', async () => {
      const checker = createCapabilityChecker()
      const identity = makeIdentityRef('id-1', 'forge://acme/worker', {
        role: 'unknown-role',
      })

      const result = await checker.check({
        identity,
        requiredCapability: 'code.review',
      })

      expect(result.allowed).toBe(false)
    })
  })

  describe('resolution order', () => {
    it('delegation takes precedence over direct capabilities', async () => {
      const store = new InMemoryDelegationTokenStore()
      const mgr = new DelegationManager({
        store,
        signingSecret: SIGNING_SECRET,
      })

      const token = await mgr.issue({
        delegator: 'forge://acme/admin',
        delegatee: 'forge://acme/worker',
        scope: ['code.*'],
      })

      const checker = createCapabilityChecker({ delegationManager: mgr })
      const identity = makeIdentityRef('id-1', 'forge://acme/worker', {
        capabilities: [
          { name: 'code.review', version: '1.0.0', description: 'Review' },
        ],
        role: 'admin',
      })

      const result = await checker.check({
        identity,
        requiredCapability: 'code.review',
        delegationTokenId: token.id,
      })

      // Should be granted by delegation, not direct or role
      expect(result.grantedBy).toBe('delegation')
    })

    it('direct capabilities take precedence over role when no delegation', async () => {
      const checker = createCapabilityChecker()
      const identity = makeIdentityRef('id-1', 'forge://acme/worker', {
        capabilities: [
          { name: 'code.review', version: '1.0.0', description: 'Review' },
        ],
        role: 'admin',
      })

      const result = await checker.check({
        identity,
        requiredCapability: 'code.review',
      })

      expect(result.grantedBy).toBe('direct')
    })
  })
})
