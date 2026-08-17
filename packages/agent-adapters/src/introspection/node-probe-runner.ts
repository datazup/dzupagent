import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpath as nodeRealpath, stat as nodeStat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import {
  digestExecutableArtifact,
  validExecutableArtifactDigest,
} from "./executable-artifact.js";
import {
  DEFAULT_PROBE_KILL_GRACE_MS,
  DEFAULT_PROBE_OUTPUT_BYTES,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_TOTAL_DURATION_MS,
  buildProbeEnv,
  createInternalSafeProbeRunner,
  redactProbeText,
  type ProbeCommand,
  type ProbeCommandRunner,
  type ProbeFailureClassification,
  type ProbeResult,
  type SafeProbeCommandRunner,
} from "./probe-runner.js";

/** Immutable executable identity established by trusted discovery code. */
export interface ResolvedProbeExecutable {
  /** Logical name inspectors use, for example `claude`. */
  name: string;
  /** Absolute path passed to spawn. PATH lookup is never used at execution time. */
  path: string;
  /** Canonical path captured during discovery and checked before every spawn. */
  realPath: string;
  /** SHA-256 of the executable bytes captured by trusted discovery. */
  artifactDigest: string;
}

export interface ProbeRunnerLimits {
  maxOutputBytes: number;
  maxDurationMs: number;
  killGraceMs: number;
}

export interface ProbeCapture {
  command: string;
  stdout: string;
  stderr: string;
  failure?: ProbeFailureClassification;
  truncated: boolean;
  durationMs: number;
}

export interface NodeProbeRunnerPorts {
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  realpath?: (path: string) => Promise<string>;
  statDirectory?: (path: string) => Promise<boolean>;
  digestArtifact?: (path: string) => Promise<string>;
  killProcessTree?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  nowMs?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  redact?: (text: string) => string;
  /**
   * Declared as returning plain `void`, deliberately — not
   * `void | Promise<void>`.
   *
   * TypeScript's void-returning-function leniency lets a callback that returns
   * a value satisfy a `=> void` position, so
   * `capture: (c) => captures.push(c)` type-checks even though `push` returns
   * `number`. That leniency does not survive a union: under
   * `=> void | Promise<void>` the same expression is rejected with TS2322, so
   * the union that reads as the more permissive signature is in fact the
   * stricter one for every fixture that supplies this port.
   *
   * `void` still accepts `async` captures, and `captureResult` awaits what the
   * port actually returned, so a rejected async capture is still classified as
   * `capture-error`.
   */
  capture?: (capture: ProbeCapture) => void;
  platform?: NodeJS.Platform;
}

export interface NodeProbeRunnerOptions {
  executables: readonly ResolvedProbeExecutable[];
  managedHome: string;
  /** Mandatory working directory; probes never inherit the host process cwd. */
  cwd: string;
  sourceEnv?: Record<string, string | undefined>;
  /** Limits may tighten, but never exceed, the framework safety ceilings. */
  limits?: Partial<ProbeRunnerLimits>;
}

const FAILURE_MARKERS: Record<ProbeFailureClassification, string> = {
  "missing-binary": "[probe:missing-binary]",
  "executable-identity-mismatch": "[probe:executable-identity-mismatch]",
  "invalid-policy": "[probe:invalid-policy]",
  timeout: "[probe:timeout]",
  "output-limit": "[probe:output-limit]",
  "invalid-encoding": "[probe:invalid-encoding]",
  "spawn-error": "[probe:spawn-error]",
  "exit-nonzero": "[probe:exit-nonzero]",
  "signal-exit": "[probe:signal-exit]",
  "capture-error": "[probe:capture-error]",
};

/**
 * Create the framework-owned process boundary for installation probes.
 *
 * The runner accepts logical executable names but spawns only canonical,
 * pre-resolved absolute paths. It never inherits cwd, HOME, credentials, stdin,
 * a TTY, or shell parsing from the host process.
 */
