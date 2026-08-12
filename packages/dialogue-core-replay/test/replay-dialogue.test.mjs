import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

import * as replayModule from "../src/index.ts";
import * as coreModule from "../../dialogue-core/src/index.ts";

const replay = replayModule;
const core = coreModule;

/**
 * @param {typeof coreModule} coreLib
 * @returns {import("../src/replay-dialogue.ts").SchedulerFactory}
 */
function makeSchedulerFactory(coreLib) {
  return (ports, options) => new coreLib.DialogueScheduler(ports, options);
}

/**
 * @param {string} name
 * @returns {Promise<import("../src/golden-trace.ts").GoldenTrace>}
 */
async function loadFixture(name) {
  const raw = await readFile(path.join(fixturesDir, name), "utf8");
  return JSON.parse(raw);
}

describe("replayDialogue", () => {
  it("done-path fixture replays without live calls and matches runSpecHash", async () => {
    const golden = await loadFixture("done-path.golden.json");

    const result = await replay.replayDialogue(golden, makeSchedulerFactory(core));

    expect(result.actualRunSpecHash).toBe(golden.runSpecHash);
    expect([...result.actualVerbSequence]).toEqual(golden.verbSequence);
  });

  it("escalate-path fixture replays two verbs in order", async () => {
    const golden = await loadFixture("escalate-path.golden.json");

    const result = await replay.replayDialogue(golden, makeSchedulerFactory(core));

    expect(result.actualRunSpecHash).toBe(golden.runSpecHash);
    expect([...result.actualVerbSequence]).toEqual(golden.verbSequence);
  });

  it("branch-fork-merge fixture replays three verbs in order", async () => {
    const golden = await loadFixture("branch-fork-merge.golden.json");

    const result = await replay.replayDialogue(golden, makeSchedulerFactory(core));

    expect(result.actualRunSpecHash).toBe(golden.runSpecHash);
    expect([...result.actualVerbSequence]).toEqual(golden.verbSequence);
  });

  it("ReplayExhaustedError is thrown directly by RecordedAgentPort when recordings exhausted", async () => {
    const port = new replay.RecordedAgentPort([]);

    await expect(
      port.run({
        turnType: "deliberate",
        turnIndex: 0,
        mode: "deliberate",
        participantId: "participant-1",
        runId: "test",
        runSpecHash:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        input: { prompt: "hello" },
        escape: false,
      }),
    ).rejects.toSatisfy((err) => {
      if (!(err instanceof replay.ReplayExhaustedError)) {
        return false;
      }
      expect(err.name).toBe("ReplayExhaustedError");
      expect(err.portName).toBe("agent");
      expect(err.callIndex).toBe(0);
      return true;
    });
  });

  it("grouped replay rejects an agent call without an active recording", async () => {
    const golden = await loadFixture("done-path.golden.json");

    // Remove all agent calls. Grouped replay must preserve the first port
    // violation even though DialogueScheduler normally turns it into a failed
    // turn event.
    const exhausted = {
      ...golden,
      turns: golden.turns.map((t) => ({ ...t, agentCalls: [] })),
    };

    await expect(
      replay.replayDialogue(exhausted, makeSchedulerFactory(core)),
    ).rejects.toSatisfy((err) => {
      if (!(err instanceof replay.ReplayAssertionError)) {
        return false;
      }
      expect(err.name).toBe("ReplayAssertionError");
      expect(err.code).toBe("RECORDING_OVERRUN");
      expect(err.groupIndex).toBe(0);
      expect(err.methodName).toBe("agent.run");
      expect(err.expectedCount).toBe(0);
      expect(err.actualCount).toBe(1);
      return true;
    });
  });

  it("runSpecHash mismatch causes ReplayAssertionError at the correct turn", async () => {
    const golden = await loadFixture("done-path.golden.json");

    // Corrupt the stored hash — the computed hash will differ
    const corrupted = {
      ...golden,
      runSpecHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };

    await expect(
      replay.replayDialogue(corrupted, makeSchedulerFactory(core)),
    ).rejects.toSatisfy((err) => {
      if (!(err instanceof replay.ReplayAssertionError)) {
        return false;
      }
      expect(err.name).toBe("ReplayAssertionError");
      expect(err.message).toMatch(/runSpecHash mismatch/);
      return true;
    });
  });

  it("GoldenTraceValidationError is thrown for invalid fixture shape", async () => {
    /** @type {import("../src/replay-dialogue.ts").SchedulerFactory} */
    const factory = (_ports, _options) => {
      throw new Error("should not reach scheduler");
    };

    await expect(
      replay.replayDialogue({ not: "a valid trace" }, factory),
    ).rejects.toSatisfy((err) => {
      if (!(err instanceof replay.GoldenTraceValidationError)) {
        return false;
      }
      expect(err.name).toBe("GoldenTraceValidationError");
      return true;
    });
  });
});
