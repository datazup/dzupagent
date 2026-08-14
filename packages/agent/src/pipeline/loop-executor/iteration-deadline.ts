/** Runtime deadline spanning one complete loop-body iteration. */

import type { CancellationSignal } from "@dzupagent/runtime-contracts";

export class LoopIterationTimeoutError extends Error {
  constructor(
    readonly loopNodeId: string,
    readonly iteration: number,
    readonly timeoutMs: number
  ) {
    super(
      `Loop "${loopNodeId}" iteration ${iteration} exceeded timeout (${timeoutMs} ms)`
    );
    this.name = "LoopIterationTimeoutError";
  }
}

export class LoopIterationCancelledError extends Error {
  constructor() {
    super("Loop iteration cancelled");
    this.name = "LoopIterationCancelledError";
  }
}

export interface LoopIterationDeadline {
  readonly signal: AbortSignal | undefined;
  run<T>(work: Promise<T>): Promise<T>;
  dispose(): void;
}

/**
 * Starts one deadline shared by every body node in an iteration. The executor
 * receives the derived signal, while `run` supplies a hard host-side race for
 * executors that do not settle promptly after abort. Such executors must still
 * honor the signal to prevent late state mutation after the host has failed the
 * iteration.
 */
export function createLoopIterationDeadline(input: {
  loopNodeId: string;
  iteration: number;
  timeoutMs: number | undefined;
  parentSignal: CancellationSignal | undefined;
}): LoopIterationDeadline {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  // A handler is attached immediately so disposal before the first `run` does
  // not leave a later parent abort as an unhandled rejection.
  void abort.catch(() => undefined);

  const cancel = (): void => {
    if (controller.signal.aborted) return;
    const error = new LoopIterationCancelledError();
    controller.abort(error);
    rejectAbort?.(error);
  };
  if (input.parentSignal?.aborted) cancel();
  else input.parentSignal?.addEventListener?.("abort", cancel);

  if (input.timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      if (controller.signal.aborted) return;
      const error = new LoopIterationTimeoutError(
        input.loopNodeId,
        input.iteration,
        input.timeoutMs!
      );
      controller.abort(error);
      rejectAbort?.(error);
    }, input.timeoutMs);
  }

  return {
    signal:
      input.parentSignal !== undefined || input.timeoutMs !== undefined
        ? controller.signal
        : undefined,
    run: <T>(work: Promise<T>) => Promise.race([work, abort]),
    dispose: () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      input.parentSignal?.removeEventListener?.("abort", cancel);
    },
  };
}
