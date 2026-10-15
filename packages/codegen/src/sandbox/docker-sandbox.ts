/**
 * Docker-based sandbox for running commands in an isolated container.
 * Extracted from apps/api sandbox-runner.ts and adapted to SandboxProtocol.
 *
 * Secure sandbox flags applied by default (secure/validation mode), shared by
 * one-shot runs and long-lived sessions:
 *   --network=none          no outbound network
 *   --pull=never            never pull an image implicitly
 *   --read-only             container filesystem is read-only
 *   --cap-drop ALL          no Linux capabilities
 *   --user <uid>:<gid>      run as the host owner of the upload dir, not root
 *   --tmpfs /tmp            writable temp only (size-capped)
 *   -v <upload>:/work:ro    the single /work mount (read-only)
 *   --no-new-privileges     no privilege escalation (via --security-opt)
 *   --init                  a real PID 1 that forwards signals and reaps
 *
 * Timeouts (SEC-M-56): one-shot containers are named, and on timeout the
 * container itself is killed and removed (not just the local docker client).
 * A timed-out `executeStream` command kills its session container.
 *
 * Session env vars (SEC-M-57) are passed through a mode-0600 `--env-file`
 * outside the mounted upload dir, never as `-e KEY=value` argv.
 *
 * Command execution (SEC-H-02): `execute(argv: string[])` runs the program
 * directly via `docker run ... -- argv[0] argv[1] ...` with NO `sh -c`, so
 * shell metacharacters are never interpreted and injection is impossible. A
 * `string` is still accepted for backward compatibility and runs as an
 * explicit, opt-in `sh -c <command>` shell command.
 *
 * Preview mode: When `previewMode: true`, relaxes network and filesystem
 * restrictions to allow dev-server workflows while keeping other security
 * flags (memory, cpu, no-new-privileges, cap-drop).
 *
 * Implements SandboxProtocolV2 for long-lived session management,
 * streaming execution, and port exposure.
 */

import { constants } from "node:fs";
import { withContainedFile } from "./contained-file.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecResult, ExecOptions } from "./sandbox-protocol.js";
import {
  buildDockerIsolationArgs,
  forceRemoveDockerContainer,
  killDockerContainer,
  writeDockerEnvFile,
} from "./docker-sandbox-support.js";
import type {
  SandboxProtocolV2,
  SessionOptions,
  ExecEvent,
} from "./sandbox-protocol-v2.js";

const execFileAsync = promisify(execFile);

export interface DockerSandboxConfig {
  /** Docker image to use (default: 'node:20-slim') */
  image?: string;
  /** Global timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Memory limit e.g. '512m' (default: '512m') */
  memoryLimit?: string;
  /** CPU limit e.g. '1.0' (default: '1.0') */
  cpuLimit?: string;
  /**
   * When true, relaxes network and filesystem restrictions for preview/dev
   * workflows. Network is allowed, workspace is read-write.
   * Security flags (memory, cpu, no-new-privileges) are kept.
   * Default: false (secure/validation mode).
   */
  previewMode?: boolean;
}

const DEFAULT_IMAGE = "node:20-slim";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY = "512m";
const DEFAULT_CPU = "1.0";

export class DockerSandbox implements SandboxProtocolV2 {
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;
  private readonly previewMode: boolean;
  private tempDir: string | null = null;

