/**
 * In-memory implementation of ResourceQuotaManager.
 *
 * Suitable for single-process deployments and testing.
 * All operations are synchronous under the hood but return promises
 * for interface compliance.
 */
import { randomUUID } from 'node:crypto'
import type {
  ResourceDimensions,
  ResourceQuota,
  ResourceReservation,
  ResourceQuotaManager,
  QuotaCheckResult,
} from './resource-quota.js'
import { QuotaExceededError } from './resource-quota.js'

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes

export class InMemoryQuotaManager implements ResourceQuotaManager {
  private readonly quotas = new Map<string, ResourceQuota>()
  private readonly reservations = new Map<string, ResourceReservation>()

  // -------------------------------------------------------------------------
  // Quota CRUD
  // -------------------------------------------------------------------------

  async setQuota(tenantId: string, dimensions: ResourceDimensions): Promise<void> {
    this.quotas.set(tenantId, { tenantId, dimensions, updatedAt: new Date() })
  }

  async getQuota(tenantId: string): Promise<ResourceQuota | undefined> {
    return this.quotas.get(tenantId)
  }

  // -------------------------------------------------------------------------
  // Usage calculation
  // -------------------------------------------------------------------------

  async getUsage(tenantId: string): Promise<ResourceDimensions> {
    const now = Date.now()
    const usage: ResourceDimensions = {}

    for (const res of this.reservations.values()) {
      if (res.tenantId !== tenantId) continue
      if (res.released) continue
      if (res.expiresAt.getTime() <= now) continue

      const current = usage[res.dimension] ?? 0
      usage[res.dimension] = current + res.amount
    }

    return usage
  }

  // -------------------------------------------------------------------------
  // Check
  // -------------------------------------------------------------------------

  async check(
    tenantId: string,
    dimension: keyof ResourceDimensions,
    amount: number,
  ): Promise<QuotaCheckResult> {
    const quota = this.quotas.get(tenantId)

    // No quota set = unlimited
    if (!quota) {
      return { allowed: true, remaining: {} }
    }

    const limit = quota.dimensions[dimension]

    // Dimension not limited
    if (limit === undefined) {
      return { allowed: true, remaining: {} }
    }

    const usage = await this.getUsage(tenantId)
    const current = usage[dimension] ?? 0

    if (current + amount > limit) {
      return { allowed: false, dimension, limit, current }
    }

    const remaining: ResourceDimensions = { ...quota.dimensions }
    for (const key of Object.keys(usage) as Array<keyof ResourceDimensions>) {
      const lim = remaining[key]
      if (lim !== undefined) {
        remaining[key] = lim - (usage[key] ?? 0)
      }
    }
    // Subtract the amount being checked from the target dimension
    if (remaining[dimension] !== undefined) {
      remaining[dimension] = (remaining[dimension] ?? 0) - amount
    }

    return { allowed: true, remaining }
  }

  // -------------------------------------------------------------------------
  // Reserve / Release
  // -------------------------------------------------------------------------

  async reserve(
    tenantId: string,
    dimension: keyof ResourceDimensions,
    amount: number,
    ttlMs?: number,
  ): Promise<ResourceReservation> {
    // Enforce quota before reserving — prevents bypass of check()
    const quota = this.quotas.get(tenantId)
    if (quota) {
      const limit = quota.dimensions[dimension]
      if (limit !== undefined) {
        const usage = await this.getUsage(tenantId)
        const current = usage[dimension] ?? 0
        if (current + amount > limit) {
          throw new QuotaExceededError(dimension, limit, current)
        }
      }
    }

    const now = new Date()
    const reservation: ResourceReservation = {
      id: randomUUID(),
      tenantId,
      dimension,
      amount,
      reservedAt: now,
      expiresAt: new Date(now.getTime() + (ttlMs ?? DEFAULT_TTL_MS)),
      released: false,
    }
    this.reservations.set(reservation.id, reservation)
    return reservation
  }

  async release(reservationId: string): Promise<void> {
    const res = this.reservations.get(reservationId)
    if (res) {
      // Idempotent — double release is fine
      res.released = true
    }
  }

  // -------------------------------------------------------------------------
  // Listing / Sweeping
  // -------------------------------------------------------------------------

  async listReservations(tenantId: string): Promise<ResourceReservation[]> {
    const now = Date.now()
    const result: ResourceReservation[] = []

    for (const res of this.reservations.values()) {
      if (res.tenantId !== tenantId) continue
      if (res.released) continue
      if (res.expiresAt.getTime() <= now) continue
      result.push(res)
    }

    return result
  }

  async sweepExpired(): Promise<number> {
    const now = Date.now()
    let swept = 0

    for (const [id, res] of this.reservations) {
      if (res.released || res.expiresAt.getTime() <= now) {
        this.reservations.delete(id)
        swept++
      }
    }

    return swept
  }
}
