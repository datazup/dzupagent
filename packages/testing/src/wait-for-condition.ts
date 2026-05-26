export interface WaitForConditionOptions {
  timeoutMs?: number
  intervalMs?: number
  description?: string
}

/**
 * Polls until the predicate returns true (or truthy) or times out.
 */
export async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  options: WaitForConditionOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000
  const intervalMs = options.intervalMs ?? 25
  const startedAt = Date.now()

  while (Date.now() - startedAt <= timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(options.description ?? 'Condition not met before timeout')
}