  constructor(config?: DockerSandboxConfig) {
    this.image = config?.image ?? DEFAULT_IMAGE;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.memoryLimit = config?.memoryLimit ?? DEFAULT_MEMORY;
    this.cpuLimit = config?.cpuLimit ?? DEFAULT_CPU;
    this.previewMode = config?.previewMode ?? false;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("docker", ["info"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async uploadFiles(files: Record<string, string>): Promise<void> {
    if (!this.tempDir) {
      this.tempDir = await mkdtemp(join(tmpdir(), "forge-sandbox-"));
    }
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = this.safePath(filePath);
      await withContainedFile(this.tempDir, fullPath, true, constants.O_WRONLY | constants.O_CREAT, async file => {
        await file.truncate(0);
        await file.writeFile(content, "utf-8");
      });
    }
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    if (!this.tempDir) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const filePath of paths) {
      const fullPath = this.safePath(filePath);
      try {
        result[filePath] = await withContainedFile(this.tempDir, fullPath, false, constants.O_RDONLY, file => file.readFile("utf-8"));
      } catch (error) {
        if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        // File does not exist or not readable — skip
      }
    }
    return result;
  }

  /**
   * Execute a command in a one-shot container.
   *
   * SECURITY (SEC-H-02): Prefer passing `command` as a `string[]` argv. Each
   * element is forwarded to Docker as a separate, independent argument and the
   * program is invoked directly (no `sh -c`), so shell metacharacters such as
   * `$(whoami)`, `;`, `|`, backticks, and globs are NOT interpreted — they are
   * passed literally to the program. This eliminates shell injection even when
   * caller-controlled input is interpolated into argv elements.
   *
   * Backward compatibility: a single `string` is still accepted to satisfy the
   * `SandboxProtocol` interface. A string is treated as an explicit, opt-in
   * shell command and runs via `sh -c <command>`; callers passing a string are
   * responsible for ensuring no untrusted input reaches it.
   *
   * @example
   * // Safe — `$(whoami)` is printed literally, never expanded:
   * await sandbox.execute(['echo', '$(whoami)'])
   */
  async execute(
    command: string | string[],
    options?: ExecOptions
  ): Promise<ExecResult> {
    if (!this.tempDir) {
      this.tempDir = await mkdtemp(join(tmpdir(), "forge-sandbox-"));
    }

    const timeout = options?.timeoutMs ?? this.timeoutMs;
    const cwd = options?.cwd ?? "/work";
    const containerName = `forge-run-${randomUUID()}`;
    const dockerArgs = this.buildRunArgs(cwd, command, containerName);

    let timedOut = false;
    try {
      const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr, timedOut: false };
    } catch (err: unknown) {
      const execErr = err as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      if (execErr.killed === true) {
        timedOut = true;
        // Killing the docker CLI client does not stop the container: kill and
        // remove it by name before reporting the timeout (SEC-M-56).
        await forceRemoveDockerContainer(containerName);
      }
      return {
        exitCode: typeof execErr.code === "number" ? execErr.code : 1,
        stdout: execErr.stdout ?? "",
        stderr: execErr.stderr ?? "",
        timedOut,
      };
    }
  }

