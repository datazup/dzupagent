import { describe, it, expect, beforeEach } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import {
  AdaptivePromptEnricher,
  type EnricherConfig,
} from '../self-correction/adaptive-prompt-enricher.js'

// ---------------------------------------------------------------------------
// In-memory BaseStore mock
// ---------------------------------------------------------------------------

function createMemoryStore(): BaseStore {
  const data = new Map<string, Map<string, { key: string; value: Record<string, unknown> }>>()

  function nsKey(namespace: string[]): string {
    return namespace.join('/')
  }

  return {
    async get(namespace: string[], key: string) {
      const ns = data.get(nsKey(namespace))
      return ns?.get(key) ?? null
    },
    async put(namespace: string[], key: string, value: Record<string, unknown>) {
      const k = nsKey(namespace)
      if (!data.has(k)) data.set(k, new Map())
      data.get(k)!.set(key, { key, value })
    },
    async delete(namespace: string[], key: string) {
      const ns = data.get(nsKey(namespace))
      if (ns) ns.delete(key)
    },
    async search(namespace: string[], _options?: { limit?: number; filter?: Record<string, unknown> }) {
      const ns = data.get(nsKey(namespace))
      if (!ns) return []
      return Array.from(ns.values())
    },
    async batch(_ops: unknown[]) { return [] },
    async list(_prefix: string[]) { return [] },
    async start() { /* noop */ },
    async stop() { /* noop */ },
  } as unknown as BaseStore
}

// ---------------------------------------------------------------------------
// Helpers — seed store with test data
// ---------------------------------------------------------------------------

async function seedRules(store: BaseStore, rules: Array<{ key: string; text: string; scope?: string | string[]; taskType?: string }>) {
  for (const rule of rules) {
    await store.put(['rules'], rule.key, {
      text: rule.text,
      scope: rule.scope ?? '*',
      ...(rule.taskType ? { taskType: rule.taskType } : {}),
    })
  }
}

async function seedErrors(store: BaseStore, errors: Array<{ key: string; text: string; nodeId: string }>) {
  for (const error of errors) {
    await store.put(['errors'], error.key, {
      text: error.text,
      nodeId: error.nodeId,
    })
  }
}

async function seedLessons(store: BaseStore, lessons: Array<{ key: string; text: string; nodeId?: string; taskType?: string; confidence?: number }>) {
  for (const lesson of lessons) {
    await store.put(['lessons'], lesson.key, {
      text: lesson.text,
      ...(lesson.nodeId ? { nodeId: lesson.nodeId } : {}),
      ...(lesson.taskType ? { taskType: lesson.taskType } : {}),
      ...(lesson.confidence !== undefined ? { confidence: lesson.confidence } : {}),
    })
  }
}

