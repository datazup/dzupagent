/**
 * Resolve after `ms` milliseconds using an unref'd timer so a pending poll
 * (e.g. {@link BackgroundSubagentRuntime.await}) never holds the process open.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
