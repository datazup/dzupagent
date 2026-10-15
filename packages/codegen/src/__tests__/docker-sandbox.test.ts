import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync, statSync } from "node:fs";

// SEC-H-02 regression suite for DockerSandbox argv execution.
//
// We mock `node:child_process.execFile` so we can capture the exact argv the
// sandbox would hand to the real `docker` binary. For argv-mode runs, the mock
// echoes back the literal arguments the way a real `echo` (NO shell) would —
// without performing any `$(...)`, glob, or `;` expansion — proving that shell
// metacharacters are passed through literally.
const calls: string[][] = [];
// Env files captured at the moment `docker run --env-file` is invoked.
const envFiles: Array<{ path: string; content: string; mode: number }> = [];

/** Fake `docker exec` child that only ends when killed. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith: string | undefined;
  kill(signal?: string): boolean {
    this.killedWith = signal;
    setImmediate(() => this.emit("close", null));
    return true;
  }
}
const spawned: Array<{ file: string; args: string[]; child: FakeChild }> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (file: string, args: string[]) => {
      const child = new FakeChild();
      spawned.push({ file, args, child });
      return child as never;
    },
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: unknown, res: { stdout: string; stderr: string }) => void
    ) => {
      calls.push([file, ...args]);

      const envIdx = args.indexOf("--env-file");
      if (envIdx !== -1) {
        const envPath = args[envIdx + 1]!;
        envFiles.push({
          path: envPath,
          content: readFileSync(envPath, "utf-8"),
          mode: statSync(envPath).mode & 0o777,
        });
      }

      // Simulate execFile's timeout: the local docker client is killed while
      // the (one-shot) container would keep running.
      if (args.includes("sleep") && args.includes("600")) {
        cb(
          Object.assign(new Error("Command failed: timeout"), {
            killed: true,
            code: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "",
          }),
          { stdout: "", stderr: "" }
        );
        return {} as never;
      }

      // Simulate `docker run ... -- echo <literal...>`: emit the literal args
      // joined by spaces, exactly as `echo` (no shell) would, WITHOUT
      // performing any `$(...)`/glob/`;` expansion.
      let stdout = "";
      const sep = args.indexOf("--");
      if (sep !== -1 && args[sep + 1] === "echo") {
        stdout = args.slice(sep + 2).join(" ") + "\n";
      }
      cb(null, { stdout, stderr: "" });
      return {} as never;
    },
  };
});

// Import AFTER the mock is registered so the module under test binds the mock.
const { DockerSandbox } = await import("../sandbox/docker-sandbox.js");

/**
 * Read a recorded `docker` invocation. Fails with a message that names the
 * missing call instead of throwing a bare TypeError on `undefined`.
 */
function invocation(index: number): string[] {
  const recorded = calls[index];
  if (!recorded) {
    throw new Error(
      `expected a docker invocation at index ${index}, but only ${calls.length} were recorded`
    );
  }
  return recorded;
}

