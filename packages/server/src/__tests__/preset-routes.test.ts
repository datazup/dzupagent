/**
 * Tests for preset HTTP routes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createPresetRoutes } from '../routes/presets.js'
import {
  PresetRegistry,
  createDefaultPresetRegistry,
  BUILT_IN_PRESETS,
} from '@dzupagent/agent'
import type { AgentPreset } from '@dzupagent/agent'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(registry?: PresetRegistry) {
  const presetRegistry = registry ?? new PresetRegistry()
  const routes = createPresetRoutes({ presetRegistry })
  const app = new Hono()
  app.route('/api/presets', routes)
  return { app, presetRegistry }
}

function createAppWithDefaults() {
  return createTestApp(createDefaultPresetRegistry())
}

const CUSTOM_PRESET: AgentPreset = {
  name: 'custom-test',
  description: 'A custom test preset',
  instructions: 'You are a test agent.',
  toolNames: ['tool_a', 'tool_b'],
  guardrails: {
    maxIterations: 10,
    maxCostCents: 50,
    maxTokens: 50_000,
  },
  memoryProfile: 'balanced',
  selfCorrection: {
    enabled: true,
    reflectionThreshold: 0.8,
    maxReflectionIterations: 2,
  },
  defaultModelTier: 'reasoning',
}

// ---------------------------------------------------------------------------
// GET /api/presets
// ---------------------------------------------------------------------------

describe('GET /api/presets', () => {
  it('returns empty array when registry has no presets', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/presets')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ presets: [] })
  })

  it('returns list of preset summaries with built-in presets', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { presets: unknown[] }
    expect(body.presets).toHaveLength(BUILT_IN_PRESETS.length)
  })

  it('returns correct summary fields for each preset', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets')
    const body = (await res.json()) as { presets: Record<string, unknown>[] }

    for (const summary of body.presets) {
      expect(summary).toHaveProperty('name')
      expect(summary).toHaveProperty('description')
      expect(summary).toHaveProperty('toolNames')
      expect(summary).toHaveProperty('guardrails')
      expect(summary).toHaveProperty('memoryProfile')
    }
  })

  it('does not include instructions in the summary list', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets')
    const body = (await res.json()) as { presets: Record<string, unknown>[] }

    for (const summary of body.presets) {
      expect(summary).not.toHaveProperty('instructions')
    }
  })

  it('returns a single custom preset', async () => {
    const registry = new PresetRegistry()
    registry.register(CUSTOM_PRESET)
    const { app } = createTestApp(registry)

    const res = await app.request('/api/presets')
    const body = (await res.json()) as { presets: Record<string, unknown>[] }
    expect(body.presets).toHaveLength(1)
    expect(body.presets[0]!.name).toBe('custom-test')
  })

  it('includes selfCorrection in summary when present', async () => {
    const registry = new PresetRegistry()
    registry.register(CUSTOM_PRESET)
    const { app } = createTestApp(registry)

    const res = await app.request('/api/presets')
    const body = (await res.json()) as { presets: Record<string, unknown>[] }
    expect(body.presets[0]!.selfCorrection).toEqual({
      enabled: true,
      reflectionThreshold: 0.8,
      maxReflectionIterations: 2,
    })
  })

  it('includes defaultModelTier in summary when present', async () => {
    const registry = new PresetRegistry()
    registry.register(CUSTOM_PRESET)
    const { app } = createTestApp(registry)

    const res = await app.request('/api/presets')
    const body = (await res.json()) as { presets: Record<string, unknown>[] }
    expect(body.presets[0]!.defaultModelTier).toBe('reasoning')
  })

  it('returns multiple presets when several are registered', async () => {
    const registry = new PresetRegistry()
    registry.register(CUSTOM_PRESET)
    registry.register({ ...CUSTOM_PRESET, name: 'second-preset', description: 'Another' })
    const { app } = createTestApp(registry)

    const res = await app.request('/api/presets')
    const body = (await res.json()) as { presets: Record<string, unknown>[] }
    expect(body.presets).toHaveLength(2)
    const names = body.presets.map((p) => p.name)
    expect(names).toContain('custom-test')
    expect(names).toContain('second-preset')
  })
})

// ---------------------------------------------------------------------------
// GET /api/presets/:name
// ---------------------------------------------------------------------------

describe('GET /api/presets/:name', () => {
  it('returns preset details for a known preset', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/rag-chat')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('rag-chat')
    expect(body.description).toBe('Conversational retrieval with citations')
  })

  it('returns full preset with instructions', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/rag-chat')
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toHaveProperty('instructions')
    expect(typeof body.instructions).toBe('string')
    expect((body.instructions as string).length).toBeGreaterThan(0)
  })

  it('returns 404 for unknown preset name', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/nonexistent')
    expect(res.status).toBe(404)
  })

  it('returns NOT_FOUND error code for unknown preset', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/nonexistent')
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Preset not found')
  })

  it('returns toolNames for known preset', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/research')
    const body = (await res.json()) as { toolNames: string[] }
    expect(body.toolNames).toContain('web_search')
    expect(body.toolNames).toContain('rag_query')
  })

  it('returns guardrails for known preset', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/research')
    const body = (await res.json()) as { guardrails: Record<string, unknown> }
    expect(body.guardrails.maxIterations).toBe(20)
    expect(body.guardrails.maxCostCents).toBe(100)
    expect(body.guardrails.maxTokens).toBe(100_000)
  })

  it('returns selfCorrection for research preset', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/research')
    const body = (await res.json()) as { selfCorrection: Record<string, unknown> }
    expect(body.selfCorrection).toBeDefined()
    expect(body.selfCorrection.enabled).toBe(true)
  })

  it('returns custom preset detail', async () => {
    const registry = new PresetRegistry()
    registry.register(CUSTOM_PRESET)
    const { app } = createTestApp(registry)

    const res = await app.request('/api/presets/custom-test')
    expect(res.status).toBe(200)
    const body = (await res.json()) as AgentPreset
    expect(body.name).toBe('custom-test')
    expect(body.instructions).toBe('You are a test agent.')
    expect(body.toolNames).toEqual(['tool_a', 'tool_b'])
  })
})

// ---------------------------------------------------------------------------
// POST /api/presets/:name/config
// ---------------------------------------------------------------------------

describe('POST /api/presets/:name/config', () => {
  it('returns built config for known preset', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/rag-chat/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('rag-chat')
    expect(body).toHaveProperty('instructions')
    expect(body).toHaveProperty('guardrails')
    expect(body).toHaveProperty('model')
  })

  it('returns 404 for unknown preset', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/nonexistent/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  it('returns NOT_FOUND error code for unknown preset config', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/nonexistent/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('config includes preset id starting with preset-', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/rag-chat/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = (await res.json()) as { id: string }
    expect(body.id).toMatch(/^preset-rag-chat-/)
  })

  it('config applies instruction overrides', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/rag-chat/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: { instructions: 'Custom instructions.' },
      }),
    })
    const body = (await res.json()) as { instructions: string }
    expect(body.instructions).toBe('Custom instructions.')
  })

  it('config applies guardrail overrides', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/rag-chat/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: { guardrails: { maxIterations: 99 } },
      }),
    })
    const body = (await res.json()) as { guardrails: { maxIterations: number } }
    expect(body.guardrails.maxIterations).toBe(99)
  })

  it('config applies memoryProfile override', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/rag-chat/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: { memoryProfile: 'memory-heavy' },
      }),
    })
    const body = (await res.json()) as { memoryProfile: string }
    expect(body.memoryProfile).toBe('memory-heavy')
  })

  it('config includes defaultModelTier from preset', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/research/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = (await res.json()) as { defaultModelTier: string }
    expect(body.defaultModelTier).toBe('reasoning')
  })

  it('config includes selfLearning for research preset', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/research/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = (await res.json()) as { selfLearning: { enabled: boolean } }
    expect(body.selfLearning).toBeDefined()
    expect(body.selfLearning.enabled).toBe(true)
  })

  it('config applies selfLearning override', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/research/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: { selfLearning: { enabled: false, maxIterations: 1 } },
      }),
    })
    const body = (await res.json()) as { selfLearning: { enabled: boolean; maxIterations: number } }
    expect(body.selfLearning.enabled).toBe(false)
    expect(body.selfLearning.maxIterations).toBe(1)
  })

  it('handles empty body gracefully', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/rag-chat/config', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string }
    expect(body.name).toBe('rag-chat')
  })

  it('config uses preview model placeholder', async () => {
    const { app } = createAppWithDefaults()
    const res = await app.request('/api/presets/rag-chat/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = (await res.json()) as { model: { id: string } }
    expect(body.model).toEqual({ id: 'preview', name: 'preview-model' })
  })
})

// ---------------------------------------------------------------------------
// 503 when no registry (app-level integration test)
// ---------------------------------------------------------------------------

describe('Preset routes not mounted when registry absent', () => {
  it('returns 404 on /api/presets when no presetRegistry configured', async () => {
    // Create a bare Hono app without preset routes — simulates no registry in ForgeServerConfig
    const app = new Hono()
    const res = await app.request('/api/presets')
    expect(res.status).toBe(404)
  })

  it('returns 404 on /api/presets/:name when no presetRegistry configured', async () => {
    const app = new Hono()
    const res = await app.request('/api/presets/rag-chat')
    expect(res.status).toBe(404)
  })

  it('returns 404 on POST /api/presets/:name/config when no presetRegistry configured', async () => {
    const app = new Hono()
    const res = await app.request('/api/presets/rag-chat/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })
})