  async cleanup(): Promise<void> {
    if (this.tempDir) {
      await rm(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
    }
  }

  // ---------------------------------------------------------------------------
  // SandboxProtocolV2 — session management
  // ---------------------------------------------------------------------------

  async startSession(opts?: SessionOptions): Promise<{ sessionId: string }> {
    if (!this.tempDir) {
      this.tempDir = await mkdtemp(join(tmpdir(), "forge-sandbox-"));
    }

    const sessionId = `forge-session-${randomUUID()}`;
    const timeout = opts?.timeoutMs ?? this.timeoutMs;

    const envDir = await writeDockerEnvFile(opts?.envVars);
    const envFile = envDir ? join(envDir, "session.env") : undefined;
    const dockerArgs = this.buildSessionArgs(sessionId, envFile);

    try {
      // Start a detached container that stays alive
      await execFileAsync("docker", dockerArgs, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
    } finally {
      // The docker client reads --env-file before creating the container.
      if (envDir) {
        await rm(envDir, { recursive: true, force: true });
      }
    }

    return { sessionId };
  }

  async *executeStream(
    sessionId: string,
    command: string,
    opts?: ExecOptions
  ): AsyncGenerator<ExecEvent> {
    const timeout = opts?.timeoutMs ?? this.timeoutMs;
    const cwd = opts?.cwd ?? "/work";

    const child = spawn("docker", [
      "exec",
      "-w",
      cwd,
      sessionId,
      "sh",
      "-c",
      command,
    ]);

    let timedOut = false;
    let containerKill: Promise<void> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // Killing the `docker exec` client leaves the command running inside the
      // session container; kill the container itself (SEC-M-56).
      containerKill = killDockerContainer(sessionId);
    }, timeout);

    try {
      // Set encoding on streams
      if (child.stdout) {
        child.stdout.setEncoding("utf-8");
      }
      if (child.stderr) {
        child.stderr.setEncoding("utf-8");
      }

      // Collect events from both streams via a queue
      const events: ExecEvent[] = [];
      let resolveWait: (() => void) | null = null;
      let done = false;

      const push = (event: ExecEvent): void => {
        events.push(event);
        if (resolveWait) {
          const r = resolveWait;
          resolveWait = null;
          r();
        }
      };

      child.stdout?.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.length > 0) {
            push({ type: "stdout", data: line });
          }
        }
      });

      child.stderr?.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.length > 0) {
            push({ type: "stderr", data: line });
          }
        }
      });

      child.on("close", (code) => {
        push({ type: "exit", exitCode: code ?? 1, timedOut });
        done = true;
      });

      child.on("error", () => {
        push({ type: "exit", exitCode: 1, timedOut });
        done = true;
      });

      // Yield events as they arrive
      while (!done || events.length > 0) {
        if (events.length > 0) {
          yield events.shift()!;
        } else if (!done) {
          await new Promise<void>((r) => {
            resolveWait = r;
          });
        }
      }
    } finally {
      clearTimeout(timer);
      if (containerKill) {
        await containerKill;
      }
    }
  }

  async exposePort(_sessionId: string, port: number): Promise<{ url: string }> {
    // For local Docker, the container port is accessible on localhost
    // when not in --network=none mode (i.e. previewMode is true).
    // Full port-mapping support would require -p flags at startSession time;
    // for now, return the direct localhost URL.
    return { url: `http://localhost:${port}` };
  }

  async stopSession(sessionId: string): Promise<void> {
    try {
      await execFileAsync("docker", ["stop", sessionId], { timeout: 15_000 });
    } catch {
      // Container may already be stopped
    }
    try {
      await execFileAsync("docker", ["rm", sessionId], { timeout: 10_000 });
    } catch {
      // Container may already be removed
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve a relative path within the temp directory, guarding against
   * path traversal attacks (e.g. `../etc/passwd`, absolute paths).
   */
  private safePath(relativePath: string): string {
    const base = resolve(this.tempDir!);
    const resolved = resolve(base, relativePath);
    if (resolved !== base && !resolved.startsWith(base + "/")) {
      throw new Error(
        `Path traversal detected: "${relativePath}" resolves outside sandbox directory`
      );
    }
    return resolved;
  }

  private isolationArgs(): string[] {
    return buildDockerIsolationArgs({
      memoryLimit: this.memoryLimit,
      cpuLimit: this.cpuLimit,
      previewMode: this.previewMode,
      uploadDir: this.tempDir,
    });
  }

  /**
   * Build docker run args for one-shot execution: a named container (so a
   * timeout can kill it) with the shared isolation flags.
   *
   * SECURITY (SEC-H-02): When `command` is a `string[]`, the program is invoked
   * directly as `<image> argv[0] argv[1] ...` after a `--` terminator, with no
   * `sh -c`, so each element is an independent argument and shell
   * metacharacters are never interpreted. A `string` falls back to the legacy
   * `sh -c <command>` explicit-shell path.
   */
  private buildRunArgs(
    cwd: string,
    command: string | string[],
    containerName: string
  ): string[] {
    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      ...this.isolationArgs(),
    ];

    args.push("-w", cwd, this.image);

    if (Array.isArray(command)) {
      // Safe argv mode: invoke the program directly, no shell. Each element is
      // passed as a distinct argument — `$(...)`, `;`, `|`, backticks, and
      // globs are NOT expanded. The `--` terminator stops Docker from
      // interpreting any leading argv element as a docker flag.
      args.push("--", ...command);
    } else {
      // Legacy explicit-shell mode: caller opted into shell interpretation.
      args.push("sh", "-c", command);
    }

    return args;
  }

  /**
   * Build docker run args for a long-lived session container with the same
   * isolation flags as one-shot runs. Uses `tail -f /dev/null` to keep the
   * container alive. Env vars arrive only through `envFile`.
   */
  private buildSessionArgs(sessionId: string, envFile?: string): string[] {
    const args = [
      "run",
      "-d",
      "--name",
      sessionId,
      ...this.isolationArgs(),
    ];

    if (envFile) {
      args.push("--env-file", envFile);
    }

    args.push("-w", "/work", this.image, "tail", "-f", "/dev/null");
    return args;
  }
}
