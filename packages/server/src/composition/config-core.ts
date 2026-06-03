/**
 * Core wiring slice of {@link ForgeServerConfig}: required stores, the optional
 * registry control plane, the shared event bus, and the model registry.
 *
 * Split out of `composition/types.ts` so composition helpers can ask for the
 * narrow core slice without importing the full aggregate. Re-exported from
 * `composition/types.ts` to preserve every existing import path.
 */
import type { AgentRegistry } from "@dzupagent/core/pipeline";
import type {
  AgentExecutionSpecStore,
  RunStore,
} from "@dzupagent/core/persistence";
import type { ModelRegistry } from "@dzupagent/core/llm";
import type { DzupEventBus } from "@dzupagent/core/events";

import type { ExecutableAgentResolver } from "../services/executable-agent-resolver.js";

/**
 * Required core wiring: stores, registry, and the shared event bus.
 *
 * @deprecated Internal composition building block for {@link ForgeServerConfig}
 * and {@link ForgeHostRuntimeConfig}. The standalone re-export through
 * `@dzupagent/server/app` is a legacy compatibility alias with zero workspace
 * consumers and is not part of the package-root public surface. Prefer the
 * aggregate `ForgeServerConfig` or `ForgeHostRuntimeConfig` types.
 */
export interface ForgeCoreConfig {
  runStore: RunStore;
  agentStore: AgentExecutionSpecStore;
  /** Optional registry control plane for registry-backed management and execution projection. */
  registry?: AgentRegistry;
  /** Optional boundary that resolves a runnable execution spec for a run or compatibility API. */
  executableAgentResolver?: ExecutableAgentResolver;
  eventBus: DzupEventBus;
  modelRegistry: ModelRegistry;
}
