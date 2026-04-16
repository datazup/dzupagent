/**
 * Versioned projection storage for adapter skill bundles.
 *
 * Tracks every compiled projection with a monotonically increasing version
 * number and supports rollback to any prior version.
 *
 * Implementations:
 *   - InMemoryAdapterSkillVersionStore — ephemeral, for tests and single-run use
 *   - FileAdapterSkillVersionStore — persists to .dzupagent/state.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AdapterProviderId } from '../types.js'
import type { CompiledAdapterSkill } from './adapter-skill-types.js'

/** A compiled projection tagged with version metadata. */
export interface VersionedProjection {
  projectionId: string
  bundleId: string
  providerId: AdapterProviderId
  version: number
  compiled: CompiledAdapterSkill
  hash: string
  createdAt: string
  supersededAt?: string
  supersededBy?: string
}

/** Storage interface for versioned projections. */
export interface AdapterSkillVersionStore {
  save(projection: VersionedProjection): void
  getLatest(bundleId: string, providerId: AdapterProviderId): VersionedProjection | undefined
  getVersion(bundleId: string, providerId: AdapterProviderId, version: number): VersionedProjection | undefined
  listVersions(bundleId: string, providerId: AdapterProviderId): VersionedProjection[]
  rollback(bundleId: string, providerId: AdapterProviderId, targetVersion: number): VersionedProjection
}

/** Composite key for the version map. */
function storeKey(bundleId: string, providerId: AdapterProviderId): string {
  return `${bundleId}::${providerId}`
}

/**
 * In-memory implementation of {@link AdapterSkillVersionStore}.
 *
 * Versions are stored per (bundleId, providerId) pair and ordered
 * by ascending version number.
 */
export class InMemoryAdapterSkillVersionStore implements AdapterSkillVersionStore {
  private store = new Map<string, VersionedProjection[]>()

  save(projection: VersionedProjection): void {
    const key = storeKey(projection.bundleId, projection.providerId)
    let versions = this.store.get(key)
    if (!versions) {
      versions = []
      this.store.set(key, versions)
    }
    versions.push(projection)
  }

  getLatest(bundleId: string, providerId: AdapterProviderId): VersionedProjection | undefined {
    const versions = this.store.get(storeKey(bundleId, providerId))
    if (!versions || versions.length === 0) return undefined
    return versions[versions.length - 1]
  }

  getVersion(
    bundleId: string,
    providerId: AdapterProviderId,
    version: number,
  ): VersionedProjection | undefined {
    const versions = this.store.get(storeKey(bundleId, providerId))
    if (!versions) return undefined
    return versions.find((v) => v.version === version)
  }

  listVersions(bundleId: string, providerId: AdapterProviderId): VersionedProjection[] {
    return this.store.get(storeKey(bundleId, providerId)) ?? []
  }

  rollback(
    bundleId: string,
    providerId: AdapterProviderId,
    targetVersion: number,
  ): VersionedProjection {
    const target = this.getVersion(bundleId, providerId, targetVersion)
    if (!target) {
      throw new Error(
        `Version ${targetVersion} not found for bundle '${bundleId}' / provider '${providerId}'`,
      )
    }

    const latest = this.getLatest(bundleId, providerId)
    const now = new Date().toISOString()
    const newVersion = (latest?.version ?? 0) + 1

    // Mark the current latest as superseded
    if (latest) {
      latest.supersededAt = now
      latest.supersededBy = `v${newVersion}`
    }

    // Create a new version entry from the target's compiled output
    const rolled: VersionedProjection = {
      projectionId: `${bundleId}-${providerId}-v${newVersion}`,
      bundleId,
      providerId,
      version: newVersion,
      compiled: target.compiled,
      hash: target.hash,
      createdAt: now,
    }

    this.save(rolled)
    return rolled
  }
}

// ---------------------------------------------------------------------------
// FileAdapterSkillVersionStore
// ---------------------------------------------------------------------------

/** Shape of the projections section in state.json */
interface StateJson {
  version: 1
  projections: Record<string, VersionedProjection[]>
  files: Record<string, unknown>
}

export interface FileAdapterSkillVersionStoreOptions {
  /** Absolute path to state.json (e.g. <project>/.dzupagent/state.json) */
  stateFilePath: string
  /** Debounce writes by this many ms. Default: 100 */
  writeDebounceMs?: number
}

/**
 * File-backed implementation of AdapterSkillVersionStore.
 *
 * Persists compiled projections to .dzupagent/state.json under the
 * `projections` key. The `files` key is managed separately by DzupAgentSyncer.
 *
 * Writes are debounced (default 100ms) to avoid thrashing during
 * batch compile operations.
 */
