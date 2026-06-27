import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

// Import from built dist — these tests require `yarn build` to have run first.
// In CI, build runs before test.
import * as replayModule from "../dist/index.js";
import * as coreModule from "../../dialogue-core/dist/index.js";

const replay = replayModule;
const core = coreModule;

function makeSchedulerFactory(coreLib) {
  return (ports, options) => new coreLib.DialogueScheduler(ports, options);
}

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
        runId: "test",
        runSpecHash:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        input: { prompt: "hello", participants: [] },
        escape: false,
      }),
    ).rejects.toSatisfy((err) => {
      expect(err.name).toBe("ReplayExhaustedError");
      expect(err.portName).toBe("agent");
      expect(err.callIndex).toBe(0);
      return true;
    });
  });

  it("verbSequence mismatch is detected when agent calls are exhausted mid-run", async () => {
    const golden = await loadFixture("done-path.golden.json");

    // Remove all agent calls — scheduler will fail the turn (status=failed),
    // so no verbs are captured and verbSequence will diverge from the golden.
    const exhausted = {
      ...golden,
      turns: golden.turns.map((t) => ({ ...t, agentCalls: [] })),
    };

    await expect(
      replay.replayDialogue(exhausted, makeSchedulerFactory(core)),
    ).rejects.toSatisfy((err) => {
      expect(err.name).toBe("ReplayAssertionError");
      expect(err.message).toMatch(/verbSequence diverged/);
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
      expect(err.name).toBe("ReplayAssertionError");
      expect(err.message).toMatch(/runSpecHash mismatch/);
      return true;
    });
  });

  it("GoldenTraceValidationError is thrown for invalid fixture shape", async () => {
    const factory = (_ports, _options) => {
      throw new Error("should not reach scheduler");
    };

    await expect(
      replay.replayDialogue({ not: "a valid trace" }, factory),
    ).rejects.toSatisfy((err) => {
      expect(err.name).toBe("GoldenTraceValidationError");
      return true;
    });
  });
});
