/**
 * Capability-based permission guard for WASI sandboxes.
 *
 * Controls which host capabilities (filesystem, env, clock, etc.)
 * are available to WASM modules. Follows the principle of least privilege.
 */

export type WasiCapability =
  | 'fs-read'
  | 'fs-write'
  | 'env'
  | 'clock'
  | 'random'
  | 'stdout'
  | 'stderr'
  | 'stdin'

/**
 * Thrown when sandboxed code attempts to use a capability
 * that has not been granted.
 */
export class CapabilityDeniedError extends Error {
  readonly capability: WasiCapability

  constructor(capability: WasiCapability) {
    super(`Capability denied: ${capability}`)
    this.name = 'CapabilityDeniedError'
    this.capability = capability
  }
}

/**
 * Guards access to WASI capabilities.
 *
 * @example
 * ```ts
 * const guard = new CapabilityGuard(new Set(['fs-read', 'stdout']))
 * guard.check('fs-read')   // OK
 * guard.check('fs-write')  // throws CapabilityDeniedError
 * ```
 */
export class CapabilityGuard {
  private readonly granted: Set<WasiCapability>

  constructor(granted: Set<WasiCapability>) {
    this.granted = new Set(granted)
  }

  /**
   * Assert that a capability has been granted.
   * @throws {CapabilityDeniedError} if the capability is not granted.
   */
  check(capability: WasiCapability): void {
    if (!this.granted.has(capability)) {
      throw new CapabilityDeniedError(capability)
    }
  }

  /** Returns true if the capability has been granted. */
  isGranted(capability: WasiCapability): boolean {
    return this.granted.has(capability)
  }

  /** Grant a capability at runtime. */
  grant(capability: WasiCapability): void {
    this.granted.add(capability)
  }

  /** Revoke a previously granted capability. */
  revoke(capability: WasiCapability): void {
    this.granted.delete(capability)
  }

  /** Return all currently granted capabilities. */
  listGranted(): WasiCapability[] {
    return [...this.granted]
  }
}
