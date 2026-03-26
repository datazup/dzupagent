/**
 * Resource quota management interfaces for multi-tenant ForgeAgent deployments.
 *
 * Provides quota enforcement, reservation-based resource management, and
 * automatic cleanup of expired reservations.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dimensions that can be quota-limited per tenant. */
export interface ResourceDimensions {
  concurrentRuns?: number
  tokensPerMinute?: number
  costCentsPerDay?: number
  sandboxes?: number
}

/** A quota record for a specific tenant. */
export interface ResourceQuota {
  tenantId: string
  dimensions: ResourceDimensions
  updatedAt: Date
}

/** A reservation against a specific dimension. */
export interface ResourceReservation {
  id: string
  tenantId: string
  dimension: keyof ResourceDimensions
  amount: number
  reservedAt: Date
  expiresAt: Date
  released: boolean
}

/** Result of a quota check — allowed with remaining capacity, or denied. */
export type QuotaCheckResult =
  | { allowed: true; remaining: ResourceDimensions }
  | { allowed: false; dimension: string; limit: number; current: number }

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Thrown when a quota check fails. */
export class QuotaExceededError extends Error {
  constructor(
    public readonly dimension: string,
    public readonly limit: number,
    public readonly current: number,
  ) {
    super(`Quota exceeded: ${dimension} (limit=${limit}, current=${current})`)
    this.name = 'QuotaExceededError'
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Manages per-tenant resource quotas with reservation semantics. */
export interface ResourceQuotaManager {
  /** Set (replace) the quota dimensions for a tenant. */
  setQuota(tenantId: string, dimensions: ResourceDimensions): Promise<void>

  /** Get the current quota for a tenant, or undefined if none set. */
  getQuota(tenantId: string): Promise<ResourceQuota | undefined>

  /** Check whether a requested amount is within quota. */
  check(
    tenantId: string,
    dimension: keyof ResourceDimensions,
    amount: number,
  ): Promise<QuotaCheckResult>

  /**
   * Reserve capacity — returns a reservation to be released later.
   * Internally enforces a quota check before creating the reservation.
   * @throws {QuotaExceededError} if the reservation would exceed the tenant's quota.
   */
  reserve(
    tenantId: string,
    dimension: keyof ResourceDimensions,
    amount: number,
    ttlMs?: number,
  ): Promise<ResourceReservation>

  /** Release a previously created reservation. Double-release is idempotent. */
  release(reservationId: string): Promise<void>

  /** Get current usage (sum of active reservations) for a tenant. */
  getUsage(tenantId: string): Promise<ResourceDimensions>

  /** List all active (non-released, non-expired) reservations for a tenant. */
  listReservations(tenantId: string): Promise<ResourceReservation[]>

  /** Remove all expired reservations. Returns number swept. */
  sweepExpired(): Promise<number>
}
