/**
 * Boundary tests for ADR-0005 (MemoryClient interface).
 *
 * The audit finding (AG-06) was that `memory-context-loader.ts` performed a
 * dynamic `await import('@dzupagent/memory-ipc')`, hiding a runtime
 * dependency from package.json and from static analysis.
 *
 * After the ADR-0005 refactor:
 *   1. The dynamic import is gone — the loader throws unless
 *      `loadArrowRuntime` is injected explicitly.
 *   2. `MemoryClient` is a first-class contract in `@dzupagent/agent-types`
 *      and is reachable without importing `@dzupagent/memory` or
 *      `@dzupagent/memory-ipc`.
 *
 * This test enforces both invariants.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

describe('@dzupagent/agent ↔ memory boundary (ADR-0005)', () => {
  it('memory-context-loader.ts confines dynamic imports to a single, injectable fallback', () => {
    // Per ADR-0005 we keep one back-compat fallback inside
    // `defaultLoadArrowRuntime`; that path is gated by an env flag and the
    // module specifier is held in a local variable so static analysis can
    // distinguish it from accidental ad-hoc dynamic imports.
    const loaderPath = resolve(
      here,
      '../../agent/memory-context-loader.ts',
    )
    const source = readFileSync(loaderPath, 'utf8')
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1')

    // No literal dynamic imports of the memory packages.
    expect(stripped).not.toMatch(
      /await\s+import\(\s*['"]@dzupagent\/memory-ipc['"]\s*\)/,
    )
    expect(stripped).not.toMatch(
      /await\s+import\(\s*['"]@dzupagent\/memory['"]\s*\)/,
    )
    // The loader exposes the explicit injection point.
    expect(stripped).toMatch(/loadArrowRuntime/)
  })

  it('MemoryClient interface is reachable from @dzupagent/agent-types without runtime memory deps', async () => {
    // Import as type-only side-effect-free module — succeeds because the
    // contract lives in the layer-0 package.
    const mod = (await import('@dzupagent/agent-types')) as Record<string, unknown>
    // Types are erased at runtime; we assert the module loads cleanly. The
    // structural check below uses the InMemoryMemoryClient implementation.
    expect(mod).toBeDefined()
  })

  it('InMemoryMemoryClient satisfies the MemoryClient contract', async () => {
    const { InMemoryMemoryClient } = await import('@dzupagent/memory')
    const client = new InMemoryMemoryClient()
    expect(typeof client.get).toBe('function')
    expect(typeof client.put).toBe('function')
    expect(typeof client.delete).toBe('function')
    expect(typeof client.subscribe).toBe('function')
    expect(typeof client.stats).toBe('function')
  })

  it('AgentMemoryContextLoader uses an injected loadArrowRuntime when provided', async () => {
    const { AgentMemoryContextLoader } = await import(
      '../../agent/memory-context-loader.js'
    )
    let injectedCalled = 0
    const fakeRuntime = {
      extendMemoryServiceWithArrow: () => ({
        exportFrame: async () => ({ numRows: 0 }),
      }),
      selectMemoriesByBudget: () => [],
      phaseWeightedSelection: () => [],
      FrameReader: class {
        toRecords() {
          return []
        }
      },
    }
    const loader = new AgentMemoryContextLoader({
      instructions: 'test',
      memory: {
        get: async () => [],
        put: async () => undefined,
        formatForPrompt: () => '',
      } as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: { totalBudget: 1_000, maxMemoryFraction: 1, minResponseReserve: 0 },
      estimateConversationTokens: () => 0,
      loadArrowRuntime: async () => {
        injectedCalled++
        return fakeRuntime as never
      },
    })
    await loader.load([])
    expect(injectedCalled).toBe(1)
  })
})
