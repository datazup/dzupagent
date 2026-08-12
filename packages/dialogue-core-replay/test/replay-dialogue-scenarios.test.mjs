import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as core from "../../dialogue-core/src/index.ts";
import * as replay from "../src/index.ts";
import {
  manifestFor,
  payloadFor,
} from "./golden-trace-fixture-manifest-builders.mjs";
import { mutableRecord, required } from "./typecheck-helpers.mjs";

/** @typedef {import("./typecheck-types.d.ts").DeepMutable<import("../src/golden-trace.ts").GoldenTrace>} MutableGoldenTrace */

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const SENTINEL = "P004C-SENTINEL-MUST-NOT-APPEAR";

/** @type {import("../src/replay-dialogue.ts").SchedulerFactory} */
function schedulerFactory(ports, options) {
  return new core.DialogueScheduler(ports, options);
}

/** @param {string} fixtureId */
async function readCheckedInBundle(fixtureId) {
  const [manifestJson, payloadBuffer] = await Promise.all([
    readFile(
      path.join(fixturesDirectory, `${fixtureId}.golden.manifest.v1.json`),
      "utf8",
    ),
    readFile(path.join(fixturesDirectory, `${fixtureId}.golden.json`)),
  ]);
  const manifest = JSON.parse(manifestJson);
  const payloadBytes = Uint8Array.from(payloadBuffer).buffer;
  const admission = replay.loadGoldenTraceFixtureV1(manifestJson, [
    { path: required(manifest.files[0], "manifest file").path, bytes: payloadBytes },
  ]);
  return { admission, manifest, manifestJson, payloadBytes };
}

/**
 * @param {string} fixtureId
 * @param {(trace: MutableGoldenTrace) => void} mutate
 */
async function admitDerivedTrace(fixtureId, mutate) {
  const baseline = await readCheckedInBundle("handoff-barrier");
  const trace = /** @type {MutableGoldenTrace} */ (
    structuredClone(baseline.admission.trace)
  );
  mutate(trace);
  const payloadJson = JSON.stringify(trace);
  const manifest = manifestFor(fixtureId, payloadJson);
  return replay.loadGoldenTraceFixtureV1(
    JSON.stringify(manifest),
    payloadFor(manifest, payloadJson),
  );
}

/**
 * @param {Promise<unknown>} promise
 * @param {Readonly<Record<string, unknown>>} expected
 */
async function expectReplayFailure(promise, expected) {
  await expect(promise).rejects.toSatisfy((error) => {
    if (!(error instanceof replay.ReplayAssertionError)) {
      return false;
    }
    expect(error).toBeInstanceOf(replay.ReplayAssertionError);
    for (const [field, value] of Object.entries(expected)) {
      expect(mutableRecord(error)[field]).toBe(value);
    }
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(256);
    expect(error.message).not.toContain(SENTINEL);
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
    return true;
  });
}

/**
 * @param {() => unknown} run
 * @param {{ code: string, location: string }} expected
 */
function expectFixtureFailure(run, expected) {
  try {
    run();
    throw new Error("expected fixture admission to fail");
  } catch (error) {
    if (!(error instanceof replay.GoldenTraceFixtureValidationError)) {
      throw error;
    }
    expect(error).toBeInstanceOf(replay.GoldenTraceFixtureValidationError);
    expect(error.code).toBe(expected.code);
    expect(error.location).toBe(expected.location);
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(256);
    expect(error.message).not.toContain(SENTINEL);
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  }
}