describe("DockerSandbox argv execution (SEC-H-02)", () => {
  let sandbox: InstanceType<typeof DockerSandbox>;

  beforeEach(async () => {
    calls.length = 0;
    envFiles.length = 0;
    spawned.length = 0;
    sandbox = new DockerSandbox();
    await sandbox.uploadFiles({ "init.txt": "init" });
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("does not shell-expand $(whoami) when passed as an argv element", async () => {
    const result = await sandbox.execute(["echo", "$(whoami)"]);
    // The literal string is echoed back, NOT the resolved username.
    expect(result.stdout.trim()).toBe("$(whoami)");
    expect(result.exitCode).toBe(0);
  });

  it('does not interpret "; rm -rf /" as a command separator', async () => {
    await sandbox.execute(["echo", "safe; rm -rf /"]);
    const dockerArgs = invocation(0);
    // The entire dangerous string is a single, independent argv element.
    expect(dockerArgs).toContain("safe; rm -rf /");
    // It is NOT wrapped in `sh -c`.
    expect(dockerArgs).not.toContain("sh");
    expect(dockerArgs).not.toContain("-c");
  });

  it("passes each argv element as an independent docker argument", async () => {
    await sandbox.execute(["node", "-e", "console.log(1)"]);
    const dockerArgs = invocation(0);
    const sep = dockerArgs.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    // Elements after `--` match argv positionally — none merged or split.
    expect(dockerArgs.slice(sep + 1)).toEqual(["node", "-e", "console.log(1)"]);
  });

  it("uses the -- terminator and no sh -c in argv mode", async () => {
    await sandbox.execute(["ls", "-la"]);
    const dockerArgs = invocation(0);
    expect(dockerArgs).toContain("--");
    expect(dockerArgs).not.toContain("sh");
  });

  it("includes the secure flag matrix in the docker invocation", async () => {
    await sandbox.execute(["echo", "hi"]);
    const dockerArgs = invocation(0);
    expect(dockerArgs).toContain("--network=none");
    expect(dockerArgs).toContain("--pull=never");
    expect(dockerArgs).toContain("--security-opt=no-new-privileges");
    expect(dockerArgs).toContain("--read-only");
    expect(dockerArgs).toContain("--cap-drop=ALL");
    expect(dockerArgs.some((a) => a.startsWith("--tmpfs=/tmp"))).toBe(true);
    // Docker refuses duplicate mount destinations before running any checks.
    expect(dockerArgs.some((a) => a.startsWith("--tmpfs=/work"))).toBe(false);
    expect(dockerArgs.filter((a) => a.endsWith(":/work:ro"))).toHaveLength(1);
    expect(dockerArgs).toContain(`--user=${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
  });

  it("still supports legacy string commands via explicit sh -c", async () => {
    await sandbox.execute("echo hi");
    const dockerArgs = invocation(0);
    // Backward-compat: a string opts into the shell path.
    expect(dockerArgs).toContain("sh");
    expect(dockerArgs).toContain("-c");
    expect(dockerArgs).toContain("echo hi");
    // The shell path does NOT use the argv `--` terminator.
    expect(dockerArgs).not.toContain("--");
  });

  it("drops network and adds cap-drop in secure session args too", async () => {
    await sandbox.startSession();
    const sessionArgs = invocation(0);
    expect(sessionArgs).toContain("--network=none");
    expect(sessionArgs).toContain("--cap-drop=ALL");
    expect(sessionArgs).toContain("--security-opt=no-new-privileges");
  });
});

/** The isolation flags between the container name and `-w`. */
function isolationFlags(dockerArgs: string[], nameValue: string): string[] {
  const start = dockerArgs.indexOf(nameValue) + 1;
  const end = dockerArgs.indexOf("-w");
  return dockerArgs.slice(start, end).filter((a) => a !== "--env-file" && !a.endsWith(".env"));
}

describe("DockerSandbox secure session args (SEC-M-57)", () => {
  let sandbox: InstanceType<typeof DockerSandbox>;

  beforeEach(async () => {
    calls.length = 0;
    envFiles.length = 0;
    sandbox = new DockerSandbox();
    await sandbox.uploadFiles({ "init.txt": "init" });
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("uses exactly the run-path flag matrix, with --pull=never, --user and a single /work mount", async () => {
    await sandbox.execute(["true"]);
    const { sessionId } = await sandbox.startSession();
    const runArgs = invocation(0);
    const sessionArgs = invocation(1);
    const runName = runArgs[runArgs.indexOf("--name") + 1]!;

    expect(isolationFlags(sessionArgs, sessionId)).toEqual(isolationFlags(runArgs, runName));
    expect(sessionArgs).toContain("--pull=never");
    expect(sessionArgs).toContain("--init");
    expect(sessionArgs).toContain(`--user=${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
    expect(sessionArgs.some((a) => a.startsWith("--tmpfs=/work"))).toBe(false);
    expect(sessionArgs.filter((a) => /:\/work(:|$)/.test(a))).toHaveLength(1);
    expect(sessionArgs).not.toContain("-e");
  });

  it("passes session env vars via a mode-0600 env file, never as -e argv", async () => {
    await sandbox.startSession({ envVars: { API_TOKEN: "s3cret", MODE: "a=b" } });
    const sessionArgs = invocation(0);

    expect(sessionArgs).not.toContain("-e");
    expect(sessionArgs.some((a) => a.includes("s3cret"))).toBe(false);
    expect(envFiles).toHaveLength(1);
    expect(envFiles[0]!.mode).toBe(0o600);
    expect(envFiles[0]!.content).toBe("API_TOKEN=s3cret\nMODE=a=b\n");
    // The env file lives outside the mounted upload dir and is deleted after use.
    const mount = sessionArgs.find((a) => a.endsWith(":/work:ro"))!;
    expect(envFiles[0]!.path.startsWith(mount.slice(0, -":/work:ro".length))).toBe(false);
    expect(() => statSync(envFiles[0]!.path)).toThrow();
  });

  it("rejects env var names or values an env file cannot carry safely", async () => {
    await expect(sandbox.startSession({ envVars: { "BAD-KEY": "x" } })).rejects.toThrow(
      /Invalid sandbox env var name/
    );
    await expect(sandbox.startSession({ envVars: { OK: "line\nINJECTED=1" } })).rejects.toThrow(
      /newline/
    );
    expect(calls).toHaveLength(0);
  });
});

describe("DockerSandbox timeout kills the container (SEC-M-56)", () => {
  let sandbox: InstanceType<typeof DockerSandbox>;

  beforeEach(async () => {
    calls.length = 0;
    spawned.length = 0;
    sandbox = new DockerSandbox();
    await sandbox.uploadFiles({ "init.txt": "init" });
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("names the one-shot container, adds --init, and kills + removes it on timeout before resolving", async () => {
    const result = await sandbox.execute(["sleep", "600"], { timeoutMs: 1000 });
    expect(result.timedOut).toBe(true);

    const runArgs = invocation(0);
    expect(runArgs).toContain("--init");
    const name = runArgs[runArgs.indexOf("--name") + 1]!;
    expect(name).toMatch(/^forge-run-[0-9a-f-]{36}$/);
    expect(invocation(1)).toEqual(["docker", "kill", name]);
    expect(invocation(2)).toEqual(["docker", "rm", "-f", name]);
    expect(calls).toHaveLength(3);
  });

  it("does not kill anything when the command completes", async () => {
    const result = await sandbox.execute(["echo", "ok"]);
    expect(result.timedOut).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("gives each one-shot run a distinct container name", async () => {
    await sandbox.execute(["true"]);
    await sandbox.execute(["true"]);
    const a = invocation(0);
    const b = invocation(1);
    expect(a[a.indexOf("--name") + 1]).not.toBe(b[b.indexOf("--name") + 1]);
  });

  it("kills the session container when an executeStream command times out", async () => {
    const events = [];
    for await (const event of sandbox.executeStream("forge-session-x", "sleep 600", { timeoutMs: 20 })) {
      events.push(event);
    }
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.child.killedWith).toBe("SIGKILL");
    expect(events.at(-1)).toEqual({ type: "exit", exitCode: 1, timedOut: true });
    expect(calls).toContainEqual(["docker", "kill", "forge-session-x"]);
  });
});
