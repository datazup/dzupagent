import { describe, it, expect } from 'vitest'
import {
  forgeContextStore,
  withForgeContext,
  currentForgeContext,
  type ForgeTraceContext,
} from '../trace-context-store.js'

function makeCtx(overrides?: Partial<ForgeTraceContext>): ForgeTraceContext {
  return {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    baggage: {},
    ...overrides,
  }
}

describe('trace-context-store', () => {
  describe('currentForgeContext', () => {
    it('returns undefined outside of any context', () => {
      expect(currentForgeContext()).toBeUndefined()
    })

    it('returns the active context inside withForgeContext', () => {
      const ctx = makeCtx({ agentId: 'a1', runId: 'r1' })
      const result = withForgeContext(ctx, () => currentForgeContext())
      expect(result).toBeDefined()
      expect(result!.agentId).toBe('a1')
      expect(result!.runId).toBe('r1')
      expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    })
  })

  describe('withForgeContext', () => {
    it('returns the value from the callback', () => {
      const result = withForgeContext(makeCtx(), () => 42)
      expect(result).toBe(42)
    })

    it('context is not visible after callback completes', () => {
      withForgeContext(makeCtx({ agentId: 'temp' }), () => {
        // inside
      })
      expect(currentForgeContext()).toBeUndefined()
    })

    it('propagates through async operations', async () => {
      const ctx = makeCtx({ agentId: 'async-agent' })

      const result = await withForgeContext(ctx, async () => {
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10))
        return currentForgeContext()
      })

      expect(result).toBeDefined()
      expect(result!.agentId).toBe('async-agent')
    })
  })

  describe('nested contexts', () => {
    it('child context inherits parent fields', () => {
      const parent = makeCtx({
        agentId: 'parent-agent',
        runId: 'parent-run',
        tenantId: 'tenant-1',
      })

      const result = withForgeContext(parent, () => {
        // Child context overrides agentId but inherits tenantId
        return withForgeContext(
          makeCtx({ agentId: 'child-agent', spanId: 'childspan' }),
          () => currentForgeContext(),
        )
      })

      expect(result).toBeDefined()
      expect(result!.agentId).toBe('child-agent')
      expect(result!.spanId).toBe('childspan')
      // Inherited from parent
      expect(result!.tenantId).toBe('tenant-1')
      expect(result!.runId).toBe('parent-run')
    })

    it('child baggage merges with parent baggage', () => {
      const parent = makeCtx({
        baggage: { env: 'prod', region: 'us-east-1' },
      })

      const result = withForgeContext(parent, () => {
        return withForgeContext(
          makeCtx({ baggage: { region: 'eu-west-1', feature: 'chat' } }),
          () => currentForgeContext(),
        )
      })

      expect(result!.baggage).toEqual({
        env: 'prod',           // from parent
        region: 'eu-west-1',   // overridden by child
        feature: 'chat',       // new from child
      })
    })

    it('parent context is restored after child exits', () => {
      const parent = makeCtx({ agentId: 'parent' })

      const result = withForgeContext(parent, () => {
        withForgeContext(makeCtx({ agentId: 'child' }), () => {
          // inside child
        })
        // Back in parent
        return currentForgeContext()
      })

      expect(result!.agentId).toBe('parent')
    })

    it('deeply nested contexts accumulate correctly', () => {
      const result = withForgeContext(
        makeCtx({ agentId: 'L1', baggage: { a: '1' } }),
        () =>
          withForgeContext(
            makeCtx({ phase: 'plan', baggage: { b: '2' } }),
            () =>
              withForgeContext(
                makeCtx({ tenantId: 'T1', baggage: { c: '3' } }),
                () => currentForgeContext(),
              ),
          ),
      )

      expect(result!.agentId).toBe('L1') // from L1 (not overridden)
      expect(result!.phase).toBe('plan')  // from L2
      expect(result!.tenantId).toBe('T1') // from L3
      expect(result!.baggage).toEqual({ a: '1', b: '2', c: '3' })
    })
  })

  describe('forgeContextStore (raw AsyncLocalStorage)', () => {
    it('can be used directly for advanced cases', () => {
      const ctx = makeCtx({ agentId: 'direct' })
      const result = forgeContextStore.run(ctx, () => {
        return forgeContextStore.getStore()
      })
      expect(result?.agentId).toBe('direct')
    })
  })
})
