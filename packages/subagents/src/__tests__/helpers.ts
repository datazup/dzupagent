import type { Clock } from "../contracts/clock.js";
import type {
  FanoutRuntimeEvent,
  SubagentEventSink,
  SubagentRuntimeEvent,
} from "../contracts/events.js";
import type {
  SubagentExecutorPort,
  SubagentExecutionContext,
} from "../contracts/subagent-executor-port.js";
import type {
  SubagentResult,
  SubagentSpec,
} from "../contracts/background-task.js";
import type { SubagentLogger, SubagentLogFields } from "../contracts/logger.js";
import type { GovernanceEventSink } from "../runtime/background-subagent-runtime.js";

/** Collects structured log calls for assertions. */
export class RecordingLogger implements SubagentLogger {
  readonly calls: Array<{ level: string; fields: SubagentLogFields }> = [];
  error(fields: SubagentLogFields): void {
    this.calls.push({ level: "error", fields });
  }
  warn(fields: SubagentLogFields): void {
    this.calls.push({ level: "warn", fields });
  }
  info(fields: SubagentLogFields): void {
    this.calls.push({ level: "info", fields });
  }
  debug(fields: SubagentLogFields): void {
    this.calls.push({ level: "debug", fields });
  }
  /** All calls at a given level. */
  at(level: string): SubagentLogFields[] {
    return this.calls.filter((c) => c.level === level).map((c) => c.fields);
  }
}

/** A clock whose value is advanced manually — deterministic time for tests. */
export class ManualClock implements Clock {
  constructor(private current = 0) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}

/** Collects emitted runtime events for assertions. */
export class RecordingEventSink implements SubagentEventSink {
  readonly events: Array<SubagentRuntimeEvent | FanoutRuntimeEvent> = [];
  emit(event: SubagentRuntimeEvent | FanoutRuntimeEvent): void {
    this.events.push(event);
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

/** Collects governance events for assertions. */
export class RecordingGovernanceSink implements GovernanceEventSink {
  readonly events: Array<{ type: string; runId: string; detail?: string }> = [];
  emitGovernance(event: {
    type: string;
    runId: string;
    detail?: string;
  }): void {
    this.events.push(event);
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

/** Deterministic id generator. */
export function sequentialIds(prefix = "t"): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

/** An executor whose behaviour is controlled per-call. */
export class ControllableExecutor implements SubagentExecutorPort {
  private resolvers = new Map<string, (r: SubagentResult) => void>();
  private rejecters = new Map<string, (e: Error) => void>();
  readonly runCalls: SubagentSpec[] = [];

  constructor(
    private readonly mode: "manual" | "instant" = "instant",
    private readonly instantResult: SubagentResult = { output: "ok" }
  ) {}

  async run(
    spec: SubagentSpec,
    ctx: SubagentExecutionContext
  ): Promise<SubagentResult> {
    this.runCalls.push(spec);
    if (this.mode === "instant") {
      return this.instantResult;
    }
    return new Promise<SubagentResult>((resolve, reject) => {
      // A well-behaved executor honours an already-aborted signal immediately.
      if (ctx.signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      this.resolvers.set(ctx.taskId, resolve);
      this.rejecters.set(ctx.taskId, reject);
      ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  }

  complete(taskId: string, result: SubagentResult = { output: "ok" }): void {
    this.resolvers.get(taskId)?.(result);
    this.resolvers.delete(taskId);
  }

  fail(taskId: string, message = "boom"): void {
    this.rejecters.get(taskId)?.(new Error(message));
    this.rejecters.delete(taskId);
  }
}

/** Wait microtasks so fire-and-forget runtime work settles. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}
