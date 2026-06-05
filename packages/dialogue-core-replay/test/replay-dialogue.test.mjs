import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");
const replayPkg = new URL("../dist/index.js", import.meta.url).href;
const corePkg = new URL(
  "../../dialogue-core/dist/index.js",
  import.meta.url,
).href;

async function loadPackages() {
  const replay = await import(`${replayPkg}?t=${Date.now()}`);
  const core = await import(`${corePkg}?t=${Date.now()}`);
  return { replay, core };
}

async function loadFixture(name) {
  const raw = await readFile(path.join(fixturesDir, name), "utf8");
  return JSON.parse(raw);
}

function makeSchedulerFactory(core) {
  return (ports, options) => new core.DialogueScheduler(ports, options);
}

test("done-path fixture replays without live calls and matches runSpecHash", async () => {
  const { replay, core } = await loadPackages();
  const golden = await loadFixture("done-path.golden.json");

  const result = await replay.replayDialogue(
    golden,
    makeSchedulerFactory(core),
  );

  assert.equal(result.actualRunSpecHash, golden.runSpecHash);
  assert.deepEqual([...result.actualVerbSequence], golden.verbSequence);
});

test("escalate-path fixture replays two verbs in order", async () => {
  const { replay, core } = await loadPackages();
  const golden = await loadFixture("escalate-path.golden.json");

  const result = await replay.replayDialogue(
    golden,
    makeSchedulerFactory(core),
  );

  assert.equal(result.actualRunSpecHash, golden.runSpecHash);
  assert.deepEqual([...result.actualVerbSequence], golden.verbSequence);
});

test("branch-fork-merge fixture replays three verbs in order", async () => {
  const { replay, core } = await loadPackages();
  const golden = await loadFixture("branch-fork-merge.golden.json");

  const result = await replay.replayDialogue(
    golden,
    makeSchedulerFactory(core),
  );

  assert.equal(result.actualRunSpecHash, golden.runSpecHash);
  assert.deepEqual([...result.actualVerbSequence], golden.verbSequence);
});

test("ReplayExhaustedError is thrown directly by RecordedAgentPort when recordings exhausted", async () => {
  const { replay } = await loadPackages();
  const port = new replay.RecordedAgentPort([]);

  await assert.rejects(
    () =>
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
    (err) => {
      assert.equal(err.name, "ReplayExhaustedError");
      assert.equal(err.portName, "agent");
      assert.equal(err.callIndex, 0);
      return true;
    },
  );
});

test("verbSequence mismatch is detected when agent calls are exhausted mid-run", async () => {
  const { replay, core } = await loadPackages();
  const golden = await loadFixture("done-path.golden.json");

  // Remove all agent calls — scheduler will fail the turn (status=failed),
  // so no verbs are captured and verbSequence will diverge from the golden.
  const exhausted = {
    ...golden,
    turns: golden.turns.map((t) => ({ ...t, agentCalls: [] })),
  };

  await assert.rejects(
    () => replay.replayDialogue(exhausted, makeSchedulerFactory(core)),
    (err) => {
      assert.equal(err.name, "ReplayAssertionError");
      assert.ok(
        err.message.includes("verbSequence diverged"),
        `Expected verbSequence mismatch, got: ${err.message}`,
      );
      return true;
    },
  );
});

test("runSpecHash mismatch causes ReplayAssertionError at the correct turn", async () => {
  const { replay, core } = await loadPackages();
  const golden = await loadFixture("done-path.golden.json");

  // Corrupt the stored hash — the computed hash will differ
  const corrupted = {
    ...golden,
    runSpecHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  };

  await assert.rejects(
    () => replay.replayDialogue(corrupted, makeSchedulerFactory(core)),
    (err) => {
      assert.equal(err.name, "ReplayAssertionError");
      assert.ok(
        err.message.includes("runSpecHash mismatch"),
        `Expected runSpecHash mismatch message, got: ${err.message}`,
      );
      return true;
    },
  );
});

test("GoldenTraceValidationError is thrown for invalid fixture shape", async () => {
  const { replay } = await loadPackages();
  const factory = (ports, options) => {
    throw new Error("should not reach scheduler");
  };

  await assert.rejects(
    () => replay.replayDialogue({ not: "a valid trace" }, factory),
    (err) => {
      assert.equal(err.name, "GoldenTraceValidationError");
      return true;
    },
  );
});