export function createNodeProbeRunner(
  options: NodeProbeRunnerOptions,
): SafeProbeCommandRunner {
  return createNodeProbeRunnerWithPorts(options, {});
}

/** Establish a canonical, byte-bound executable identity for probe callers. */
export async function resolveNodeProbeExecutable(
  name: string,
  path: string,
): Promise<ResolvedProbeExecutable> {
  if (!name.trim() || !isAbsolute(path)) {
    throw new Error("Probe executable name and absolute path are required");
  }
  const realPath = await nodeRealpath(path);
  const executableStat = await nodeStat(realPath);
  if (!executableStat.isFile()) throw new Error("Probe executable must be a regular file");
  return {
    name,
    path,
    realPath,
    artifactDigest: await digestExecutableArtifact(realPath),
  };
}

/** @internal Fixture-only construction port; absent from public package exports. */
export function createNodeProbeRunnerForTesting(
  options: NodeProbeRunnerOptions & { ports?: NodeProbeRunnerPorts },
): SafeProbeCommandRunner {
  const { ports = {}, ...safeOptions } = options;
  return createNodeProbeRunnerWithPorts(safeOptions, ports);
}

function createNodeProbeRunnerWithPorts(
  options: NodeProbeRunnerOptions,
  ports: NodeProbeRunnerPorts,
): SafeProbeCommandRunner {
  const identities = new Map(options.executables.map((item) => [item.name, item]));
  const limits: ProbeRunnerLimits = {
    maxOutputBytes: options.limits?.maxOutputBytes ?? DEFAULT_PROBE_OUTPUT_BYTES,
    maxDurationMs: options.limits?.maxDurationMs ?? DEFAULT_PROBE_TOTAL_DURATION_MS,
    killGraceMs: options.limits?.killGraceMs ?? DEFAULT_PROBE_KILL_GRACE_MS,
  };
  const spawn = ports.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions));
  const resolveRealPath = ports.realpath ?? nodeRealpath;
  const statDirectory = ports.statDirectory ?? (async (path) => (await nodeStat(path)).isDirectory());
  const digestArtifact = ports.digestArtifact ?? digestExecutableArtifact;
  const nowMs = ports.nowMs ?? Date.now;
  const setTimer = ports.setTimer ?? setTimeout;
  const clearTimer = ports.clearTimer ?? clearTimeout;
  const redact = ports.redact ?? redactProbeText;
  const platform = ports.platform ?? process.platform;
  const env = buildProbeEnv({ source: options.sourceEnv ?? process.env, managedHome: options.managedHome });
  const deadlineExceeded = Symbol("probe-deadline-exceeded");

  const runner: ProbeCommandRunner = async (request: ProbeCommand): Promise<ProbeResult> => {
    const startedAt = nowMs();
    const identity = identities.get(request.command);
    if (
      !validLimits(limits) ||
      !identity ||
      !validIdentity(identity) ||
      !isAbsolute(options.cwd) ||
      !isAbsolute(options.managedHome)
    ) {
      return finishWithoutProcess("invalid-policy", startedAt, request);
    }

    let actualRealPath: string;
    try {
      actualRealPath = await withinBudget(resolveRealPath(identity.path), startedAt);
    } catch (error) {
      if (error === deadlineExceeded) return finishWithoutProcess("timeout", startedAt, request);
      const code = (error as NodeJS.ErrnoException).code;
      return finishWithoutProcess(code === "ENOENT" ? "missing-binary" : "executable-identity-mismatch", startedAt, request);
    }
    if (actualRealPath !== identity.realPath) {
      return finishWithoutProcess("executable-identity-mismatch", startedAt, request);
    }
    try {
      const actualDigest = await withinBudget(digestArtifact(actualRealPath), startedAt);
      if (actualDigest !== identity.artifactDigest) {
        return finishWithoutProcess("executable-identity-mismatch", startedAt, request);
      }
    } catch (error) {
      if (error === deadlineExceeded) return finishWithoutProcess("timeout", startedAt, request);
      return finishWithoutProcess("executable-identity-mismatch", startedAt, request);
    }

    try {
      if (!(await withinBudget(statDirectory(options.cwd), startedAt))) {
        return finishWithoutProcess("invalid-policy", startedAt, request);
      }
    } catch (error) {
      if (error === deadlineExceeded) return finishWithoutProcess("timeout", startedAt, request);
      return finishWithoutProcess("invalid-policy", startedAt, request);
    }

    return runChild(identity.realPath, request, startedAt);
  };

  async function finishWithoutProcess(
    failure: ProbeFailureClassification,
    startedAt: number,
    request: ProbeCommand
  ): Promise<ProbeResult> {
    return captureResult(
      {
        exitCode: null,
        stdout: "",
        stderr: FAILURE_MARKERS[failure],
        timedOut: failure === "timeout",
        spawnFailed: true,
        failure,
        truncated: false,
        durationMs: elapsed(startedAt),
      },
      request
    );
  }

  async function runChild(
    executablePath: string,
    request: ProbeCommand,
    startedAt: number
  ): Promise<ProbeResult> {
    let child: ChildProcess;
    try {
      child = spawn(executablePath, request.args, {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
        windowsHide: true,
        shell: false,
      });
    } catch {
      return finishWithoutProcess("spawn-error", startedAt, request);
    }

    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let outputBytes = 0;
    let termination: "timeout" | "output-limit" | undefined;
    let termSent = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let forceSettle: (code: number | null, signal: NodeJS.Signals | null) => void = () => undefined;

    const append = (current: Buffer, chunk: Buffer | string): Buffer => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, limits.maxOutputBytes - outputBytes);
      outputBytes += bytes.byteLength;
      if (bytes.byteLength > remaining) terminate("output-limit");
      return remaining === 0 ? current : Buffer.concat([current, bytes.subarray(0, remaining)]);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = append(stderr, chunk);
    });

    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (ports.killProcessTree) ports.killProcessTree(child, signal);
        else defaultKillProcessTree(child, signal, platform);
      } catch {
        // Signal races must not replace the stable termination classification.
      }
    };

    const terminate = (reason: "timeout" | "output-limit"): void => {
      termination ??= reason;
      if (termSent || settled) return;
      termSent = true;
      killTree("SIGTERM");
      const remainingTotal = Math.max(0, limits.maxDurationMs - elapsed(startedAt));
      escalation = setTimer(() => {
        if (!settled) killTree("SIGKILL");
        forceSettle(null, "SIGKILL");
      }, Math.min(limits.killGraceMs, remainingTotal));
      escalation.unref?.();
    };

    const requestedTimeout = request.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const remainingDuration = Math.max(1, limits.maxDurationMs - elapsed(startedAt));
    const timeoutMs = Math.min(Math.max(1, requestedTimeout), remainingDuration);

    return new Promise<ProbeResult>((resolve) => {
      const settleAndResolve = async (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): Promise<void> => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimer(timeout);
        if (escalation) clearTimer(escalation);

        let failure: ProbeFailureClassification | undefined = termination;
        if (!failure && spawnError) {
          failure = (spawnError as NodeJS.ErrnoException).code === "ENOENT" ? "missing-binary" : "spawn-error";
        } else if (!failure && signal) failure = "signal-exit";
        else if (!failure && code !== 0) failure = "exit-nonzero";

        const decodedStdout = decodeUtf8(stdout);
        const decodedStderr = decodeUtf8(stderr);
        if (!failure && (decodedStdout === null || decodedStderr === null)) {
          failure = "invalid-encoding";
        }

        const safeStdout = decodedStdout ?? "";
        const safeStderr = decodedStderr ?? "";
        const stableStderr = failure ? FAILURE_MARKERS[failure] : redact(safeStderr);
        const stdoutValue = failure
          ? boundText(
              redact(safeStdout),
              Math.max(0, limits.maxOutputBytes - Buffer.byteLength(stableStderr))
            )
          : boundText(redact(safeStdout), limits.maxOutputBytes);
        const stderrValue = failure
          ? boundText(stableStderr, limits.maxOutputBytes)
          : boundText(
              stableStderr,
              Math.max(0, limits.maxOutputBytes - Buffer.byteLength(stdoutValue))
            );
        const result: ProbeResult = {
          exitCode: code,
          stdout: stdoutValue,
          stderr: stderrValue,
          timedOut: failure === "timeout",
          spawnFailed: failure === "missing-binary" || failure === "spawn-error",
          failure,
          truncated: failure === "output-limit",
          durationMs: elapsed(startedAt),
        };
        resolve(await captureResult(result, request));
      };
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        void settleAndResolve(code, signal);
      };
      forceSettle = settle;

      child.once("close", settle);
      child.once("error", (error: Error) => {
        void settleAndResolve(null, null, error);
      });
      // Keep a persistent listener so a post-spawn error cannot crash the host.
      child.on("error", () => undefined);
      timeout = setTimer(() => terminate("timeout"), timeoutMs);
      timeout.unref?.();
    });
  }

  async function captureResult(result: ProbeResult, request: ProbeCommand): Promise<ProbeResult> {
    // `capture` is declared `(capture) => void` so fixtures can supply an
    // expression-bodied arrow; read through a widened view here because the
    // await below is what turns a rejected async capture into `capture-error`.
    const capture: ((capture: ProbeCapture) => unknown) | undefined = ports.capture;
    if (!capture) return result;
    try {
      await capture({
        command: request.command,
        stdout: result.stdout,
        stderr: result.stderr,
        failure: result.failure,
        truncated: result.truncated ?? false,
        durationMs: result.durationMs ?? 0,
      });
      return result;
    } catch {
      return {
        ...result,
        stderr: FAILURE_MARKERS["capture-error"],
        failure: "capture-error",
      };
    }
  }

  function elapsed(startedAt: number): number {
    return Math.max(0, nowMs() - startedAt);
  }

  async function withinBudget<T>(operation: Promise<T>, startedAt: number): Promise<T> {
    const remaining = limits.maxDurationMs - elapsed(startedAt);
    if (remaining <= 0) throw deadlineExceeded;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimer(() => reject(deadlineExceeded), remaining);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimer(timer);
    }
  }

  return createInternalSafeProbeRunner(runner);
}

