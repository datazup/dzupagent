import { describe, expect, it } from 'vitest'
import type {
  RetryPolicy,
  StuckDetectorConfig,
  ToolPermissionEntry,
  ToolPermissionPolicy,
  ToolScope,
} from '../index.js'

describe('@dzupagent/agent-types public surface', () => {
  describe('RetryPolicy', () => {
    it('accepts the minimal required fields', () => {
      const policy: RetryPolicy = {
        initialBackoffMs: 200,
        maxBackoffMs: 8_000,
        multiplier: 2,
      }

      expect(policy.initialBackoffMs).toBe(200)
      expect(policy.maxBackoffMs).toBe(8_000)
      expect(policy.multiplier).toBe(2)
      expect(policy.maxAttempts).toBeUndefined()
      expect(policy.jitter).toBeUndefined()
      expect(policy.shouldRetry).toBeUndefined()
    })

    it('accepts all optional fields', () => {
      const policy: RetryPolicy = {
        maxAttempts: 5,
        initialBackoffMs: 100,
        maxBackoffMs: 30_000,
        multiplier: 1.5,
        backoffMultiplier: 1.5,
        jitter: true,
        shouldRetry: (err) => err instanceof Error,
      }

      expect(policy.maxAttempts).toBe(5)
      expect(policy.backoffMultiplier).toBe(1.5)
      expect(policy.jitter).toBe(true)
      expect(typeof policy.shouldRetry).toBe('function')
    })

    it('accepts jitter as a range object', () => {
      const policy: RetryPolicy = {
        initialBackoffMs: 50,
        maxBackoffMs: 5_000,
        multiplier: 2,
        jitter: { min: 0.5, max: 1.0 },
      }

      expect(policy.jitter).toEqual({ min: 0.5, max: 1.0 })
    })

    it('shouldRetry predicate returns boolean at runtime', () => {
      const policy: RetryPolicy = {
        initialBackoffMs: 100,
        maxBackoffMs: 1_000,
        multiplier: 2,
        shouldRetry: (err) => err instanceof TypeError,
      }

      // The predicate is callable — verify runtime behaviour
      expect(policy.shouldRetry!(new TypeError('network error'))).toBe(true)
      expect(policy.shouldRetry!(new Error('generic'))).toBe(false)
    })

    it('backoffMultiplier field is optional and independent of multiplier', () => {
      // backoffMultiplier is a legacy alias; only multiplier should be required
      const withAlias: RetryPolicy = {
        initialBackoffMs: 100,
        maxBackoffMs: 1_000,
        multiplier: 2,
        backoffMultiplier: 2,
      }
      const withoutAlias: RetryPolicy = {
        initialBackoffMs: 100,
        maxBackoffMs: 1_000,
        multiplier: 2,
      }

      expect(withAlias.backoffMultiplier).toBe(2)
      expect(withoutAlias.backoffMultiplier).toBeUndefined()
    })
  })

  describe('StuckDetectorConfig', () => {
    it('accepts empty config (all fields optional)', () => {
      const config: StuckDetectorConfig = {}

      expect(config.maxRepeatCalls).toBeUndefined()
      expect(config.maxErrorsInWindow).toBeUndefined()
      expect(config.errorWindowMs).toBeUndefined()
      expect(config.maxIdleIterations).toBeUndefined()
    })

    it('accepts a fully-populated config', () => {
      const config: StuckDetectorConfig = {
        maxRepeatCalls: 3,
        maxErrorsInWindow: 5,
        errorWindowMs: 60_000,
        maxIdleIterations: 3,
      }

      expect(config.maxRepeatCalls).toBe(3)
      expect(config.maxErrorsInWindow).toBe(5)
      expect(config.errorWindowMs).toBe(60_000)
      expect(config.maxIdleIterations).toBe(3)
    })
  })

  describe('ToolScope', () => {
    it('valid scope values satisfy the union type at runtime', () => {
      const validScopes: ToolScope[] = ['private', 'shared', 'borrowed']

      expect(validScopes).toHaveLength(3)
      expect(validScopes).toContain('private')
      expect(validScopes).toContain('shared')
      expect(validScopes).toContain('borrowed')
    })
  })

  describe('ToolPermissionEntry', () => {
    it('accepts the minimal required fields', () => {
      const entry: ToolPermissionEntry = {
        name: 'bash',
        scope: 'private',
      }

      expect(entry.name).toBe('bash')
      expect(entry.scope).toBe('private')
      expect(entry.ownerId).toBeUndefined()
    })

    it('accepts an entry with an ownerId', () => {
      const entry: ToolPermissionEntry = {
        name: 'read-file',
        ownerId: 'agent-42',
        scope: 'borrowed',
      }

      expect(entry.ownerId).toBe('agent-42')
      expect(entry.scope).toBe('borrowed')
    })
  })

  describe('ToolPermissionPolicy', () => {
    it('is satisfied by a minimal mock implementation', () => {
      const allowAll: ToolPermissionPolicy = {
        hasPermission: (_callerAgentId, _toolName) => true,
      }
      const denyAll: ToolPermissionPolicy = {
        hasPermission: (_callerAgentId, _toolName) => false,
      }

      expect(allowAll.hasPermission('agent-1', 'bash')).toBe(true)
      expect(denyAll.hasPermission('agent-1', 'bash')).toBe(false)
    })

    it('supports ownership-based permission logic', () => {
      const ownershipPolicy: ToolPermissionPolicy = {
        hasPermission: (callerAgentId, toolName) => {
          const ownedTools: Record<string, string> = {
            bash: 'agent-1',
            'read-file': 'agent-2',
          }
          const owner = ownedTools[toolName]
          // No owner means shared; otherwise only the owner may call it
          return owner === undefined || owner === callerAgentId
        },
      }

      expect(ownershipPolicy.hasPermission('agent-1', 'bash')).toBe(true)
      expect(ownershipPolicy.hasPermission('agent-2', 'bash')).toBe(false)
      expect(ownershipPolicy.hasPermission('agent-2', 'read-file')).toBe(true)
      // Tool with no registered owner is shared
      expect(ownershipPolicy.hasPermission('agent-99', 'unknown-tool')).toBe(true)
    })
  })
})