describe("P004C loader-to-replay scenarios", () => {
  it("rejects same-length payload corruption before replay", async () => {
    const bundle = await readCheckedInBundle("handoff-barrier");
    const corruptedBytes = bundle.payloadBytes.slice(0);
    const view = new Uint8Array(corruptedBytes);
    const lastIndex = view.length - 1;
    view[lastIndex] = required(view[lastIndex], "last payload byte") ^ 1;

    expectFixtureFailure(
      () =>
        replay.loadGoldenTraceFixtureV1(bundle.manifestJson, [
          {
            path: required(bundle.manifest.files[0], "manifest file").path,
            bytes: corruptedBytes,
          },
        ]),
      {
        code: "PAYLOAD_DIGEST_MISMATCH",
        location: "$payloads[0].bytes",
      },
    );
  });

  it("preserves the exact missing-recording failure in its active group", async () => {
    const admission = await admitDerivedTrace("missing-recording", (trace) => {
      required(trace.turns[2], "third turn").agentCalls = [];
    });

    await expectReplayFailure(
      replay.replayDialogue(admission.trace, schedulerFactory),
      {
        code: "RECORDING_OVERRUN",
        groupIndex: 2,
        methodName: "agent.run",
        expectedCount: 0,
        actualCount: 1,
      },
    );
  });

  it("rejects an extra active-group recording with exact counts", async () => {
    const admission = await admitDerivedTrace("extra-recording", (trace) => {
      required(trace.turns[0], "first turn").agentCalls.push({
        result: { raw: SENTINEL },
      });
    });

    await expectReplayFailure(
      replay.replayDialogue(admission.trace, schedulerFactory),
      {
        code: "RECORDING_UNDERRUN",
        groupIndex: 0,
        methodName: "agent.run",
        expectedCount: 2,
        actualCount: 1,
      },
    );
  });

  it("preserves group zero as the first failure and never invokes a later group", async () => {
    const admission = await admitDerivedTrace("first-failure", (trace) => {
      required(trace.turns[0], "first turn").agentCalls = [];
      required(
        required(trace.turns[2], "third turn").agentCalls[0],
        "third-turn agent call",
      ).result.raw = SENTINEL;
    });
    /** @type {number[]} */
    const observedAgentTurnIndexes = [];
    /** @type {import("../src/replay-dialogue.ts").SchedulerFactory} */
    const observingSchedulerFactory = (ports, options) =>
      new core.DialogueScheduler(
        {
          ...ports,
          agentPort: {
            run(request) {
              observedAgentTurnIndexes.push(request.turnIndex);
              return ports.agentPort.run(request);
            },
          },
        },
        options,
      );

    await expectReplayFailure(
      replay.replayDialogue(admission.trace, observingSchedulerFactory),
      {
        code: "RECORDING_OVERRUN",
        groupIndex: 0,
        methodName: "agent.run",
        expectedCount: 0,
        actualCount: 1,
      },
    );
    expect(observedAgentTurnIndexes).toEqual([0]);
  });

  it("rejects an unused future recording group after scheduler completion", async () => {
    const admission = await admitDerivedTrace("late-recording", (trace) => {
      trace.turns.push({
        turnId: "late-recording",
        verb: "deliberate",
        agentCalls: [{ result: { raw: SENTINEL } }],
        validatorCalls: [],
        workspaceSnapshots: [],
        workspaceEffects: [],
      });
    });

    await expectReplayFailure(
      replay.replayDialogue(admission.trace, schedulerFactory),
      {
        code: "GROUP_COUNT_MISMATCH",
        groupIndex: 3,
        expectedCount: 4,
        actualCount: 3,
      },
    );
  });

  it("rejects an agent call made after the terminal group", async () => {
    const bundle = await readCheckedInBundle("handoff-barrier");
    /** @type {import("../src/replay-dialogue.ts").SchedulerFactory} */
    const postTerminalSchedulerFactory = (ports, options) => {
      const scheduler = new core.DialogueScheduler(ports, options);
      const run = scheduler.run.bind(scheduler);
      scheduler.run = async (input) => {
        const result = await run(input);
        const request = required(
          required(
            required(bundle.admission.trace.turns[2], "terminal turn")
              .agentCalls[0],
            "terminal agent call",
          ).request,
          "terminal agent request",
        );
        await ports.agentPort.run({ ...request, turnIndex: 3 });
        return result;
      };
      return scheduler;
    };

    await expectReplayFailure(
      replay.replayDialogue(
        bundle.admission.trace,
        postTerminalSchedulerFactory,
      ),
      {
        code: "RECORDING_OVERRUN",
        groupIndex: 3,
        methodName: "agent.run",
        expectedCount: 0,
        actualCount: 1,
      },
    );
  });

  it("replays the checked-in handoff barrier with exact participant ownership", async () => {
    const bundle = await readCheckedInBundle("handoff-barrier");
    new Uint8Array(bundle.payloadBytes).fill(32);

    expect(Object.isFrozen(bundle.admission.trace)).toBe(true);
    const terminalCall = required(
      required(bundle.admission.trace.turns[2], "terminal turn").agentCalls[0],
      "terminal agent call",
    );
    expect(Object.isFrozen(terminalCall)).toBe(true);
    expect(() => {
      terminalCall.result.raw = "mutated";
    }).toThrow(TypeError);

    const result = await replay.replayDialogue(
      bundle.admission.trace,
      schedulerFactory,
    );

    expect(result.actualVerbSequence).toEqual([
      "deliberate",
      "handoff",
      "deliberate",
    ]);
    expect(result.schedulerResult).toMatchObject({
      activeParticipantId: "builder",
      turnsCompleted: 3,
      turnsSkipped: 0,
      turnsFailed: 0,
      traceEmits: 6,
    });
  });

  it("fails when the post-handoff recording is moved to the barrier group", async () => {
    const admission = await admitDerivedTrace("wrong-side-handoff", (trace) => {
      required(trace.turns[1], "handoff turn").agentCalls = required(
        trace.turns[2],
        "post-handoff turn",
      ).agentCalls;
      required(trace.turns[2], "post-handoff turn").agentCalls = [];
    });

    await expectReplayFailure(
      replay.replayDialogue(admission.trace, schedulerFactory),
      {
        code: "RECORDING_UNDERRUN",
        groupIndex: 1,
        methodName: "agent.run",
        expectedCount: 1,
        actualCount: 0,
      },
    );
  });

  it.each(["done-path", "escalate-path", "branch-fork-merge"])(
    "keeps the checked-in %s baseline admitted and replayable",
    async (fixtureId) => {
      const bundle = await readCheckedInBundle(fixtureId);
      const result = await replay.replayDialogue(
        bundle.admission.trace,
        schedulerFactory,
      );

      expect(result.actualRunSpecHash).toBe(bundle.admission.trace.runSpecHash);
      expect(result.actualVerbSequence).toEqual(
        bundle.admission.trace.verbSequence,
      );
    },
  );
});
