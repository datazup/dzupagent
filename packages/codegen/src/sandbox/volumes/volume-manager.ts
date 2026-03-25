/**
 * Volume management for sandbox containers.
 *
 * Provides an interface for provisioning, releasing, sweeping (cleanup),
 * and converting volumes to Docker mount arguments.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VolumeType = 'workspace' | 'cache' | 'temp'

export interface VolumeDescriptor {
  /** Volume name (must be unique within a scope) */
  name: string
  /** Volume purpose */
  type: VolumeType
  /** Scope identifier (e.g. user ID, project ID) */
  scopeId: string
  /** Where to mount inside the container */
  mountPath: string
  /** Mount as read-only (default: false) */
  readOnly?: boolean
}

export interface VolumeInfo extends VolumeDescriptor {
  /** When this volume was created */
  createdAt: Date
  /** When this volume was last used */
  lastUsedAt: Date
  /** Size in bytes (if known) */
  sizeBytes?: number
}

export type CleanupPolicy = 'lru' | 'lfu' | 'oldest-first'

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface VolumeManager {
  /** Provision (create) a volume. If it already exists, return existing info. */
  provision(desc: VolumeDescriptor): Promise<VolumeInfo>

  /** Release (mark unused) a volume. Does not necessarily delete it. */
  release(name: string, scopeId: string): Promise<void>

  /**
   * Sweep stale volumes according to policy.
   * @returns number of volumes removed
   */
  sweep(policy: CleanupPolicy, maxVolumes: number): Promise<number>

  /** Convert volume info to Docker `-v` mount arguments. */
  toMountArgs(volumes: VolumeInfo[]): string[]

  /** List volumes, optionally filtered by scope. */
  list(scopeId?: string): Promise<VolumeInfo[]>
}
