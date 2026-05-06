/**
 * Bounded async task runners used by orchestration flows.
 *
 * `runConcurrently` mirrors `Promise.allSettled` while preserving input order.
 * `runAllConcurrently` mirrors `Promise.all`: fulfilled values preserve input
 * order, and the returned promise rejects as soon as a started task fails.
 */

export type AsyncTaskFactory<T> = () => Promise<T>

function shouldRunUnbounded(taskCount: number, maxConcurrency: number | undefined): boolean {
  return maxConcurrency === undefined || maxConcurrency <= 0 || maxConcurrency >= taskCount
}

function boundedWorkerCount(taskCount: number, maxConcurrency: number | undefined): number {
  if (taskCount === 0) return 0
  if (maxConcurrency === undefined || maxConcurrency <= 0) return taskCount
  return Math.min(maxConcurrency, taskCount)
}

/**
 * Run task factories concurrently, capped at `maxConcurrency` simultaneous
 * executions. Returns allSettled-style results preserving input order.
 */
export async function runConcurrently<T>(
  factories: readonly AsyncTaskFactory<T>[],
  maxConcurrency: number | undefined,
): Promise<PromiseSettledResult<T>[]> {
  if (shouldRunUnbounded(factories.length, maxConcurrency)) {
    return Promise.allSettled(factories.map(f => f()))
  }

  const results: PromiseSettledResult<T>[] = new Array(factories.length)
  let next = 0
  const runWorker = async (): Promise<void> => {
    while (next < factories.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await factories[index]!() }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: boundedWorkerCount(factories.length, maxConcurrency) }, runWorker))
  return results
}

/**
 * Run task factories concurrently, capped at `maxConcurrency`.
 * Resolves values in input order and rejects on the first observed failure.
 */
export async function runAllConcurrently<T>(
  factories: readonly AsyncTaskFactory<T>[],
  maxConcurrency: number | undefined,
): Promise<T[]> {
  if (shouldRunUnbounded(factories.length, maxConcurrency)) {
    return Promise.all(factories.map(f => f()))
  }

  if (factories.length === 0) return []

  const results: T[] = new Array(factories.length)
  const concurrency = boundedWorkerCount(factories.length, maxConcurrency)
  let next = 0
  let active = 0
  let completed = 0
  let rejected = false

  return new Promise<T[]>((resolve, reject) => {
    const launchNext = (): void => {
      if (rejected) return

      while (active < concurrency && next < factories.length) {
        const index = next++
        active++

        Promise.resolve().then(factories[index]!).then(
          (value) => {
            active--
            completed++
            if (rejected) return

            results[index] = value
            if (completed === factories.length) {
              resolve(results)
              return
            }
            launchNext()
          },
          (reason) => {
            if (rejected) return
            active--
            rejected = true
            reject(reason)
          },
        )
      }
    }

    launchNext()
  })
}
