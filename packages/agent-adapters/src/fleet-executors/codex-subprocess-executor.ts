import { spawn, type ChildProcessByStdio } from "node:child_process";
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
  codexArgsPrefix?: string[];
  env?: NodeJS.ProcessEnv;
  enableDynamicWorkflowSubprocessMode?: boolean;
}

export class CodexSubprocessExecutor implements Executor {
  readonly id = "codex-subprocess";
  constructor(private readonly options: CodexSubprocessOptions = {}) {}

  async assertSupportsDynamicWorkflowMode(): Promise<void> {
    if (!this.options.enableDynamicWorkflowSubprocessMode) {
      throw new Error(
        "Codex dynamic workflow subprocess mode is unavailable without an explicit capability probe",
      );
    }
  }

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    if (spec.config["dynamicWorkflowMode"] === true) {
      await this.assertSupportsDynamicWorkflowMode();
    }

    const command = this.options.command ?? "codex";
    const args = this.options.args ?? this.buildCodexExecArgs(spec);
    const prompt = this.buildPrompt(spec);
    const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
      command,
      args,
      {
        cwd: spec.repoPath,
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    child.stdin.on("error", () => {
      // Child may exit before stdin is flushed; outcome is handled by close/error.
    });
    child.stdin.write(prompt);
    child.stdin.end();

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

    let stdoutRemainder = "";
    child.stdout.on("data", (chunk) => {
      stdoutRemainder += String(chunk);
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        const ev = parseCodexLine(line);
        if (ev) push(ev);
      }
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
      let pendingOutcome: WorkerOutcome | null = null;
      let stdoutClosed = false;
      const finalize = () => {
        if (closed) return;
        if (!pendingOutcome) return;
        if (!stdoutClosed) return;
        close();
        resolve(pendingOutcome);
      };

      child.stdout.on("close", () => {
        if (stdoutRemainder.trim()) {
          const ev = parseCodexLine(stdoutRemainder);
          if (ev) push(ev);
        }
        stdoutClosed = true;
        finalize();
      });

      child.on("close", (code, signal) => {
        if (closed) return;
        if (!buffer.some((e) => e.kind === "exit")) {
          push({
            kind: "exit",
            code,
            reason: signal,
            at: new Date().toISOString(),
          });
        }
        if (cancelled)
          pendingOutcome = { state: "cancelled", exitCode: code, reason: "cancelled" };
        else if (code === 0) pendingOutcome = { state: "completed", exitCode: 0 };
        else if (code === null)
          pendingOutcome = {
            state: "crashed",
            exitCode: null,
            reason: signal ?? "unknown",
          };
        else
          pendingOutcome = {
            state: "failed",
            exitCode: code,
            reason: stderrChunks.join("").slice(0, 500),
          };
        finalize();
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
        if (msg.kind === "message") {
          child.stdin.write(
            JSON.stringify({ type: "inbound", text: msg.text }) + "\n"
          );
          return;
        }
        throw new Error(
          `CodexSubprocessExecutor: unhandled WorkerInbound kind "${msg.kind}"`
        );
      },
      cancel: cancelFn,
      async wait() {
        return exitPromise;
      },
    };
  }

  private buildCodexExecArgs(spec: WorkerSpec): string[] {
    return [
      ...(this.options.codexArgsPrefix ?? []),
      "exec",
      "--json",
      "--cd",
      spec.repoPath,
      "--skip-git-repo-check",
      "-",
    ];
  }

  private buildPrompt(spec: WorkerSpec): string {
    const payload =
      spec.taskBundle.payload === undefined
        ? ""
        : JSON.stringify(spec.taskBundle.payload, null, 2);
    return [
      "You are a Codex worker managed by DzupAgent fleet orchestration.",
      `Worker ID: ${spec.workerId}`,
      `Repo: ${spec.repo.name}`,
      `Repo path: ${spec.repoPath}`,
      `Task ID: ${spec.taskBundle.id}`,
      "",
      "Task:",
      spec.taskBundle.description || spec.taskBundle.id,
      "",
      "Payload:",
      payload || "{}",
      "",
      "Report progress through normal Codex JSONL events and finish with a concise final answer.",
    ].join("\n");
  }
}
