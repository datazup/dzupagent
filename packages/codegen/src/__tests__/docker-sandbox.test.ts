import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";

// SEC-H-02 regression suite for DockerSandbox argv execution.
//
// We mock `node:child_process.execFile` so we can capture the exact argv the
// sandbox would hand to the real `docker` binary. For argv-mode runs, the mock
// echoes back the literal arguments the way a real `echo` (NO shell) would —
// without performing any `$(...)`, glob, or `;` expansion — proving that shell
// metacharacters are passed through literally.
const calls: string[][] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: unknown, res: { stdout: string; stderr: string }) => void
    ) => {
      calls.push([file, ...args]);

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

describe("DockerSandbox argv execution (SEC-H-02)", () => {
  let sandbox: InstanceType<typeof DockerSandbox>;

  beforeEach(async () => {
    calls.length = 0;
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
    const dockerArgs = calls[0];
    // The entire dangerous string is a single, independent argv element.
    expect(dockerArgs).toContain("safe; rm -rf /");
    // It is NOT wrapped in `sh -c`.
    expect(dockerArgs).not.toContain("sh");
    expect(dockerArgs).not.toContain("-c");
  });

  it("passes each argv element as an independent docker argument", async () => {
    await sandbox.execute(["node", "-e", "console.log(1)"]);
    const dockerArgs = calls[0];
    const sep = dockerArgs.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    // Elements after `--` match argv positionally — none merged or split.
    expect(dockerArgs.slice(sep + 1)).toEqual(["node", "-e", "console.log(1)"]);
  });

  it("uses the -- terminator and no sh -c in argv mode", async () => {
    await sandbox.execute(["ls", "-la"]);
    const dockerArgs = calls[0];
    expect(dockerArgs).toContain("--");
    expect(dockerArgs).not.toContain("sh");
  });

  it("includes the secure flag matrix in the docker invocation", async () => {
    await sandbox.execute(["echo", "hi"]);
    const dockerArgs = calls[0];
    expect(dockerArgs).toContain("--network=none");
    expect(dockerArgs).toContain("--security-opt=no-new-privileges");
    expect(dockerArgs).toContain("--read-only");
    expect(dockerArgs).toContain("--cap-drop=ALL");
    expect(dockerArgs.some((a) => a.startsWith("--tmpfs=/tmp"))).toBe(true);
  });

  it("still supports legacy string commands via explicit sh -c", async () => {
    await sandbox.execute("echo hi");
    const dockerArgs = calls[0];
    // Backward-compat: a string opts into the shell path.
    expect(dockerArgs).toContain("sh");
    expect(dockerArgs).toContain("-c");
    expect(dockerArgs).toContain("echo hi");
    // The shell path does NOT use the argv `--` terminator.
    expect(dockerArgs).not.toContain("--");
  });

  it("drops network and adds cap-drop in secure session args too", async () => {
    await sandbox.startSession();
    const sessionArgs = calls[0];
    expect(sessionArgs).toContain("--network=none");
    expect(sessionArgs).toContain("--cap-drop=ALL");
    expect(sessionArgs).toContain("--security-opt=no-new-privileges");
  });
});
