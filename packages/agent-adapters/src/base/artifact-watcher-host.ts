import { buildDefaultWatcherRegistrations } from '@dzupagent/adapter-rules'

import type { AdapterMonitorStatus, AdapterProviderId, AgentInput } from '../types.js'
import { getDefaultMonitorStatus, getProviderCapabilities } from '../provider-catalog.js'
import {
  getAdapterRuleRuntimePlan,
  resolveAdapterWatchPath,
  resolveRuntimePlanWatcherPaths,
} from '../rules.js'

/**
 * Compute the deduplicated absolute watch paths for a run, combining
 * provider defaults from `@dzupagent/adapter-rules` with any runtime-plan
 * watcher paths declared on the input.
 */
export function resolveWatcherPaths(
  providerId: AdapterProviderId,
  input: AgentInput,
  workingDirectory: string,
): string[] {
  const runtimePlan = getAdapterRuleRuntimePlan(input, providerId)
  const defaultWatcherPaths = buildDefaultWatcherRegistrations({
    providerId,
    workspaceDir: workingDirectory,
  }).map((registration) => registration.path)
  const all = [
    ...defaultWatcherPaths.map((p) => resolveAdapterWatchPath(p, workingDirectory)),
    ...(runtimePlan
      ? resolveRuntimePlanWatcherPaths(runtimePlan, workingDirectory)
      : []),
  ]
  return [...new Set(all)]
}

/**
 * Opaque handle returned by an artifact-watcher implementation. The base
 * adapter only needs a way to stop a running watcher; the concrete type is
 * intentionally minimal so the adapter-monitor dependency stays optional.
 */
export interface ArtifactWatcherHandle {
  stop: () => void
}

export type ArtifactWatcherFactory = (
  paths: string[],
  providerId: AdapterProviderId,
) => ArtifactWatcherHandle

/**
 * Host for the optional artifact-watcher integration.
 *
 * Manages watcher lifecycle (start/stop), the optional factory wiring used
 * by hosts that depend on `@datazup/dzupagent-adapter-monitor`, and the
 * monitor status that is surfaced via {@link getMonitorStatus}.
 *
 * `BaseCliAdapter` composes one of these instead of inheriting the
 * behavior, so the watcher plane can be tested in isolation and the
 * adapter-monitor peer stays optional.
 */
export class ArtifactWatcherHost {
  private watcher: ArtifactWatcherHandle | null = null
  private factory: ArtifactWatcherFactory | null = null
  private status: AdapterMonitorStatus

  constructor(private readonly providerId: AdapterProviderId) {
    this.status = getDefaultMonitorStatus(providerId)
  }

  /**
   * Wire an artifact-watcher factory. Passing `null` clears the wiring.
   * The current monitor status is recomputed to reflect the change.
   */
  setFactory(factory: ArtifactWatcherFactory | null): void {
    this.factory = factory
    this.status = this.resolveIdleStatus()
  }

  /** Returns a defensive copy of the current monitor status. */
  getStatus(): AdapterMonitorStatus {
    return { ...this.status }
  }

  /**
   * Begin watching the supplied paths for the duration of the current run.
   * No-op when no factory has been wired or when the provider has no
   * registered watch-spec.
   */
  start(paths: string[]): void {
    if (this.watcher) return
    if (!this.isMonitorSupported()) {
      this.status = this.unsupportedStatus()
      return
    }
    if (!this.factory) {
      this.status = {
        ...this.monitorBase(),
        state: 'not_configured',
        supported: true,
        watchedPathCount: paths.length,
      }
      return
    }
    if (paths.length === 0) {
      this.status = {
        ...this.monitorBase(),
        state: 'not_configured',
        supported: true,
        watchedPathCount: 0,
      }
      return
    }
    try {
      this.watcher = this.factory(paths, this.providerId)
      this.status = {
        ...this.monitorBase(),
        state: 'active',
        supported: true,
        watchedPathCount: paths.length,
      }
    } catch {
      // Watcher start failures must not break the run — best-effort only.
      this.watcher = null
      this.status = {
        ...this.monitorBase(),
        state: 'failed_to_start',
        supported: true,
        watchedPathCount: paths.length,
        lastError: 'Artifact watcher factory failed to start',
      }
    }
  }

  /** Stop the active watcher, if any. Best-effort. */
  stop(): void {
    if (!this.watcher) return
    try {
      this.watcher.stop()
    } catch {
      // swallow — stopping is best-effort
    }
    this.watcher = null
    this.status = this.resolveIdleStatus()
  }

  private isMonitorSupported(): boolean {
    return (
      (getProviderCapabilities(this.providerId)?.monitorIntrospection ?? 'none') !== 'none'
    )
  }

  private unsupportedStatus(): AdapterMonitorStatus {
    return {
      state: 'unsupported',
      supported: false,
      monitorIntrospection:
        getProviderCapabilities(this.providerId)?.monitorIntrospection ?? 'none',
    }
  }

  private monitorBase(): Pick<AdapterMonitorStatus, 'monitorIntrospection'> {
    return {
      monitorIntrospection:
        getProviderCapabilities(this.providerId)?.monitorIntrospection ?? 'none',
    }
  }

  private resolveIdleStatus(): AdapterMonitorStatus {
    if (!this.isMonitorSupported()) {
      return this.unsupportedStatus()
    }
    return {
      ...this.monitorBase(),
      state: this.factory ? 'ready' : 'not_configured',
      supported: true,
    }
  }
}
