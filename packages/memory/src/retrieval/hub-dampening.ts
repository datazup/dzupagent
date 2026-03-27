/**
 * Hub Dampening — prevent frequently-accessed memories from monopolising retrieval.
 *
 * Applies logarithmic attenuation to retrieval scores based on access count:
 *   adjusted_score = raw_score / log_b(offset + accessCount)
 *
 * With default config (logBase=2, offset=2):
 *   0 accesses -> score / log2(2) = score / 1.0  (no change)
 *   1 access   -> score / log2(3) = score / 1.58
 *   5 accesses -> score / log2(7) = score / 2.81
 *  10 accesses -> score / log2(12) = score / 3.58
 *  50 accesses -> score / log2(52) = score / 5.70
 */

export interface HubDampenedResult {
  key: string
  score: number
  originalScore: number
  accessCount: number
  dampeningFactor: number
  value: Record<string, unknown>
}

export interface HubDampeningConfig {
  /** Log base for dampening (default: 2) */
  logBase?: number
  /** Offset added to accessCount before log (default: 2) */
  offset?: number
  /** Minimum accessCount before dampening kicks in (default: 0) */
  minAccessCount?: number
}

/**
 * Extract access count from a memory record value.
 * Checks `_decay.accessCount` first, then `_accessCount` field.
 */
export function getAccessCount(value: Record<string, unknown>): number {
  const decay = value['_decay']
  if (decay != null && typeof decay === 'object' && !Array.isArray(decay)) {
    const ac = (decay as Record<string, unknown>)['accessCount']
    if (typeof ac === 'number' && ac >= 0) return ac
  }
  const direct = value['_accessCount']
  if (typeof direct === 'number' && direct >= 0) return direct
  return 0
}

/**
 * Apply hub dampening to retrieval scores.
 * Attenuates scores of frequently-accessed memories using logarithmic decay.
 * Access count is read from record `_decay.accessCount` or `_accessCount` field.
 */
export function applyHubDampening<
  T extends { key: string; score: number; value: Record<string, unknown> },
>(results: T[], config?: HubDampeningConfig): HubDampenedResult[] {
  const logBase = config?.logBase ?? 2
  const offset = config?.offset ?? 2
  const minAccessCount = config?.minAccessCount ?? 0

  const logDenom = Math.log(logBase)

  return results.map((item) => {
    const accessCount = getAccessCount(item.value)
    const shouldDampen = accessCount >= minAccessCount
    const dampeningFactor = shouldDampen ? Math.log(offset + accessCount) / logDenom : 1
    const score = dampeningFactor > 0 ? item.score / dampeningFactor : item.score

    return {
      key: item.key,
      score,
      originalScore: item.score,
      accessCount,
      dampeningFactor,
      value: item.value,
    }
  })
}
