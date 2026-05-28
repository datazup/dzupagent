import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  Executor,
  WorkerHandle,
  WorkerInbound,
  WorkerOutcome,
  WorkerSpec,
  WorkerEvent,
} from "@dzupagent/agent-types/fleet";
import { parseCodexLine } from "./worker-event-parser.js";

export interface CodexSubprocessOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export class CodexSubprocessExecutor implements Executor {
  readonly id = "codex-subprocess";
  constructor(private readonly options: CodexSubprocessOptions = {}) {}

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    const command = this.options.command ?? "codex";
    const args = this.options.args ?? [
      "exec",
      "--task-id",
      spec.taskBundle.id,
      "--cd",
      spec.repoPath,
    ];
    const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
      command,
      args,
      {
        cwd: spec.repoPath,
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const buffer: WorkerEvent[] = [];
    const waiters: Array<() => void> = [];
    let closed = false;
    function push(e: WorkerEvent) {
      if (closed) return;
      buffer.push(e);
      waiters.splice(0).forEach((fn) => fn());
    }
    function close() {
      if (closed) return;
      closed = true;
      waiters.splice(0).forEach((fn) => fn());
    }

    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      const ev = parseCodexLine(line);
      if (ev) push(ev);
    });

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

    let cancelled = false;
    const cancelFn = async (reason: string): Promise<void> => {
      cancelled = true;
      child.kill("SIGTERM");
      push({
        kind: "message",
        text: `cancel: ${reason}`,
        role: "tool",
        at: new Date().toISOString(),
      });
    };

    const exitPromise = new Promise<WorkerOutcome>((resolve) => {
      child.on("exit", (code, signal) => {
        if (closed) return;
        if (!buffer.some((e) => e.kind === "exit")) {
          push({
            kind: "exit",
            code,
            reason: signal,
            at: new Date().toISOString(),
          });
        }
        close();
        if (cancelled)
          resolve({ state: "cancelled", exitCode: code, reason: "cancelled" });
        else if (code === 0) resolve({ state: "completed", exitCode: 0 });
        else if (code === null)
          resolve({
            state: "crashed",
            exitCode: null,
            reason: signal ?? "unknown",
          });
        else
          resolve({
            state: "failed",
            exitCode: code,
            reason: stderrChunks.join("").slice(0, 500),
          });
      });
      child.on("error", (err) => {
        if (closed) return;
        push({
          kind: "error",
          message: err.message,
          fatal: true,
          at: new Date().toISOString(),
        });
        close();
        resolve({ state: "crashed", exitCode: null, reason: err.message });
      });
    });

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

    return {
      workerId: spec.workerId,
      events,
      async send(msg: WorkerInbound) {
        if (msg.kind === "cancel") return cancelFn(msg.reason);
        if (msg.kind === "message")
          child.stdin.write(
            JSON.stringify({ type: "inbound", text: msg.text }) + "\n"
          );
      },
      cancel: cancelFn,
      async wait() {
        return exitPromise;
      },
    };
  }
}
