/**
 * Statistical and concurrency helpers for the PromptExperiment harness.
 *
 * Extracted from `prompt-experiment.ts` so the runner can stay focused on
 * orchestration. These helpers are pure functions (with the exception of
 * the semaphore wrapper) and easy to unit-test in isolation.
 */

import { Semaphore } from '@dzupagent/core/orchestration';

import type { PairedComparison } from './prompt-experiment-types.js';

export function normalizeConcurrency(value: number | undefined, defaultValue = 3): number {
  const concurrency = value ?? defaultValue;

  if (!Number.isFinite(concurrency) || !Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(
      `PromptExperiment concurrency must be a finite positive integer; received ${String(concurrency)}`,
    );
  }

  return concurrency;
}

export async function acquireSemaphore(semaphore: Semaphore, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await semaphore.acquire();
    return true;
  }

  if (signal.aborted) {
    return false;
  }

  const acquirePromise = semaphore.acquire().then(() => {
    if (signal.aborted) {
      semaphore.release();
      return false;
    }
    return true;
  });

  const abortPromise = new Promise<boolean>((resolve) => {
    const onAbort = (): void => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void acquirePromise.finally(() => signal.removeEventListener('abort', onAbort));
  });

  return await Promise.race([acquirePromise, abortPromise]);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  let sumSq = 0;
  for (const v of values) {
    const diff = v - avg;
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Approximate the two-tailed p-value from a t-statistic and degrees of freedom.
 *
 * For df > 30 we use a normal approximation. For smaller df we use a rational
 * approximation of the incomplete beta function that backs the t-distribution CDF.
 */
export function twoTailedPValue(t: number, df: number): number {
  const absT = Math.abs(t);

  if (df > 30) {
    // Normal approximation via the error function complement
    return erfc(absT / Math.SQRT2);
  }

  // Regularised incomplete beta function approach:
  // p = I_{x}(a, b) where x = df/(df + t^2), a = df/2, b = 0.5
  const x = df / (df + absT * absT);
  const a = df / 2;
  const b = 0.5;
  const ibeta = regularisedIncompleteBeta(x, a, b);
  return ibeta;
}

/**
 * Complementary error function approximation (Abramowitz & Stegun 7.1.26).
 */
export function erfc(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 1 - sign * y;
}

/**
 * Regularised incomplete beta function I_x(a, b) via continued fraction
 * (Lentz's algorithm). Good enough for the t-distribution CDF with small df.
 */
export function regularisedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use the symmetry relation if x > (a+1)/(a+b+2)
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularisedIncompleteBeta(1 - x, b, a);
  }

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  // Continued fraction (Lentz)
  const maxIter = 200;
  const eps = 1e-14;
  let f = 1.0;
  let c = 1.0;
  let d = 1.0 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < eps) d = eps;
  d = 1.0 / d;
  f = d;

  for (let m = 1; m <= maxIter; m++) {
    // Even step
    let numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1.0 + numerator * d;
    if (Math.abs(d) < eps) d = eps;
    c = 1.0 + numerator / c;
    if (Math.abs(c) < eps) c = eps;
    d = 1.0 / d;
    f *= c * d;

    // Odd step
    numerator =
      -(((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1)));
    d = 1.0 + numerator * d;
    if (Math.abs(d) < eps) d = eps;
    c = 1.0 + numerator / c;
    if (Math.abs(c) < eps) c = eps;
    d = 1.0 / d;
    const delta = c * d;
    f *= delta;

    if (Math.abs(delta - 1.0) < eps) break;
  }

  return front * f;
}

/**
 * Log-gamma via Lanczos approximation.
 */
export function lnGamma(z: number): number {
  const g = 7;
  const coefficients = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = coefficients[0]!;
  for (let i = 1; i < g + 2; i++) {
    x += coefficients[i]! / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Perform a paired t-test between two arrays of scores (same length, paired by index).
 */
export function pairedTTest(
  scoresA: number[],
  scoresB: number[],
  variantAName: string,
  variantBName: string,
): PairedComparison {
  const n = scoresA.length;

  if (n < 2) {
    return {
      variantA: variantAName,
      variantB: variantBName,
      meanDifference: 0,
      standardError: 0,
      confidenceInterval: [0, 0],
      pValue: 1,
      significant: false,
      winner: 'tie',
      summary: `Insufficient data (n=${n}) to compare ${variantAName} vs ${variantBName}.`,
    };
  }

  const diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    diffs.push(scoresA[i]! - scoresB[i]!);
  }

  const meanD = mean(diffs);
  const stdD = stddev(diffs, meanD);
  const se = stdD / Math.sqrt(n);

  let pValue: number;
  if (se === 0) {
    pValue = meanD === 0 ? 1 : 0;
  } else {
    const tStat = meanD / se;
    pValue = twoTailedPValue(tStat, n - 1);
  }

  // Clamp p-value to [0, 1]
  pValue = Math.max(0, Math.min(1, pValue));

  const ci: [number, number] = [meanD - 1.96 * se, meanD + 1.96 * se];
  const significant = pValue < 0.05;

  let winner: string | 'tie';
  if (!significant) {
    winner = 'tie';
  } else {
    winner = meanD > 0 ? variantAName : variantBName;
  }

  const directionWord = meanD > 0 ? 'better' : meanD < 0 ? 'worse' : 'equal to';
  const summary = significant
    ? `${variantAName} is significantly ${directionWord} ${variantBName} (p=${pValue.toFixed(4)})`
    : `No significant difference between ${variantAName} and ${variantBName} (p=${pValue.toFixed(4)})`;

  return {
    variantA: variantAName,
    variantB: variantBName,
    meanDifference: meanD,
    standardError: se,
    confidenceInterval: ci,
    pValue,
    significant,
    winner,
    summary,
  };
}
