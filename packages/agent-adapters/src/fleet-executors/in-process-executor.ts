import type {
  Executor,
  WorkerHandle,
  WorkerInbound,
  WorkerOutcome,
  WorkerSpec,
  WorkerEvent,
} from "@dzupagent/agent-types/fleet";

export interface InProcessOptions {
  script: WorkerEvent[];
  hangAfterScript?: boolean;
  delayMsBetweenEvents?: number;
}

// Note: InProcessExecutor never emits "crashed" outcomes — a scripted
// executor has no notion of abnormal death; it follows the script. Nonzero
// exit codes map to "failed".
export class InProcessExecutor implements Executor {
  readonly id = "in-process";
  constructor(private readonly options: InProcessOptions) {}

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    const script = [...this.options.script];
    const delay = this.options.delayMsBetweenEvents ?? 0;
    const hangAfter = this.options.hangAfterScript === true;
    let cancelled = false;
    let cancelReason: string | null = null;

    const buffer: WorkerEvent[] = [];
    const waiters: Array<() => void> = [];
    let closed = false;
    function push(e: WorkerEvent) {
      buffer.push(e);
      waiters.splice(0).forEach((fn) => fn());
    }
    function close() {
      closed = true;
      waiters.splice(0).forEach((fn) => fn());
    }

    const producer = (async () => {
      for (const e of script) {
        if (cancelled) break;
        push(e);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      if (hangAfter && !cancelled) {
        await new Promise<void>((resolve) => {
          const id = setInterval(() => {
            if (cancelled) {
              clearInterval(id);
              resolve();
            }
          }, 10);
        });
      }
      close();
    })();

    const events: AsyncIterable<WorkerEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<WorkerEvent>> {
            while (buffer.length === 0 && !closed) {
              await new Promise<void>((r) => waiters.push(r));
            }
            if (buffer.length > 0)
              return { value: buffer.shift()!, done: false };
            return { value: undefined as never, done: true };
          },
        };
      },
    };

    const waitPromise: Promise<WorkerOutcome> = (async () => {
      await producer;
      if (cancelled)
        return {
          state: "cancelled",
          exitCode: null,
          reason: cancelReason ?? "cancelled",
        };
      const exit = script.find((e) => e.kind === "exit") as
        | Extract<WorkerEvent, { kind: "exit" }>
        | undefined;
      if (!exit) return { state: "completed", exitCode: null };
      if (exit.code === 0) return { state: "completed", exitCode: 0 };
      return { state: "failed", exitCode: exit.code };
    })();

    return {
      workerId: spec.workerId,
      events,
      async send(_msg: WorkerInbound) {},
      async cancel(reason: string) {
        cancelled = true;
        cancelReason = reason;
        close();
      },
      async wait() {
        return waitPromise;
      },
    };
  }
}

export function scriptExecutor(
  script: WorkerEvent[],
  opts: { hangAfterScript?: boolean } = {}
): Executor {
  return new InProcessExecutor({ script, ...opts });
}