async function seedTrajectorySteps(store: BaseStore, nodeId: string, scores: number[]) {
  for (let i = 0; i < scores.length; i++) {
    await store.put(['trajectories', 'steps', nodeId], `step_${i}`, {
      qualityScore: scores[i],
      nodeId,
      runId: `run_${i}`,
      timestamp: new Date().toISOString(),
    })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdaptivePromptEnricher', () => {
  let store: BaseStore
  let enricher: AdaptivePromptEnricher

  beforeEach(() => {
    store = createMemoryStore()
    enricher = new AdaptivePromptEnricher({ store })
  })

  // -----------------------------------------------------------------------
  // Basic enrichment with all sources
  // -----------------------------------------------------------------------

  it('should enrich with all sources available', async () => {
    await seedRules(store, [
      { key: 'r1', text: 'Always include Zod validation for payment features', scope: 'gen_backend' },
    ])
    await seedErrors(store, [
      { key: 'e1', text: 'Import resolution errors — ensure all imports use .js extension', nodeId: 'gen_backend' },
    ])
    await seedLessons(store, [
      { key: 'l1', text: 'Complex state management works better with Pinia composables', nodeId: 'gen_backend', confidence: 0.9 },
    ])
    await seedTrajectorySteps(store, 'gen_backend', [0.8, 0.85, 0.82])

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    expect(result.itemCount).toBe(4)
    expect(result.sources).toEqual(['rules', 'errors', 'lessons', 'trajectories'])
    expect(result.content).toContain('## Generation Context (from past runs)')
    expect(result.content).toContain('### Rules (must follow)')
    expect(result.content).toContain('Always include Zod validation')
    expect(result.content).toContain('### Warnings (avoid past mistakes)')
    expect(result.content).toContain('Import resolution errors')
    expect(result.content).toContain('### Lessons (guidance)')
    expect(result.content).toContain('[90%] Complex state management')
    expect(result.content).toContain('### Quality Expectations')
    expect(result.content).toContain('Historical average score')
    expect(result.estimatedTokens).toBeGreaterThan(0)
  })

  // -----------------------------------------------------------------------
  // Empty store
  // -----------------------------------------------------------------------

  it('should return empty enrichment with empty store', async () => {
    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    expect(result.content).toBe('')
    expect(result.itemCount).toBe(0)
    expect(result.sources).toEqual([])
    expect(result.estimatedTokens).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Token budget truncation
  // -----------------------------------------------------------------------

  it('should truncate content to respect token budget', async () => {
    // Seed a large number of lessons to exceed a small budget
    const bigLessons = Array.from({ length: 20 }, (_, i) => ({
      key: `l${i}`,
      text: `Lesson ${i}: ${'x'.repeat(100)}`,
      nodeId: 'gen_backend',
    }))
    await seedLessons(store, bigLessons)

    const result = await enricher.enrichWithBudget({
      nodeId: 'gen_backend',
      tokenBudget: 50,
    })

    // 50 tokens = ~200 chars
    expect(result.content.length).toBeLessThanOrEqual(200)
    expect(result.estimatedTokens).toBeLessThanOrEqual(50)
  })

  // -----------------------------------------------------------------------
  // Priority ordering (rules before lessons)
  // -----------------------------------------------------------------------

  it('should order sections: rules > warnings > lessons > baselines', async () => {
    await seedRules(store, [
      { key: 'r1', text: 'Rule text', scope: '*' },
    ])
    await seedErrors(store, [
      { key: 'e1', text: 'Error text', nodeId: 'gen_backend' },
    ])
    await seedLessons(store, [
      { key: 'l1', text: 'Lesson text', nodeId: 'gen_backend' },
    ])
    await seedTrajectorySteps(store, 'gen_backend', [0.8])

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    const rulesIdx = result.content.indexOf('### Rules')
    const warningsIdx = result.content.indexOf('### Warnings')
    const lessonsIdx = result.content.indexOf('### Lessons')
    const baselinesIdx = result.content.indexOf('### Quality Expectations')

    expect(rulesIdx).toBeLessThan(warningsIdx)
    expect(warningsIdx).toBeLessThan(lessonsIdx)
    expect(lessonsIdx).toBeLessThan(baselinesIdx)
  })

  // -----------------------------------------------------------------------
  // Filter by nodeId
  // -----------------------------------------------------------------------

  it('should filter errors by nodeId', async () => {
    await seedErrors(store, [
      { key: 'e1', text: 'Error for backend', nodeId: 'gen_backend' },
      { key: 'e2', text: 'Error for frontend', nodeId: 'gen_frontend' },
    ])

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    expect(result.content).toContain('Error for backend')
    expect(result.content).not.toContain('Error for frontend')
  })

  it('should filter lessons by nodeId', async () => {
    await seedLessons(store, [
      { key: 'l1', text: 'Backend lesson', nodeId: 'gen_backend' },
      { key: 'l2', text: 'Frontend lesson', nodeId: 'gen_frontend' },
    ])

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    expect(result.content).toContain('Backend lesson')
    expect(result.content).not.toContain('Frontend lesson')
  })

  it('should filter rules by scope containing nodeId', async () => {
    await seedRules(store, [
      { key: 'r1', text: 'Global rule', scope: '*' },
      { key: 'r2', text: 'Backend rule', scope: 'gen_backend' },
      { key: 'r3', text: 'Frontend rule', scope: 'gen_frontend' },
    ])

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    expect(result.content).toContain('Global rule')
    expect(result.content).toContain('Backend rule')
    expect(result.content).not.toContain('Frontend rule')
  })

  it('should filter rules by array scope', async () => {
    await seedRules(store, [
      { key: 'r1', text: 'Multi-scope rule', scope: ['gen_backend', 'gen_db'] },
      { key: 'r2', text: 'Other scope rule', scope: ['gen_frontend', 'gen_tests'] },
    ])

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    expect(result.content).toContain('Multi-scope rule')
    expect(result.content).not.toContain('Other scope rule')
  })

  // -----------------------------------------------------------------------
  // Filter by taskType
  // -----------------------------------------------------------------------

  it('should filter lessons by taskType', async () => {
    await seedLessons(store, [
      { key: 'l1', text: 'Feature gen lesson', nodeId: 'gen_backend', taskType: 'feature_gen' },
      { key: 'l2', text: 'Bug fix lesson', nodeId: 'gen_backend', taskType: 'bug_fix' },
      { key: 'l3', text: 'Untyped lesson', nodeId: 'gen_backend' },
    ])

    const result = await enricher.enrich({ nodeId: 'gen_backend', taskType: 'feature_gen' })

    expect(result.content).toContain('Feature gen lesson')
    expect(result.content).not.toContain('Bug fix lesson')
    expect(result.content).toContain('Untyped lesson') // no taskType => included
  })

  // -----------------------------------------------------------------------
  // Sources tracking
  // -----------------------------------------------------------------------

  it('should track which sources contributed', async () => {
    await seedLessons(store, [
      { key: 'l1', text: 'A lesson', nodeId: 'gen_backend' },
    ])
    await seedErrors(store, [
      { key: 'e1', text: 'An error', nodeId: 'gen_backend' },
    ])

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    // Only errors and lessons have data — rules and trajectories are empty
    expect(result.sources).toContain('errors')
    expect(result.sources).toContain('lessons')
    expect(result.sources).not.toContain('rules')
    expect(result.sources).not.toContain('trajectories')
  })

  // -----------------------------------------------------------------------
  // Custom namespaces
  // -----------------------------------------------------------------------

  it('should respect custom namespaces', async () => {
    const customStore = createMemoryStore()
    const customEnricher = new AdaptivePromptEnricher({
      store: customStore,
      namespaces: {
        lessons: ['custom', 'lessons'],
        rules: ['custom', 'rules'],
        errors: ['custom', 'errors'],
        trajectories: ['custom', 'trajectories'],
      },
    })

    // Seed into custom namespaces
    await customStore.put(['custom', 'rules'], 'r1', {
      text: 'Custom namespace rule',
      scope: '*',
    })

    const result = await customEnricher.enrich({ nodeId: 'gen_backend' })

    expect(result.content).toContain('Custom namespace rule')
    expect(result.itemCount).toBe(1)
  })

  // -----------------------------------------------------------------------
  // maxItemsPerSource limiting
  // -----------------------------------------------------------------------

  it('should limit items per source', async () => {
    const limitedEnricher = new AdaptivePromptEnricher({
      store,
      maxItemsPerSource: 2,
    })

    await seedLessons(store, [
      { key: 'l1', text: 'Lesson 1', nodeId: 'gen_backend' },
      { key: 'l2', text: 'Lesson 2', nodeId: 'gen_backend' },
      { key: 'l3', text: 'Lesson 3', nodeId: 'gen_backend' },
      { key: 'l4', text: 'Lesson 4', nodeId: 'gen_backend' },
      { key: 'l5', text: 'Lesson 5', nodeId: 'gen_backend' },
    ])

    const result = await limitedEnricher.enrich({ nodeId: 'gen_backend' })

    // Should only include 2 lessons (maxItemsPerSource)
    expect(result.itemCount).toBe(2)
  })

  // -----------------------------------------------------------------------
  // Baseline computation
  // -----------------------------------------------------------------------

  it('should compute average baseline from trajectory steps', async () => {
    await seedTrajectorySteps(store, 'gen_backend', [0.8, 0.9, 0.7])

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    expect(result.content).toContain('Historical average score for this node: 0.80/1.0')
  })

  // -----------------------------------------------------------------------
  // Confidence display
  // -----------------------------------------------------------------------

  it('should display confidence percentage for lessons', async () => {
    await seedLessons(store, [
      { key: 'l1', text: 'High confidence lesson', nodeId: 'gen_backend', confidence: 0.95 },
      { key: 'l2', text: 'No confidence lesson', nodeId: 'gen_backend' },
    ])

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    expect(result.content).toContain('[95%] High confidence lesson')
    expect(result.content).toContain('- No confidence lesson')
    expect(result.content).not.toContain('[NaN%]')
  })

  // -----------------------------------------------------------------------
  // enrichWithBudget uses explicit budget
  // -----------------------------------------------------------------------

  it('should use explicit token budget in enrichWithBudget', async () => {
    await seedRules(store, [
      { key: 'r1', text: 'A rule that is somewhat long and verbose', scope: '*' },
    ])
    await seedLessons(store, Array.from({ length: 10 }, (_, i) => ({
      key: `l${i}`,
      text: `Lesson ${i}: ${'y'.repeat(200)}`,
      nodeId: 'gen_backend',
    })))

    const small = await enricher.enrichWithBudget({
      nodeId: 'gen_backend',
      tokenBudget: 30,
    })
    const large = await enricher.enrichWithBudget({
      nodeId: 'gen_backend',
      tokenBudget: 5000,
    })

    expect(small.estimatedTokens).toBeLessThanOrEqual(30)
    expect(large.estimatedTokens).toBeGreaterThan(small.estimatedTokens)
  })

  // -----------------------------------------------------------------------
  // Lessons without nodeId are included (global lessons)
  // -----------------------------------------------------------------------

  it('should include lessons without nodeId as global lessons', async () => {
    await seedLessons(store, [
      { key: 'l1', text: 'Global lesson applies everywhere' },
    ])

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    expect(result.content).toContain('Global lesson applies everywhere')
  })

  // -----------------------------------------------------------------------
  // Fallback text fields (summary, content, rule, message)
  // -----------------------------------------------------------------------

  it('should read fallback text fields from store items', async () => {
    // Rule using 'rule' field
    await store.put(['rules'], 'r1', { rule: 'Rule via rule field', scope: '*' })
    // Error using 'summary' field
    await store.put(['errors'], 'e1', { summary: 'Error via summary field', nodeId: 'gen_backend' })
    // Lesson using 'content' field
    await store.put(['lessons'], 'l1', { content: 'Lesson via content field', nodeId: 'gen_backend' })

    const result = await enricher.enrich({ nodeId: 'gen_backend' })

    expect(result.content).toContain('Rule via rule field')
    expect(result.content).toContain('Error via summary field')
    expect(result.content).toContain('Lesson via content field')
  })
})
