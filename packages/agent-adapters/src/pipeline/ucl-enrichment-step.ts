/**
 * UCLEnrichmentStep — extracted from OrchestratorFacade.
 *
 * Loads skills and memory from `.dzupagent/` (Unified Capability Layer) and
 * injects them into an AgentInput before adapter execution. Failures are
 * best-effort — a broken skill file should never block a run.
 */

import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import { WorkspaceResolver } from '../dzupagent/workspace-resolver.js'
import { loadDzupAgentConfig } from '../dzupagent/config.js'
import { EnrichmentPipeline } from '../enrichment/enrichment-pipeline.js'
import type {
  AdapterProviderId,
  AgentInput,
  DzupAgentPaths,
} from '../types.js'

export interface UCLEnrichmentConfig {
  /** Project root for .dzupagent/ resolution. Defaults to process.cwd() */
  projectRoot?: string | undefined
  /** Skip memory injection entirely */
  skipMemory?: boolean | undefined
  /** Skip skill injection entirely */
  skipSkills?: boolean | undefined
}

export class UCLEnrichmentStep {
  /** Cached resolved paths — lazily populated on first apply() call. */
  private _resolvedPaths: DzupAgentPaths | undefined

  constructor(
    private readonly _registry: ProviderAdapterRegistry,
    private readonly _eventBus: DzupEventBus,
    private readonly _config: UCLEnrichmentConfig | undefined,
  ) {}

  /** True when UCL enrichment is configured. */
  get enabled(): boolean {
    return this._config !== undefined
  }

  /**
   * Resolve `.dzupagent/` paths once and cache the result.
   * Public so callers (e.g. tests) can prime the cache.
   */
  async resolvePaths(): Promise<DzupAgentPaths> {
    if (this._resolvedPaths) return this._resolvedPaths
    const projectRoot = this._config?.projectRoot ?? process.cwd()
    const resolver = new WorkspaceResolver()
    this._resolvedPaths = await resolver.resolve(projectRoot)
    return this._resolvedPaths
  }

  /**
   * Apply Unified Capability Layer enrichment to an AgentInput. No-op when
   * UCL is not configured. Failures are best-effort: a broken skill file
   * never blocks the run.
   */
  async apply(input: AgentInput): Promise<void> {
    const cfg = this._config
    if (!cfg) return

    const paths = await this.resolvePaths()
    const dzupConfig = await loadDzupAgentConfig(paths)
    const providerId =
      this._registry.listAdapters()[0] ?? ('claude' as AdapterProviderId)

    await EnrichmentPipeline.apply(input, {
      paths,
      dzupConfig,
      providerId,
      skipSkills: cfg.skipSkills,
      skipMemory: cfg.skipMemory,
      // Adapter-layer events are emitted directly on the bus (not via the
      // bridge). Cast required because these events are not part of the
      // core DzupEvent union.
      emitEvent: (event) => this._eventBus.emit(event as unknown as DzupEvent),
    })
  }
}
