/**
 * Builds the "runtime-augmented" config object used internally by every
 * route mount. Centralises:
 *  - Default run executor wiring (DzupAgent + fallback)
 *  - Default executable agent resolver (control-plane backed)
 *  - Default event gateway (in-memory bridge)
 *
 * Returns the populated config plus any singletons that other helpers
 * need direct access to (notably the EventGateway for SSE/WS routes).
 */
import type { ForgeServerConfig } from './types.js'
import { InMemoryEventGateway, type EventGateway } from '../events/event-gateway.js'
import { createDefaultRunExecutor } from '../runtime/default-run-executor.js'
import { createDzupAgentRunExecutor } from '../runtime/dzip-agent-run-executor.js'
import { AgentControlPlaneService } from '../services/agent-control-plane-service.js'
import {
  ControlPlaneExecutableAgentResolver,
} from '../services/executable-agent-resolver.js'
import type { RunExecutor } from '../runtime/run-worker.js'

export interface RuntimeBootstrap {
  /** Config with defaults populated for executor, resolver. */
  runtimeConfig: ForgeServerConfig
  /** Effective run executor (defaulted when caller did not provide one). */
  effectiveRunExecutor: RunExecutor
  /** Event gateway used by SSE/WS routes (defaulted to in-memory bridge). */
  eventGateway: EventGateway
}

export function buildRuntimeBootstrap(config: ForgeServerConfig): RuntimeBootstrap {
  const eventGateway = config.eventGateway ?? new InMemoryEventGateway(config.eventBus)

  const fallbackRunExecutor = createDefaultRunExecutor(config.modelRegistry)
  const effectiveRunExecutor =
    config.runExecutor ?? createDzupAgentRunExecutor({ fallback: fallbackRunExecutor })

  const controlPlaneService = new AgentControlPlaneService({
    agentStore: config.agentStore,
    registry: config.registry,
  })

  const runtimeConfig: ForgeServerConfig = {
    ...config,
    executableAgentResolver:
      config.executableAgentResolver ?? new ControlPlaneExecutableAgentResolver(controlPlaneService),
    runExecutor: effectiveRunExecutor,
  }

  return { runtimeConfig, effectiveRunExecutor, eventGateway }
}
