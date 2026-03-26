import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryIntegrator } from '../memory-integrator.js'
import type { MemoryContext } from '../memory-integrator.js'
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Mock store factory (mirrors lesson-pipeline.test.ts pattern)
// ---------------------------------------------------------------------------

function createMockStore(initialData?: Map<string, Map<string, Record<string, unknown>>>) {
  // Keyed by JSON-serialized namespace → Map<key, value>
  const namespaces = initialData ?? new Map<string, Map<string, Record<string, unknown>>>()

  function getNamespaceMap(ns: string[]): Map<string, Record<string, unknown>> {
    const nsKey = JSON.stringify(ns)
    let map = namespaces.get(nsKey)
    if (!map) {
      map = new Map()
      namespaces.set(nsKey, map)
    }
    return map
  }

  const store = {
    search: vi.fn().mockImplementation((ns: string[], opts?: { query?: string; limit?: number }) => {
      const map = getNamespaceMap(ns)
      const items = [...map.entries()].map(([key, value]) => ({ key, value }))
      return Promise.resolve(items.slice(0, opts?.limit ?? items.length))
    }),
    put: vi.fn().mockImplementation((ns: string[], key: string, value: Record<string, unknown>) => {
      getNamespaceMap(ns).set(key, value)
      return Promise.resolve()
    }),
    get: vi.fn().mockImplementation((ns: string[], key: string) => {
      const map = getNamespaceMap(ns)
      const value = map.get(key)
      return Promise.resolve(value ? { key, value } : undefined)
    }),
    _namespaces: namespaces,
    _getNamespaceMap: getNamespaceMap,
  }

  return store as unknown as BaseStore & {
    _namespaces: Map<string, Map<string, Record<string, unknown>>>
    _getNamespaceMap: (ns: string[]) => Map<string, Record<string, unknown>>
    put: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
  }
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedLessons(store: ReturnType<typeof createMockStore>): void {
  const ns = store._getNamespaceMap(['lessons'])
  ns.set('lesson-1', {
    id: 'lesson-1',
    type: 'error_resolution',
    summary: 'When generating backend routes, always validate input with Zod',
    details: 'Error at gen_backend was resolved by adding Zod validation.',
    applicableContext: ['gen_backend', 'ValidationError'],
    confidence: 0.9,
    text: 'When generating backend routes, always validate input with Zod',
  })
  ns.set('lesson-2', {
    id: 'lesson-2',
    type: 'error_resolution',
    summary: 'Error at gen_db: fixed by adding explicit foreign key constraints',
    details: 'gen_db node failed with referential integrity error.',
    applicableContext: ['gen_db', 'IntegrityError'],
    confidence: 0.85,
    text: 'Error at gen_db: fixed by adding explicit foreign key constraints',
  })
  ns.set('lesson-3', {
    id: 'lesson-3',
    type: 'successful_pattern',
    summary: 'Splitting large components improves test coverage',
    details: 'Pattern from gen_frontend runs.',
    applicableContext: ['gen_frontend'],
    confidence: 0.7,
    text: 'Splitting large components improves test coverage',
  })
}

function seedConventions(store: ReturnType<typeof createMockStore>): void {
  const ns = store._getNamespaceMap(['conventions'])
  ns.set('conv-1', {
    id: 'conv-1',
    name: 'Use kebab-case for file names',
    description: 'All source files should use kebab-case naming',
    category: 'naming',
    confidence: 0.95,
    text: 'Use kebab-case for file names: All source files should use kebab-case naming',
  })
  ns.set('conv-2', {
    id: 'conv-2',
    name: 'Zod input validation',
    description: 'All API routes must have Zod input validation',
    category: 'api',
    confidence: 0.9,
    text: 'Zod input validation: All API routes must have Zod input validation',
  })
}

function seedErrors(store: ReturnType<typeof createMockStore>): void {
  const ns = store._getNamespaceMap(['errors'])
  ns.set('err-1', {
    id: 'err-1',
    summary: 'gen_frontend often fails on complex state management',
    nodeId: 'gen_frontend',
    errorType: 'RenderError',
    text: 'gen_frontend often fails on complex state management',
  })
  ns.set('err-2', {
    id: 'err-2',
    summary: 'gen_tests timeout when testing database operations',
    nodeId: 'gen_tests',
    errorType: 'TimeoutError',
    text: 'gen_tests timeout when testing database operations',
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryIntegrator', () => {
  let store: ReturnType<typeof createMockStore>
  let integrator: MemoryIntegrator

  beforeEach(() => {
    store = createMockStore()
    integrator = new MemoryIntegrator({ store })
  })

  // ---- prepareContext with data -------------------------------------------

  describe('prepareContext', () => {
    it('should retrieve lessons, conventions, and warnings', async () => {
      seedLessons(store)
      seedConventions(store)
      seedErrors(store)

      const ctx = await integrator.prepareContext({})

      expect(ctx.totalItems).toBe(7) // 3 lessons + 2 conventions + 2 errors
      expect(ctx.lessons).toContain('[90%]')
      expect(ctx.lessons).toContain('validate input with Zod')
      expect(ctx.conventions).toContain('kebab-case')
      expect(ctx.conventions).toContain('Zod input validation')
      expect(ctx.warnings).toContain('gen_frontend')
    })

    it('should filter lessons by nodeId', async () => {
      seedLessons(store)

      const ctx = await integrator.prepareContext({ nodeId: 'gen_backend' })

      expect(ctx.lessons).toContain('validate input with Zod')
      expect(ctx.lessons).not.toContain('gen_db')
      expect(ctx.lessons).not.toContain('gen_frontend')
    })

    it('should filter lessons by errorType', async () => {
      seedLessons(store)

      const ctx = await integrator.prepareContext({ errorType: 'IntegrityError' })

      expect(ctx.lessons).toContain('foreign key constraints')
      expect(ctx.lessons).not.toContain('validate input with Zod')
    })

    it('should filter errors by nodeId', async () => {
      seedErrors(store)

      const ctx = await integrator.prepareContext({ nodeId: 'gen_frontend' })

      expect(ctx.warnings).toContain('gen_frontend')
      expect(ctx.warnings).not.toContain('gen_tests')
    })

    it('should filter errors by errorType', async () => {
      seedErrors(store)

      const ctx = await integrator.prepareContext({ errorType: 'TimeoutError' })

      expect(ctx.warnings).toContain('timeout')
      expect(ctx.warnings).not.toContain('state management')
    })
  })

  // ---- prepareContext with empty store ------------------------------------

  describe('prepareContext with empty store', () => {
    it('should return empty context when store has no data', async () => {
      const ctx = await integrator.prepareContext({})

      expect(ctx.totalItems).toBe(0)
      expect(ctx.lessons).toBe('')
      expect(ctx.conventions).toBe('')
      expect(ctx.warnings).toBe('')
    })

    it('should return empty context when filters match nothing', async () => {
      seedLessons(store)

      const ctx = await integrator.prepareContext({ nodeId: 'nonexistent_node' })

      expect(ctx.lessons).toBe('')
    })
  })

  // ---- formatAsPromptSection ----------------------------------------------

  describe('formatAsPromptSection', () => {
    it('should format a full context as markdown', () => {
      const ctx: MemoryContext = {
        lessons: '- [90%] Always validate input with Zod\n- [85%] Add foreign key constraints',
        conventions: '- Use kebab-case for file names\n- All API routes must have Zod validation',
        warnings: '- gen_frontend: often fails on complex state management',
        totalItems: 5,
      }

      const result = integrator.formatAsPromptSection(ctx)

      expect(result).toContain('## Memory Context')
      expect(result).toContain('### Lessons from Past Runs')
      expect(result).toContain('[90%] Always validate input with Zod')
      expect(result).toContain('### Project Conventions')
      expect(result).toContain('kebab-case')
      expect(result).toContain('### Known Pitfalls')
      expect(result).toContain('gen_frontend')
    })

    it('should return empty string when totalItems is 0', () => {
      const ctx: MemoryContext = {
        lessons: '',
        conventions: '',
        warnings: '',
        totalItems: 0,
      }

      expect(integrator.formatAsPromptSection(ctx)).toBe('')
    })

    it('should omit empty sections', () => {
      const ctx: MemoryContext = {
        lessons: '- [90%] Some lesson',
        conventions: '',
        warnings: '',
        totalItems: 1,
      }

      const result = integrator.formatAsPromptSection(ctx)

      expect(result).toContain('### Lessons from Past Runs')
      expect(result).not.toContain('### Project Conventions')
      expect(result).not.toContain('### Known Pitfalls')
    })

    it('should only show conventions section when only conventions exist', () => {
      const ctx: MemoryContext = {
        lessons: '',
        conventions: '- Use kebab-case',
        warnings: '',
        totalItems: 1,
      }

      const result = integrator.formatAsPromptSection(ctx)

      expect(result).toContain('## Memory Context')
      expect(result).toContain('### Project Conventions')
      expect(result).not.toContain('### Lessons')
      expect(result).not.toContain('### Known Pitfalls')
    })
  })

  // ---- getPromptSection (convenience) -------------------------------------

  describe('getPromptSection', () => {
    it('should combine prepareContext and formatAsPromptSection', async () => {
      seedLessons(store)
      seedConventions(store)
      seedErrors(store)

      const result = await integrator.getPromptSection({ nodeId: 'gen_backend' })

      expect(result).toContain('## Memory Context')
      expect(result).toContain('validate input with Zod')
      expect(result).toContain('### Project Conventions')
    })

    it('should return empty string when no relevant data exists', async () => {
      const result = await integrator.getPromptSection({ nodeId: 'nonexistent' })

      expect(result).toBe('')
    })

    it('should work without any filter params', async () => {
      seedLessons(store)

      const result = await integrator.getPromptSection({})

      expect(result).toContain('## Memory Context')
      expect(result).toContain('### Lessons from Past Runs')
    })
  })

  // ---- Store error handling -----------------------------------------------

  describe('store error handling', () => {
    it('should return empty context when store.search throws', async () => {
      store.search.mockRejectedValue(new Error('Store connection failed'))

      const ctx = await integrator.prepareContext({ nodeId: 'gen_backend' })

      expect(ctx.totalItems).toBe(0)
      expect(ctx.lessons).toBe('')
      expect(ctx.conventions).toBe('')
      expect(ctx.warnings).toBe('')
    })

    it('should handle partial store failures gracefully', async () => {
      // First call (lessons) fails, second (conventions) succeeds, third (errors) succeeds
      let callCount = 0
      store.search.mockImplementation((_ns: string[], _opts?: { limit?: number }) => {
        callCount++
        if (callCount === 1) {
          return Promise.reject(new Error('Lessons namespace unavailable'))
        }
        if (callCount === 2) {
          return Promise.resolve([
            { key: 'conv-1', value: { id: 'conv-1', name: 'Use semicolons', description: 'Always use semicolons' } },
          ])
        }
        return Promise.resolve([])
      })

      const ctx = await integrator.prepareContext({})

      // Should still have conventions even though lessons failed
      expect(ctx.conventions).toContain('Use semicolons')
      expect(ctx.lessons).toBe('')
      expect(ctx.totalItems).toBe(1)
    })
  })

  // ---- Max limits ---------------------------------------------------------

  describe('max limits', () => {
    it('should respect maxLessons config', async () => {
      const limitedIntegrator = new MemoryIntegrator({
        store,
        maxLessons: 1,
      })

      seedLessons(store) // 3 lessons

      const ctx = await limitedIntegrator.prepareContext({})

      // Count bullet points in lessons
      const bulletCount = (ctx.lessons.match(/^- /gm) ?? []).length
      expect(bulletCount).toBe(1)
    })

    it('should respect maxConventions config', async () => {
      const limitedIntegrator = new MemoryIntegrator({
        store,
        maxConventions: 1,
      })

      seedConventions(store) // 2 conventions

      const ctx = await limitedIntegrator.prepareContext({})

      const bulletCount = (ctx.conventions.match(/^- /gm) ?? []).length
      expect(bulletCount).toBe(1)
    })

    it('should respect maxErrors config', async () => {
      const limitedIntegrator = new MemoryIntegrator({
        store,
        maxErrors: 1,
      })

      seedErrors(store) // 2 errors

      const ctx = await limitedIntegrator.prepareContext({})

      const bulletCount = (ctx.warnings.match(/^- /gm) ?? []).length
      expect(bulletCount).toBe(1)
    })
  })

  // ---- Custom namespaces --------------------------------------------------

  describe('custom namespaces', () => {
    it('should use custom namespace prefixes', async () => {
      const customIntegrator = new MemoryIntegrator({
        store,
        lessonsNamespace: ['project', 'lessons'],
        conventionsNamespace: ['project', 'conventions'],
        errorsNamespace: ['project', 'errors'],
      })

      // Seed data in custom namespaces
      const lessonsMap = store._getNamespaceMap(['project', 'lessons'])
      lessonsMap.set('l1', {
        id: 'l1',
        summary: 'Custom namespace lesson',
        confidence: 0.8,
      })

      const ctx = await customIntegrator.prepareContext({})

      expect(ctx.lessons).toContain('Custom namespace lesson')
      expect(ctx.totalItems).toBe(1)
    })
  })

  // ---- Convention _deleted filtering --------------------------------------

  describe('deleted conventions', () => {
    it('should filter out conventions marked as _deleted', async () => {
      const ns = store._getNamespaceMap(['conventions'])
      ns.set('conv-active', {
        id: 'conv-active',
        name: 'Active convention',
        description: 'This should show',
      })
      ns.set('conv-deleted', {
        id: 'conv-deleted',
        name: 'Deleted convention',
        description: 'This should not show',
        _deleted: true,
      })

      const ctx = await integrator.prepareContext({})

      expect(ctx.conventions).toContain('Active convention')
      expect(ctx.conventions).not.toContain('Deleted convention')
    })
  })

  // ---- Formatting edge cases ----------------------------------------------

  describe('formatting edge cases', () => {
    it('should handle lessons without summary field', async () => {
      const ns = store._getNamespaceMap(['lessons'])
      ns.set('l-no-summary', {
        id: 'l-no-summary',
        text: 'A lesson stored as text only',
        confidence: 0.6,
      })

      const ctx = await integrator.prepareContext({})

      expect(ctx.lessons).toContain('[60%]')
      expect(ctx.lessons).toContain('A lesson stored as text only')
    })

    it('should handle conventions without name field', async () => {
      const ns = store._getNamespaceMap(['conventions'])
      ns.set('conv-desc-only', {
        id: 'conv-desc-only',
        description: 'Description only convention',
      })

      const ctx = await integrator.prepareContext({})

      expect(ctx.conventions).toContain('Description only convention')
    })

    it('should handle errors with errorMessage instead of summary', async () => {
      const ns = store._getNamespaceMap(['errors'])
      ns.set('err-msg', {
        id: 'err-msg',
        errorMessage: 'Connection refused on port 5432',
        nodeId: 'gen_db',
      })

      const ctx = await integrator.prepareContext({})

      expect(ctx.warnings).toContain('gen_db: Connection refused on port 5432')
    })

    it('should default confidence to 50% when not present', async () => {
      const ns = store._getNamespaceMap(['lessons'])
      ns.set('l-no-conf', {
        id: 'l-no-conf',
        summary: 'Lesson without confidence',
      })

      const ctx = await integrator.prepareContext({})

      expect(ctx.lessons).toContain('[50%]')
    })
  })
})
