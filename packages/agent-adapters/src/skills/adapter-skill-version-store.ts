/**
 * Versioned projection storage for adapter skill bundles.
 *
 * Tracks every compiled projection with a monotonically increasing version
 * number and supports rollback to any prior version.
 */

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
