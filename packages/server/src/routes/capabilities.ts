/**
 * Skill capability matrix routes (UCL FR-6).
 *
 * GET /:skillId — Returns a SkillCapabilityMatrix describing per-provider
 * capability coverage for the given skill bundle. The matrix is built on
 * demand from the configured AdapterSkillRegistry.
 */
import { Hono } from 'hono'
import type { AdapterSkillRegistry } from '@dzupagent/agent-adapters'
import { SkillCapabilityMatrixBuilder } from '@dzupagent/agent-adapters'

export interface CapabilityRouteConfig {
  skillRegistry: AdapterSkillRegistry
}

export function createCapabilityRoutes(config: CapabilityRouteConfig): Hono {
  const app = new Hono()

  app.get('/:skillId', (c) => {
    const skillId = c.req.param('skillId')
    const bundle = config.skillRegistry.getBundle(skillId)
    if (!bundle) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `Skill '${skillId}' not found` } },
        404,
      )
    }
    const builder = new SkillCapabilityMatrixBuilder(config.skillRegistry)
    const matrix = builder.buildForSkill(bundle)
    return c.json({ data: matrix })
  })

  return app
}
