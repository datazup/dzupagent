/**
 * Mounts the always-on REST surface: health, runs, agents, approvals,
 * human-contact, enrichment metrics, and (when configured) registry +
 * api-key routes. These are the routes that the legacy `app.ts` mounted
 * unconditionally before any optional integrations were considered.
 */
import type { Hono } from 'hono'

import type { ForgeServerConfig } from './types.js'
import { createHealthRoutes } from '../routes/health.js'
import { createRoutingStatsRoutes } from '../routes/routing-stats.js'
import { createRunRoutes } from '../routes/runs.js'
import { createRunContextRoutes } from '../routes/run-context.js'
import { createAgentDefinitionRoutes } from '../routes/agents.js'
import { createApprovalRoutes } from '../routes/approval.js'
import { createApprovalsRoutes } from '../routes/approvals.js'
import { createHumanContactRoutes } from '../routes/human-contact.js'
import { createEnrichmentMetricsRoute } from '../routes/enrichment-metrics.js'
import { createRunTraceRoutes } from '../routes/run-trace.js'
import { createRegistryRoutes } from '../routes/registry.js'
import { createApiKeyRoutes } from '../routes/api-keys.js'

export function mountCoreRoutes(app: Hono, runtimeConfig: ForgeServerConfig): void {
  app.route('/api/health', createHealthRoutes(runtimeConfig))
  app.route('/api/health', createRoutingStatsRoutes({ runStore: runtimeConfig.runStore }))
  app.route('/api/runs', createRunRoutes(runtimeConfig))
  app.route('/api/runs', createRunContextRoutes(runtimeConfig))
  app.route('/api/agent-definitions', createAgentDefinitionRoutes(runtimeConfig))
  app.route('/api/agents', createAgentDefinitionRoutes(runtimeConfig))

  if (runtimeConfig.registry) {
    app.route('/api/registry', createRegistryRoutes({ registry: runtimeConfig.registry }))
  }

  if (runtimeConfig.apiKeyStore) {
    const allowedTiers = runtimeConfig.rateLimit?.tiers
      ? Object.keys(runtimeConfig.rateLimit.tiers)
      : undefined
    app.route('/api/keys', createApiKeyRoutes({ store: runtimeConfig.apiKeyStore, allowedTiers }))
  }

  app.route('/api/runs', createApprovalRoutes(runtimeConfig))

  if (runtimeConfig.approvalStore) {
    app.route(
      '/api/approvals',
      createApprovalsRoutes({
        approvalStore: runtimeConfig.approvalStore,
        eventBus: runtimeConfig.eventBus,
      }),
    )
  }

  app.route('/api/runs', createHumanContactRoutes(runtimeConfig))
  app.route('/api/runs', createEnrichmentMetricsRoute({ runStore: runtimeConfig.runStore }))

  if (runtimeConfig.traceStore) {
    app.route('/api/runs', createRunTraceRoutes({
      runStore: runtimeConfig.runStore,
      traceStore: runtimeConfig.traceStore,
    }))
  }
}
