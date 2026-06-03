/**
 * Bounded async task runners used by orchestration flows.
 *
 * `runConcurrently` mirrors `Promise.allSettled` while preserving input order.
 * `runAllConcurrently` mirrors `Promise.all`: fulfilled values preserve input
 * order, and the returned promise rejects as soon as a started task fails.
 *
 * Cancellation (W1): both runners accept an optional `AbortSignal` and pass a
 * signal into each task factory. `runAllConcurrently` additionally owns an
 * internal controller that it aborts on the first task failure, so in-flight
 * sibling tasks are cancelled instead of running to completion after the outer
 * promise has already rejected. Factories that thread the signal into their
 * work (e.g. `agent.generate(messages, { signal })`) are cancelled end-to-end;
 * factories that ignore the signal simply run to completion as before.
 */

/**
 * A task factory. Receives an `AbortSignal` that fires when the run is
 * cancelled — either via the external signal passed to the runner, or, for
 * {@link runAllConcurrently}, when a sibling task fails. The parameter is
 * optional so existing zero-arg factories remain assignable.
 */
export type AsyncTaskFactory<T> = (signal?: AbortSignal) => Promise<T>;

export interface ConcurrencyOptions {
  /** External signal; when it aborts, the runner stops launching and signals running tasks. */
  signal?: AbortSignal;
}

function shouldRunUnbounded(
  taskCount: number,
  maxConcurrency: number | undefined
): boolean {
  return (
    maxConcurrency === undefined ||
    maxConcurrency <= 0 ||
    maxConcurrency >= taskCount
  );
}

function boundedWorkerCount(
  taskCount: number,
  maxConcurrency: number | undefined
): number {
  if (taskCount === 0) return 0;
  if (maxConcurrency === undefined || maxConcurrency <= 0) return taskCount;
  return Math.min(maxConcurrency, taskCount);
}

/** Reject reason used when an external signal is already aborted at call time. */
function abortReason(signal: AbortSignal): unknown {
  // `reason` is standardized; fall back to a DOMException-like error if absent.
  return signal.reason ?? new Error("Aborted");
}

/**
 * Run task factories concurrently, capped at `maxConcurrency` simultaneous
 * executions. Returns allSettled-style results preserving input order.
 *
 * The optional `signal` is passed to every factory so a caller-driven abort can
 * propagate into each task. Consistent with `Promise.allSettled`, this runner
 * still awaits every started task (a cancelled task surfaces as a `rejected`
 * outcome rather than truncating the result array).
 */
export async function runConcurrently<T>(
  factories: readonly AsyncTaskFactory<T>[],
  maxConcurrency: number | undefined,
  options?: ConcurrencyOptions
): Promise<PromiseSettledResult<T>[]> {
  const signal = options?.signal;
  if (shouldRunUnbounded(factories.length, maxConcurrency)) {
    return Promise.allSettled(factories.map((f) => f(signal)));
  }

  const results: PromiseSettledResult<T>[] = new Array(factories.length);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (next < factories.length) {
      const index = next++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await factories[index]!(signal),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: boundedWorkerCount(factories.length, maxConcurrency) },
      runWorker
    )
  );
  return results;
}

/**
 * Run task factories concurrently, capped at `maxConcurrency`.
 * Resolves values in input order and rejects on the first observed failure.
 *
 * On first failure (or external abort) an internal controller is aborted and
 * its signal — already handed to every launched factory — fires, so in-flight
 * siblings can stop instead of running to completion after the outer promise
 * has rejected.
 */
export async function runAllConcurrently<T>(
  factories: readonly AsyncTaskFactory<T>[],
  maxConcurrency: number | undefined,
  options?: ConcurrencyOptions
): Promise<T[]> {
  const external = options?.signal;

  // Internal controller: aborts on first failure or when the external signal
  // fires, cancelling already-launched siblings.
  const controller = new AbortController();
  const onExternalAbort = (): void =>
    controller.abort(external ? abortReason(external) : undefined);
  if (external) {
    if (external.aborted) controller.abort(abortReason(external));
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  const cleanup = (): void => {
    if (external) external.removeEventListener("abort", onExternalAbort);
  };

  if (factories.length === 0) {
    cleanup();
    return [];
  }

  // Fail fast if already aborted before any work starts.
  if (controller.signal.aborted) {
    cleanup();
    throw abortReason(controller.signal);
  }

  if (shouldRunUnbounded(factories.length, maxConcurrency)) {
    try {
      return await Promise.all(factories.map((f) => f(controller.signal)));
    } catch (reason) {
      // Cancel any siblings still running once the first failure is observed.
      controller.abort(reason);
      throw reason;
    } finally {
      cleanup();
    }
  }

  const results: T[] = new Array(factories.length);
  const concurrency = boundedWorkerCount(factories.length, maxConcurrency);
  let next = 0;
  let active = 0;
  let completed = 0;
  let settled = false;

  return new Promise<T[]>((resolve, reject) => {
    const finishResolve = (value: T[]): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      // Abort siblings still in flight, then surface the failure.
      controller.abort(reason);
      cleanup();
      reject(reason);
    };

    const launchNext = (): void => {
      if (settled) return;

      while (active < concurrency && next < factories.length) {
        const index = next++;
        active++;

        Promise.resolve()
          .then(() => factories[index]!(controller.signal))
          .then(
            (value) => {
              active--;
              completed++;
              if (settled) return;

              results[index] = value;
              if (completed === factories.length) {
                finishResolve(results);
                return;
              }
              launchNext();
            },
            (reason) => {
              active--;
              finishReject(reason);
            }
          );
      }
    };

    launchNext();
  });
}
