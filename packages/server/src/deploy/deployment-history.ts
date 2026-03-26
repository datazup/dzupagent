/**
 * DeploymentHistory — in-memory store tracking past deployment records
 * to derive historical success rates for confidence scoring.
 */

import type { DeployConfidence, DeploymentRecord, GateDecision } from './confidence-types.js'

let idCounter = 0

/**
 * Generate a unique deployment record ID using a timestamp+counter pattern.
 * Format: `deploy-<epoch>-<counter>`
 */
export function generateDeploymentId(): string {
  idCounter++
  return `deploy-${Date.now()}-${idCounter}`
}

/** Reset the counter (useful for testing). */
export function resetIdCounter(): void {
  idCounter = 0
}

export class DeploymentHistory {
  private records: DeploymentRecord[] = []

  /** Record a new deployment. */
  record(deployment: DeploymentRecord): void {
    this.records.push(deployment)
  }

  /** Create and record a new deployment from a confidence result. */
  createRecord(confidence: DeployConfidence, decision: GateDecision): DeploymentRecord {
    const record: DeploymentRecord = {
      id: generateDeploymentId(),
      environment: confidence.environment,
      confidence,
      decision,
      deployedAt: new Date(),
    }
    this.records.push(record)
    return record
  }

  /** Mark a deployment as completed with an outcome. */
  complete(id: string, outcome: 'success' | 'failure' | 'rollback'): DeploymentRecord | undefined {
    const record = this.records.find((r) => r.id === id)
    if (record) {
      record.outcome = outcome
      record.completedAt = new Date()
    }
    return record
  }

  /**
   * Get the success rate for an environment over a time window.
   * Returns a value from 0 to 1. Only considers completed deployments.
   *
   * @param environment  Target environment to filter by.
   * @param windowDays   Number of days to look back (default: 30).
   */
  getSuccessRate(environment: string, windowDays = 30): number {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    const relevant = this.records.filter(
      (r) =>
        r.environment === environment &&
        r.outcome !== undefined &&
        r.deployedAt >= cutoff,
    )

    if (relevant.length === 0) return 0

    const successes = relevant.filter((r) => r.outcome === 'success').length
    return successes / relevant.length
  }

  /**
   * Get the most recent deployments for an environment.
   *
   * @param environment  Target environment.
   * @param limit        Maximum records to return (default: 10).
   */
  getRecent(environment: string, limit = 10): DeploymentRecord[] {
    return this.records
      .filter((r) => r.environment === environment)
      .sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime())
      .slice(0, limit)
  }

  /** Get the total number of deployments for an environment. */
  getTotalDeployments(environment: string): number {
    return this.records.filter((r) => r.environment === environment).length
  }

  /** Get all records (primarily for testing/debugging). */
  getAll(): readonly DeploymentRecord[] {
    return this.records
  }

  /** Clear all records. */
  clear(): void {
    this.records = []
  }
}
