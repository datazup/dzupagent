import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  runSdlcMvpEvidenceReport,
  shapeSdlcMvpEvidenceCommandOutputs,
} from "../sdlc-mvp-evidence.js";

describe("SDLC MVP evidence report", () => {
  it("builds a passing memory-backed report from successful host command outputs", async () => {
    const report = await runSdlcMvpEvidenceReport({
      commandOutputs: [
        {
          id: "api-typecheck",
          command: "yarn workspace @codev-app/api typecheck",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        },
      ],
      packetItems: [{ ref: "codev/operator-closeout" }],
      env: {},
      runId: "run-test",
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      parseOk: true,
      compileOk: true,
      runtimeReady: true,
      readinessReport: "Runtime tool readiness: ready",
      checkpointBackend: "memory",
      backendChecks: {
        redisConfigured: false,
        postgresConfigured: false,
      },
      checkpointProof: {
        backend: "memory",
        status: "skipped",
        reason: "No persistent checkpoint backend configured",
      },
      execution: {
        state: "completed",
        runId: "run-test",
        exportedState: {
          truth: {
            commandCount: 1,
            packetRefs: ["codev/operator-closeout"],
          },
          closeoutStatus: "complete",
        },
      },
    });
  });

  it("marks readiness blocked when a host command failed", async () => {
    const report = await runSdlcMvpEvidenceReport({
      commandOutputs: [
        {
          id: "api-test",
          command: "yarn workspace @codev-app/api test",
          exitCode: 1,
          stdout: "",
          stderr: "failed",
        },
      ],
      env: {},
      runId: "run-failed",
    });

    expect(report).toMatchObject({
      parseOk: true,
      compileOk: false,
      runtimeReady: false,
      readinessReport: "Runtime tool readiness: blocked (api-test exited 1)",
      execution: {
        state: "blocked",
        runId: "run-failed",
        exportedState: {
          closeoutStatus: "blocked",
        },
      },
    });
  });

  it("loads command outputs and packet refs from CLI JSON files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdlc-mvp-evidence-test-"));
    try {
      const commandOutputPath = join(dir, "commands.json");
      const packetPath = join(dir, "packets.json");
      await writeFile(
        commandOutputPath,
        JSON.stringify([
          {
            id: "api-typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          },
        ]),
        "utf8"
      );
      await writeFile(packetPath, JSON.stringify([{ ref: "packet-a" }]), "utf8");

      const shaped = await shapeSdlcMvpEvidenceCommandOutputs({
        commandOutputJsonPath: commandOutputPath,
        packetJsonPath: packetPath,
      });

      expect(shaped).toEqual({
        commandOutputs: [
          {
            id: "api-typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          },
        ],
        packetItems: [{ ref: "packet-a" }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed command output JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdlc-mvp-evidence-test-"));
    try {
      const commandOutputPath = join(dir, "commands.json");
      await writeFile(commandOutputPath, JSON.stringify([{ id: "missing-fields" }]), "utf8");

      await expect(
        shapeSdlcMvpEvidenceCommandOutputs({ commandOutputJsonPath: commandOutputPath })
      ).rejects.toThrow(/command output item must include id, command, exitCode, stdout, and stderr/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
