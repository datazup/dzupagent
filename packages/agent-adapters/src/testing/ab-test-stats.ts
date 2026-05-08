/**
 * Statistical and concurrency helpers for the A/B testing framework.
 *
 * Extracted from `ab-test-runner.ts` so the runner can stay focused on
 * orchestration. These helpers are intentionally small, pure, and
 * dependency-light so they remain easy to test in isolation.
 */

import { Semaphore } from '@dzupagent/core/orchestration'

export function normalizeConcurrency(value: number | undefined, defaultValue = 2): number {
  const concurrency = value ?? defaultValue
  if (!Number.isFinite(concurrency) || !Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(
      `ABTestRunner maxConcurrency must be a finite positive integer; received ${String(concurrency)}`,
    )
  }
  return concurrency
}

export async function acquireSemaphore(semaphore: Semaphore, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await semaphore.acquire()
    return true
  }

  if (signal.aborted) {
    return false
  }

  const acquirePromise = semaphore.acquire().then(() => {
    if (signal.aborted) {
      semaphore.release()
      return false
    }
    return true
  })

  const abortPromise = new Promise<boolean>((resolve) => {
    const onAbort = (): void => resolve(false)
    signal.addEventListener('abort', onAbort, { once: true })
    acquirePromise.finally(() => signal.removeEventListener('abort', onAbort))
  })

  return await Promise.race([acquirePromise, abortPromise])
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

export function variance(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  let sum = 0
  for (const v of values) sum += (v - m) ** 2
  return sum / (values.length - 1)
}

/**
 * Standard normal CDF approximation using the Abramowitz & Stegun formula.
 * Accurate to about 1e-5 for the purposes of dev tooling.
 */
export function normalCDF(x: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x)
  const t = 1.0 / (1.0 + p * absX)
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2)

  return 0.5 * (1.0 + sign * y)
}

/**
 * Welch's t-test approximation for two independent samples.
 *
 * Uses a normal CDF approximation for the p-value, which is conservative
 * but sufficient for developer tooling comparisons.
 */
export function welchTTest(samplesA: number[], samplesB: number[]): { tStat: number; pValue: number } {
  const nA = samplesA.length
  const nB = samplesB.length

  if (nA < 2 || nB < 2) {
    return { tStat: 0, pValue: 1 }
  }

  const meanA = mean(samplesA)
  const meanB = mean(samplesB)
  const varA = variance(samplesA)
  const varB = variance(samplesB)

  const seSquared = varA / nA + varB / nB

  if (seSquared === 0) {
    return { tStat: 0, pValue: 1 }
  }

  const tStat = (meanA - meanB) / Math.sqrt(seSquared)

  // Two-tailed p-value using normal CDF approximation
  const pValue = 2 * (1 - normalCDF(Math.abs(tStat)))

  return { tStat, pValue }
}
