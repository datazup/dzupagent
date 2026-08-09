/**
 * Probe execution primitives for adapter installation inspection
 * (spec doc 05 §4 probe discipline).
 *
 * Probes run against *someone else's* installed software, often on a host we
 * do not own. The discipline is therefore conservative by construction:
 *
 * - `shell: false` always — argv arrays, never concatenated strings, so a path
 *   containing a space or a `;` cannot become a second command.
 * - Every probe is timed out and killed; a hung CLI must not hang the prober.
 * - The child environment is an explicit allowlist, never `process.env`, so a
 *   probe cannot leak our credentials into a third-party binary.
 * - HOME/XDG are redirected to a managed directory so a probe can never write
 *   into a real user profile.
 *
 * Inspectors accept only a framework-branded runner. Process-free fixtures are
 * admitted through an internal test port that is deliberately absent from the
 * package's public exports.
 */

/** Outcome of one probe invocation. */
export interface ProbeResult {
  /** Process exit code; `null` when the process was killed by a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the probe was terminated for exceeding its timeout. */
  timedOut: boolean;
  /** True when the binary could not be found or executed at all. */
  spawnFailed: boolean;
  /** Stable, redacted classification. Raw host errors are never exposed. */
  failure?: ProbeFailureClassification;
  /** True when either output stream exceeded the capture budget. */
  truncated?: boolean;
  /** Monotonic elapsed time reported by the runner. */
  durationMs?: number;
}

export type ProbeFailureClassification =
  | "missing-binary"
  | "executable-identity-mismatch"
  | "invalid-policy"
  | "timeout"
  | "output-limit"
  | "invalid-encoding"
  | "spawn-error"
  | "exit-nonzero"
  | "signal-exit"
  | "capture-error";

/** A single probe invocation request. */
export interface ProbeCommand {
  /** Logical executable name resolved through the runner's identity map. */
  command: string;
  /** argv tail. Never concatenated into the command string. */
  args: string[];
  timeoutMs?: number;
}

/**
 * Executes a probe command.
 *
 * Implementations must honor {@link ProbeCommand.timeoutMs} and must never
 * invoke a shell. Tests supply a fixture-backed implementation.
 */
export type ProbeCommandRunner = (
  command: ProbeCommand,
) => Promise<ProbeResult>;

declare const safeProbeRunnerBrand: unique symbol;

/**
 * A probe runner created by the framework-owned policy boundary.
 *
 * The private brand prevents an arbitrary callback from satisfying an
 * inspector's public constructor type. Runtime membership is checked too, so
 * untyped JavaScript callers cannot bypass policy with a lookalike function.
 */
export type SafeProbeCommandRunner = ProbeCommandRunner & {
  readonly [safeProbeRunnerBrand]: true;
};

const safeProbeRunners = new WeakSet<ProbeCommandRunner>();

/** @internal Test and framework-construction port; not re-exported publicly. */
export function createInternalSafeProbeRunner(
  runner: ProbeCommandRunner,
): SafeProbeCommandRunner {
  safeProbeRunners.add(runner);
  return runner as SafeProbeCommandRunner;
}

/** @internal Runtime enforcement used by inspector construction. */
export function isSafeProbeCommandRunner(
  runner: unknown,
): runner is SafeProbeCommandRunner {
  return typeof runner === "function" && safeProbeRunners.has(runner as ProbeCommandRunner);
}

/** Default per-probe timeout. Help output is small; slow means broken. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Default hard bounds for one process probe. */
export const DEFAULT_PROBE_OUTPUT_BYTES = 128 * 1024;
export const DEFAULT_PROBE_TOTAL_DURATION_MS = 10_000;
export const DEFAULT_PROBE_KILL_GRACE_MS = 250;

/**
 * Environment variables a probe may inherit.
 *
 * Deliberately minimal: enough for a CLI to resolve its own binary and locale,
 * and nothing that could carry a credential. Provider API-key variables are
 * excluded on purpose — a capability probe never needs to authenticate, and
 * passing one risks a metered call (NFR-3, no-spend).
 */