export class FileAdapterSkillVersionStore implements AdapterSkillVersionStore {
  private readonly stateFilePath: string
  private readonly writeDebounceMs: number

  /** In-memory copy of projections (loaded lazily on first access) */
  private projections: Map<string, VersionedProjection[]> | null = null
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: FileAdapterSkillVersionStoreOptions) {
    this.stateFilePath = options.stateFilePath
    this.writeDebounceMs = options.writeDebounceMs ?? 100
  }

  // -----------------------------------------------------------------------
  // AdapterSkillVersionStore implementation
  // -----------------------------------------------------------------------

  save(projection: VersionedProjection): void {
    const store = this.getStore()
    const key = storeKey(projection.bundleId, projection.providerId)
    let versions = store.get(key)
    if (!versions) {
      versions = []
      store.set(key, versions)
    }
    versions.push(projection)
    this.schedulePersist()
  }

  getLatest(bundleId: string, providerId: AdapterProviderId): VersionedProjection | undefined {
    const versions = this.getStore().get(storeKey(bundleId, providerId))
    if (!versions || versions.length === 0) return undefined
    return versions[versions.length - 1]
  }

  getVersion(
    bundleId: string,
    providerId: AdapterProviderId,
    version: number,
  ): VersionedProjection | undefined {
    const versions = this.getStore().get(storeKey(bundleId, providerId))
    if (!versions) return undefined
    return versions.find((v) => v.version === version)
  }

  listVersions(bundleId: string, providerId: AdapterProviderId): VersionedProjection[] {
    return this.getStore().get(storeKey(bundleId, providerId)) ?? []
  }

  rollback(
    bundleId: string,
    providerId: AdapterProviderId,
    targetVersion: number,
  ): VersionedProjection {
    const target = this.getVersion(bundleId, providerId, targetVersion)
    if (!target) {
      throw new Error(
        `Version ${targetVersion} not found for bundle '${bundleId}' / provider '${providerId}'`,
      )
    }

    const latest = this.getLatest(bundleId, providerId)
    const now = new Date().toISOString()
    const newVersion = (latest?.version ?? 0) + 1

    if (latest) {
      latest.supersededAt = now
      latest.supersededBy = `v${newVersion}`
    }

    const rolled: VersionedProjection = {
      projectionId: `${bundleId}-${providerId}-v${newVersion}`,
      bundleId,
      providerId,
      version: newVersion,
      compiled: target.compiled,
      hash: target.hash,
      createdAt: now,
    }

    this.save(rolled)
    return rolled
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /** Flush any pending debounced writes immediately. */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.dirty) {
      await this.persist()
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Return the in-memory store, loading from disk synchronously on first access.
   * We use a synchronous load here to keep the interface consistent (save/getLatest
   * are synchronous in the base interface). The file is small so sync read is fine.
   */
  private getStore(): Map<string, VersionedProjection[]> {
    if (this.projections !== null) return this.projections

    this.projections = new Map()
    try {
      // Synchronous read — intentional for interface compatibility
      const raw = readFileSync(this.stateFilePath, 'utf-8')
      const state = JSON.parse(raw) as Partial<StateJson>
      if (state.projections && typeof state.projections === 'object') {
        for (const [key, versions] of Object.entries(state.projections)) {
          if (Array.isArray(versions)) {
            this.projections.set(key, versions as VersionedProjection[])
          }
        }
      }
    } catch {
      // File does not exist or is malformed — start fresh
    }

    return this.projections
  }

  private schedulePersist(): void {
    this.dirty = true
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.persist()
    }, this.writeDebounceMs)
  }

  private async persist(): Promise<void> {
    if (!this.dirty || this.projections === null) return

    // Read current state.json to preserve the `files` section
    let existingState: Partial<StateJson> = {}
    try {
      const raw = await readFile(this.stateFilePath, 'utf-8')
      existingState = JSON.parse(raw) as Partial<StateJson>
    } catch {
      // File missing — will create
    }

    const projectionsObj: Record<string, VersionedProjection[]> = {}
    for (const [key, versions] of this.projections) {
      projectionsObj[key] = versions
    }

    const newState: StateJson = {
      version: 1,
      projections: projectionsObj,
      files: existingState.files ?? {},
    }

    await mkdir(dirname(this.stateFilePath), { recursive: true })
    await writeFile(this.stateFilePath, JSON.stringify(newState, null, 2), 'utf-8')
    this.dirty = false
  }
}
