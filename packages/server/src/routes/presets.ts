/**
 * Preset HTTP routes — list, get, and build config from presets.
 *
 * Presets are read-only agent templates registered via PresetRegistry.
 * The POST /:name/config endpoint builds a PresetConfig for inspection
 * without actually creating an agent.
 */
import { Hono } from 'hono'
import type { PresetRegistry } from '@dzupagent/agent'
import { buildConfigFromPreset } from '@dzupagent/agent'
import type { PresetRuntimeDeps } from '@dzupagent/agent'

export interface PresetRouteConfig {
  presetRegistry: PresetRegistry
}

export function createPresetRoutes(config: PresetRouteConfig): Hono {
  const app = new Hono()

  // --- List all presets ---
  app.get('/', (c) => {
    const presets = config.presetRegistry.list().map((p) => ({
      name: p.name,
      description: p.description,
      toolNames: p.toolNames,
      guardrails: p.guardrails,
      memoryProfile: p.memoryProfile,
      selfCorrection: p.selfCorrection,
      defaultModelTier: p.defaultModelTier,
    }))
    return c.json({ presets })
  })

  // --- Get single preset by name ---
  app.get('/:name', (c) => {
    const preset = config.presetRegistry.get(c.req.param('name'))
    if (!preset) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Preset not found' } },
        404,
      )
    }
    return c.json(preset)
  })

  // --- Build config from preset (preview, no agent created) ---
  app.post('/:name/config', async (c) => {
    const preset = config.presetRegistry.get(c.req.param('name'))
    if (!preset) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Preset not found' } },
        404,
      )
    }

    const body = await c.req.json<{
      overrides?: PresetRuntimeDeps['overrides']
    }>().catch(() => ({} as { overrides?: PresetRuntimeDeps['overrides'] }))

    const deps: PresetRuntimeDeps = {
      model: { id: 'preview', name: 'preview-model' },
      overrides: body.overrides,
    }

    const presetConfig = buildConfigFromPreset(preset, deps)
    return c.json(presetConfig)
  })

  return app
}