export const PROBE_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
];

/** Inputs for building a probe environment. */
export interface ProbeEnvOptions {
  /** Source environment, normally `process.env`. */
  source: Record<string, string | undefined>;
  /**
   * Managed HOME. All of HOME/XDG_* are pointed here so a probe cannot read or
   * write a real user profile.
   */
  managedHome: string;
}

/**
 * Build the child environment for a probe: allowlist, then managed HOME.
 *
 * Returns a fresh object; the source environment is never mutated.
 */
export function buildProbeEnv(
  options: ProbeEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of PROBE_ENV_ALLOWLIST) {
    const value = options.source[key];
    if (typeof value === "string") env[key] = value;
  }

  // Managed-home redirection is applied *after* the allowlist so a HOME in the
  // source environment can never survive into the child.
  env.HOME = options.managedHome;
  env.USERPROFILE = options.managedHome;
  env.XDG_CONFIG_HOME = `${options.managedHome}/.config`;
  env.XDG_CACHE_HOME = `${options.managedHome}/.cache`;
  env.XDG_DATA_HOME = `${options.managedHome}/.local/share`;
  env.XDG_STATE_HOME = `${options.managedHome}/.local/state`;

  return env;
}

/** Redact common credential forms before output crosses the probe boundary. */
export function redactProbeText(input: string): string {
  return input
    .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*([=:])\s*([^\s,;]+)/gi,
      "$1$2[REDACTED]"
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]");
}

/**
 * Extract the subcommand names advertised by a `--help` output.
 *
 * Only names appearing in an explicit commands section are returned. The probe
 * discipline forbids invoking a subcommand we did not first observe, so this
 * parser is deliberately conservative: an unrecognized layout yields an empty
 * list (no probing) rather than a guess (probing something arbitrary).
 */
export function parseHelpSubcommands(helpText: string): string[] {
  const lines = helpText.split("\n");
  const found: string[] = [];
  let inCommandsSection = false;

  for (const line of lines) {
    // A section header at column 0, e.g. "Commands:" / "Available Commands:".
    if (/^[A-Za-z][A-Za-z ]*:\s*$/.test(line)) {
      inCommandsSection = /commands?:\s*$/i.test(line.trim());
      continue;
    }

    // A blank line ends the section: entries are contiguous.
    if (line.trim() === "") {
      if (inCommandsSection) inCommandsSection = false;
      continue;
    }

    if (!inCommandsSection) continue;

    // Entries are indented: "  mcp   Manage MCP servers".
    const match = /^\s+([a-z][a-z0-9-]*)(?:\s{2,}.*)?$/.exec(line);
    if (match && !found.includes(match[1]!)) found.push(match[1]!);
  }

  return found;
}

/**
 * Extract long flags (`--name`) from help output.
 *
 * Values and metavariables are discarded — only the flag names are recorded,
 * since a flag's argument may contain host-specific or sensitive text.
 */
export function parseHelpFlags(helpText: string): string[] {
  const flags: string[] = [];
  // camelCase is included: real CLIs ship flags like `--allowedTools`.
  const pattern = /(--[A-Za-z][A-Za-z0-9-]*)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(helpText)) !== null) {
    const flag = match[1]!;
    if (!flags.includes(flag)) flags.push(flag);
  }

  return flags;
}

/**
 * Parse a version string from `--version` output.
 *
 * Returns `null` when no semver-shaped token is present — an unparseable
 * version is recorded as unknown rather than as the raw line, so downstream
 * comparisons never operate on a non-version string.
 */
export function parseVersion(versionOutput: string): string | null {
  const semver = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(versionOutput);
  if (semver) return semver[1]!;

  // Some upstream CLIs identify snapshots by release date instead of semver.
  // Preserve a valid ISO calendar date as the version identity; malformed
  // dates stay unknown rather than entering ordering/drift comparisons.
  const date = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(versionOutput);
  if (!date) return null;

  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return date[0];
}
