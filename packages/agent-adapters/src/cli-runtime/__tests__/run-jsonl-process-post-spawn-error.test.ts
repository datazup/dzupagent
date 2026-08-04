/**
 * ERR-C-08 regression suite.
 *
 * `waitForSpawn` attaches the ChildProcess 'error' listener with `once`, so it
 * is consumed the moment spawn settles. An 'error' emitted afterwards (EPERM
 * from `kill`, stdio teardown, stdin EPIPE) therefore had NO listener, and Node
 * escalates an unlistened ChildProcess 'error' to an uncaught exception —
 * killing the host process. Every CLI adapter (claude/codex/gemini/qwen/crush/
 * goose) routes through `runJsonlProcess`, and the package installs no
 * `uncaughtException` net.
 *
 * These tests assert the host survives and the run fails cleanly instead.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { runJsonlProcess } from "../run-jsonl-process.js";

type InjectedChild = ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
};

function createInjectedChild(): InjectedChild {
  const child = new EventEmitter() as InjectedChild & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    pid: number;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = Math.floor(Math.random() * 10_000) + 1;
  child.kill = vi.fn();
  return child;
}

async function collect(
  iterable: AsyncIterable<Record<string, unknown>>
): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("ERR-C-08 — post-spawn ChildProcess 'error'", () => {
  it("keeps a persistent 'error' listener after spawn resolves", async () => {
    const child = createInjectedChild();

    const generator = runJsonlProcess(
      { command: "mock-cli", args: [] },
      {
        spawn: (
          _command: string,
          _args: readonly string[],
          _options: SpawnOptions
        ) => child,
      }
    );

    // Drive the generator far enough that spawn has settled.
    const first = generator.next();
    child.stdout.write('{"event":"first"}\n');
    await expect(first).resolves.toMatchObject({
      done: false,
      value: { event: "first" },
    });

    // Before the fix this count was 0 once spawn settled, so the emit below
    // would have thrown ERR_UNHANDLED_ERROR and killed the process.
    expect(child.listenerCount("error")).toBeGreaterThan(0);

    // Emitting must NOT throw synchronously into this test (i.e. no uncaught
    // exception path); the run must fail cleanly instead.
    expect(() =>
      child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }))
    ).not.toThrow();

    // Stream teardown follows the error, as it would for a real child.
    child.stdout.end();
    child.stderr.end();
    child.exitCode = 0;
    child.emit("close", 0, null);

    await expect(generator.next()).rejects.toMatchObject({
      code: "ADAPTER_EXECUTION_FAILED",
    });
  });

  it("fails the run cleanly when the child errors after a successful stream", async () => {
    const child = createInjectedChild();

    const run = collect(
      runJsonlProcess(
        { command: "mock-cli", args: [] },
        {
          spawn: (
            _command: string,
            _args: readonly string[],
            _options: SpawnOptions
          ) => child,
        }
      )
    );

    // Let the generator reach the stdout loop before emitting.
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write('{"event":"one"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    child.emit("error", Object.assign(new Error("stdio teardown"), { code: "EPIPE" }));
    child.stdout.end();
    child.stderr.end();
    child.exitCode = 0;
    child.emit("close", 0, null);

    await expect(run).rejects.toMatchObject({
      code: "ADAPTER_EXECUTION_FAILED",
    });
  });

  it("attaches an 'error' listener to child stdin", async () => {
    const child = createInjectedChild();

    const generator = runJsonlProcess(
      { command: "mock-cli", args: [] },
      {
        spawn: (
          _command: string,
          _args: readonly string[],
          _options: SpawnOptions
        ) => child,
      }
    );

    const first = generator.next();
    child.stdout.write('{"event":"first"}\n');
    await first;

    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
    ).not.toThrow();

    await generator.return(undefined);
  });
});
