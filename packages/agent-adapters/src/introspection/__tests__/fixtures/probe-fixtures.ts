/**
 * Minimal probe fixtures for inspector determinism (WP-M1.3).
 *
 * Deliberately minimal: full per-version fixture packs are WP-M1.4. These
 * cover only what the inspector tests need to discriminate.
 *
 * Fixture discipline (doc 06 §4): fixtures must *disagree* with each other and
 * with defaults. The Claude and Codex help texts below advertise different
 * subcommands and different flags, so an inspector that ignored its input and
 * returned a constant document could not pass both.
 */
import type {
  ProbeCommand,
  ProbeCommandRunner,
  ProbeResult,
} from "../../probe-runner.js";

export const CLAUDE_HELP_FIXTURE = `Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default.

Options:
  -v, --version               Output the version number
  -p, --print                 Print response and exit
  --output-format <format>    Output format (text, json, stream-json)
  --allowedTools <tools...>   Comma-separated list of allowed tools
  --permission-mode <mode>    Permission mode for the session
  -h, --help                  Display help for command

Commands:
  mcp                         Configure and manage MCP servers
  plugin                      Manage Claude Code plugins
  config                      Manage configuration
  update                      Check for updates
`;

export const CLAUDE_VERSION_FIXTURE = "2.0.14 (Claude Code)\n";

export const CODEX_HELP_FIXTURE = `Usage: codex [OPTIONS] [PROMPT]

Codex CLI

Options:
  -V, --version                  Print version
  --json                         Emit events as JSONL
  --ask-for-approval <POLICY>    Approval policy
  --sandbox <MODE>               Sandbox mode
  -h, --help                     Print help

Commands:
  exec                           Run a non-interactive task
  login                          Authenticate
  mcp                            Manage MCP servers
`;

export const CODEX_VERSION_FIXTURE = "codex-cli 0.48.0\n";

/** A probe result for a binary that is present and healthy. */
export function ok(stdout: string): ProbeResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    spawnFailed: false,
  };
}

/** A probe result for a binary that is not installed. */
export function notInstalled(): ProbeResult {
  return {
    exitCode: null,
    stdout: "",
    stderr: "spawn ENOENT",
    timedOut: false,
    spawnFailed: true,
  };
}

/** A probe result for a binary that hung and was killed. */
export function timedOut(): ProbeResult {
  return {
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: true,
    spawnFailed: false,
  };
}

/** Records every probe invocation for assertions about probe discipline. */
export interface RecordingRunner {
  run: ProbeCommandRunner;
  calls: ProbeCommand[];
}

/**
 * Build a fixture-backed runner.
 *
 * `responses` is keyed by `"<command> <args joined by space>"`. An unmatched
 * command resolves to {@link notInstalled} — so a probe the inspector was not
 * supposed to make cannot silently succeed.
 */
export function recordingRunner(
  responses: Record<string, ProbeResult>
): RecordingRunner {
  const calls: ProbeCommand[] = [];

  return {
    calls,
    run: async (command: ProbeCommand): Promise<ProbeResult> => {
      calls.push(command);
      const key = [command.command, ...command.args].join(" ");
      return responses[key] ?? notInstalled();
    },
  };
}

/** Fixed clock so documents are byte-reproducible across runs. */
export const FIXED_NOW = "2026-08-08T12:00:00.000Z";
export const fixedClock = (): string => FIXED_NOW;