function validIdentity(identity: ResolvedProbeExecutable): boolean {
  return Boolean(identity.name.trim())
    && isAbsolute(identity.path)
    && isAbsolute(identity.realPath)
    && validExecutableArtifactDigest(identity.artifactDigest);
}

function validLimits(limits: ProbeRunnerLimits): boolean {
  return (
    Number.isSafeInteger(limits.maxOutputBytes) &&
    limits.maxOutputBytes > 0 &&
    limits.maxOutputBytes <= DEFAULT_PROBE_OUTPUT_BYTES &&
    Number.isSafeInteger(limits.maxDurationMs) &&
    limits.maxDurationMs > 0 &&
    limits.maxDurationMs <= DEFAULT_PROBE_TOTAL_DURATION_MS &&
    Number.isSafeInteger(limits.killGraceMs) &&
    limits.killGraceMs >= 0 &&
    limits.killGraceMs <= DEFAULT_PROBE_KILL_GRACE_MS
  );
}

function defaultKillProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform
): void {
  if (platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
    return;
  }
  if (platform === "win32" && child.pid) {
    nodeSpawn("taskkill", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    }).unref();
    return;
  }
  child.kill(signal);
}

function boundText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;

  let end = Math.max(0, maxBytes);
  while (end > 0) {
    const decoded = decodeUtf8(bytes.subarray(0, end));
    if (decoded !== null) return decoded;
    end -= 1;
  }
  return "";
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
