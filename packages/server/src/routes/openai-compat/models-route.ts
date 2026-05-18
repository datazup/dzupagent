/**
 * GET /v1/models — OpenAI-compatible model listing.
 *
 * Returns every registered agent as a ModelObject so that OpenAI-compatible
 * clients can discover available "models" (which are really agents).
 */
import { Hono } from 'hono'
import type { AgentExecutionSpecStore } from '@dzupagent/core/persistence'
import type { ModelListResponse, ModelObject } from './types.js'
import type { AppEnv } from '../../types.js'
import { DEFAULT_TENANT_ID, getOptionalRequestingTenantId } from '../tenant-scope.js'

export interface ModelsRouteConfig {
  agentStore: AgentExecutionSpecStore
}

export function createModelsRoute(config: ModelsRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // GET /v1/models
  app.get('/', async (c) => {
    const requestingTenantId = getOptionalRequestingTenantId(c)
    const agents = await config.agentStore.list(
      requestingTenantId === undefined
        ? { active: true }
        : { active: true, tenantId: requestingTenantId },
    )

    const models: ModelObject[] = agents.map((agent) => ({
      id: agent.id,
      object: 'model' as const,
      created: agent.createdAt
        ? Math.floor(agent.createdAt.getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      owned_by: 'dzupagent',
    }))

    const response: ModelListResponse = {
      object: 'list',
      data: models,
    }

    return c.json(response)
  })

  // GET /v1/models/:model — single model lookup
  app.get('/:model', async (c) => {
    const modelId = c.req.param('model')
    const requestingTenantId = getOptionalRequestingTenantId(c)
    const agent = await config.agentStore.get(modelId)

    const agentTenantId = (agent?.tenantId ?? DEFAULT_TENANT_ID) || DEFAULT_TENANT_ID
    if (!agent || (requestingTenantId !== undefined && agentTenantId !== requestingTenantId)) {
      return c.json(
        {
          error: {
            message: `The model '${modelId}' does not exist`,
            type: 'invalid_request_error',
            param: null,
            code: 'model_not_found',
          },
        },
        404,
      )
    }

    const model: ModelObject = {
      id: agent.id,
      object: 'model',
      created: agent.createdAt
        ? Math.floor(agent.createdAt.getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      owned_by: 'dzupagent',
    }

    return c.json(model)
  })

  return app
}
