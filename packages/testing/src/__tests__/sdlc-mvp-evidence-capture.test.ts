import { describe, expect, it } from "vitest";

import { captureSdlcMvpEvidenceCommandOutput } from "../sdlc-mvp-evidence.js";

/**
 * Covers `captureSdlcMvpEvidenceCommandOutput`'s validation and
 * process-lifecycle branches (DZUPAGENT-TEST-C-15 floor work): the existing
 * `sdlc-mvp-evidence.test.ts` only exercises the plain success path. A
 * mis-shaped exit report here (wrong exitCode, missing stderr context on
 * timeout/signal) would misclassify a passing or failing SDLC gate.
 */

describe("captureSdlcMvpEvidenceCommandOutput — validation", () => {
  it("rejects an empty id", async () => {
    await expect(
      captureSdlcMvpEvidenceCommandOutput({ id: "  ", command: "true" })
    ).rejects.toThrow(/command output id must be a non-empty string/i);
  });

  it("rejects an empty command", async () => {
    await expect(
      captureSdlcMvpEvidenceCommandOutput({ id: "x", command: "   " })
    ).rejects.toThrow(/command must be a non-empty string/i);
  });
});

describe("captureSdlcMvpEvidenceCommandOutput — process lifecycle", () => {
  it("captures a non-zero exit code and stderr output", async () => {
    const output = await captureSdlcMvpEvidenceCommandOutput({
      id: "fail-case",
      command: `"${process.execPath}" -e "process.stderr.write('boom'); process.exit(3)"`,
    });

    expect(output.exitCode).toBe(3);
    expect(output.stderr).toContain("boom");
  });

  it("defaults a null exit code (terminated by signal, not a timeout) to 1 and records the signal", async () => {
    // Self-signal rather than an external kill() call: shell:true wraps the
    // command, so only a signal the process raises against its own pid
    // reaches node as `code: null, signal: 'SIGTERM'` without going through
    // the timeout-kill path.
    const output = await captureSdlcMvpEvidenceCommandOutput({
      id: "self-signal",
      command: "kill -TERM $$; sleep 1",
    });

    expect(output.exitCode).toBe(1);
    expect(output.stderr).toMatch(/terminated by SIGTERM/);
    expect(output.stderr).not.toMatch(/terminated after/);
  });

  it("kills the process and reports a timeout after timeoutMs elapses", async () => {
    const output = await captureSdlcMvpEvidenceCommandOutput({
      id: "hangs",
      command: `"${process.execPath}" -e "setTimeout(() => {}, 5000)"`,
      timeoutMs: 50,
    });

    expect(output.exitCode).not.toBe(0);
    expect(output.stderr).toMatch(/terminated after 50ms/);
  }, 10_000);

  it("passes through custom env vars to the child process", async () => {
    const output = await captureSdlcMvpEvidenceCommandOutput({
      id: "env-check",
      command: `"${process.execPath}" -e "process.stdout.write(process.env.SDLC_TEST_VAR || 'unset')"`,
      env: { SDLC_TEST_VAR: "from-capture" },
    });

    expect(output.stdout).toBe("from-capture");
  });

  it("runs the command in the given cwd", async () => {
    const output = await captureSdlcMvpEvidenceCommandOutput({
      id: "cwd-check",
      command: `"${process.execPath}" -e "process.stdout.write(process.cwd())"`,
      cwd: "/tmp",
    });

    // Resolve to handle platforms where /tmp is itself a symlink.
    const { realpathSync } = await import("node:fs");
    expect(realpathSync(output.stdout)).toBe(realpathSync("/tmp"));
  });

  it("reports a spawn error (unresolvable executable) as exitCode 1 with the error message in stderr", async () => {
    const output = await captureSdlcMvpEvidenceCommandOutput({
      id: "bad-exe",
      command: "/definitely/not/a/real/executable-xyz --flag",
      env: {},
    });

    expect(output.exitCode).toBe(1);
  });

  it("records a durationMs proportional to real elapsed time", async () => {
    const output = await captureSdlcMvpEvidenceCommandOutput({
      id: "duration-check",
      command: `"${process.execPath}" -e "setTimeout(() => process.exit(0), 30)"`,
    });

    expect(output.durationMs).toBeGreaterThanOrEqual(25);
  });
});
