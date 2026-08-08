/**
 * Fixture-backed probe runner helpers.
 *
 * Full normalized per-version packs live in `m1-fixture-packs.ts` (WP-M1.4).
 * The aliases below keep the inspector suite on the newest pinned capture.
 */
import type {
  ProbeCommand,
  ProbeCommandRunner,
  ProbeResult,
} from "../../probe-runner.js";
import {
  CLAUDE_2_1_226_FIXTURE,
  CODEX_0_147_0_FIXTURE,
} from './m1-fixture-packs.js'
export {
  CLAUDE_2_0_14_FIXTURE,
  CLAUDE_2_1_226_FIXTURE,
  CODEX_0_48_0_FIXTURE,
  CODEX_0_147_0_FIXTURE,
  M1_FIXTURE_PACKS,
  type ProbeFixturePack,
} from './m1-fixture-packs.js'

/** Current pinned fixtures retained under the original test helper names. */
export const CLAUDE_HELP_FIXTURE = CLAUDE_2_1_226_FIXTURE.help
export const CLAUDE_VERSION_FIXTURE = CLAUDE_2_1_226_FIXTURE.versionOutput
export const CODEX_HELP_FIXTURE = CODEX_0_147_0_FIXTURE.help
export const CODEX_VERSION_FIXTURE = CODEX_0_147_0_FIXTURE.versionOutput

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
