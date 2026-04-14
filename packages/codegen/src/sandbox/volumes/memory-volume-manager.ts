/**
 * In-memory VolumeManager implementation for development and testing.
 *
 * Stores volume metadata in memory. No actual Docker volumes are created.
 * Useful for unit tests and local development without Docker.
 */

import type {
  VolumeDescriptor,
  VolumeInfo,
  VolumeManager,
  CleanupPolicy,
} from './volume-manager.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function volumeKey(name: string, scopeId: string): string {
  return `${scopeId}::${name}`
}

/** Track access frequency for LFU policy */
interface TrackedVolume extends VolumeInfo {
  accessCount: number
}

// ---------------------------------------------------------------------------
// InMemoryVolumeManager
// ---------------------------------------------------------------------------

export class InMemoryVolumeManager implements VolumeManager {
  private readonly volumes = new Map<string, TrackedVolume>()

  async provision(desc: VolumeDescriptor): Promise<VolumeInfo> {
    const key = volumeKey(desc.name, desc.scopeId)
    const existing = this.volumes.get(key)
    if (existing) {
      existing.lastUsedAt = new Date()
      existing.accessCount++
      return this.toVolumeInfo(existing)
    }

    const now = new Date()
    const vol: TrackedVolume = {
      name: desc.name,
      type: desc.type,
      scopeId: desc.scopeId,
      mountPath: desc.mountPath,
      createdAt: now,
      lastUsedAt: now,
      sizeBytes: 0,
      accessCount: 1,
    }
    if (desc.readOnly !== undefined) vol.readOnly = desc.readOnly
    this.volumes.set(key, vol)
    return this.toVolumeInfo(vol)
  }

  async release(name: string, scopeId: string): Promise<void> {
    const key = volumeKey(name, scopeId)
    this.volumes.delete(key)
  }

  async sweep(policy: CleanupPolicy, maxVolumes: number): Promise<number> {
    const all = [...this.volumes.entries()]
    if (all.length <= maxVolumes) {
      return 0
    }

    const toRemove = all.length - maxVolumes

    // Sort according to policy (ascending = first to remove)
    const sorted = [...all]
    switch (policy) {
      case 'lru':
        sorted.sort((a, b) => a[1].lastUsedAt.getTime() - b[1].lastUsedAt.getTime())
        break
      case 'lfu':
        sorted.sort((a, b) => a[1].accessCount - b[1].accessCount)
        break
      case 'oldest-first':
        sorted.sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime())
        break
    }

    let removed = 0
    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      const entry = sorted[i]
      if (entry) {
        this.volumes.delete(entry[0])
        removed++
      }
    }
    return removed
  }

  toMountArgs(volumes: VolumeInfo[]): string[] {
    return volumes.map((v) => {
      const ro = v.readOnly ? ':ro' : ''
      return `-v=${v.name}:${v.mountPath}${ro}`
    })
  }

  async list(scopeId?: string): Promise<VolumeInfo[]> {
    const result: VolumeInfo[] = []
    for (const vol of this.volumes.values()) {
      if (scopeId === undefined || vol.scopeId === scopeId) {
        result.push(this.toVolumeInfo(vol))
      }
    }
    return result
  }

  private toVolumeInfo(tv: TrackedVolume): VolumeInfo {
    const info: VolumeInfo = {
      name: tv.name,
      type: tv.type,
      scopeId: tv.scopeId,
      mountPath: tv.mountPath,
      createdAt: tv.createdAt,
      lastUsedAt: tv.lastUsedAt,
    }
    if (tv.readOnly !== undefined) info.readOnly = tv.readOnly
    if (tv.sizeBytes !== undefined) info.sizeBytes = tv.sizeBytes
    return info
  }
}
