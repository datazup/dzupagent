import { describe, expect, it } from "vitest";

import * as core from "../../dialogue-core/src/index.ts";
import * as replay from "../src/index.ts";
import { mutableRecord, required } from "./typecheck-helpers.mjs";

/** @typedef {import("../src/golden-trace.ts").GoldenTrace} GoldenTrace */
/** @typedef {import("../src/golden-trace.ts").GoldenTraceTurn} GoldenTraceTurn */
/** @typedef {import("../../dialogue-core/src/index.ts").DialogueSchedulerPorts} SchedulerPorts */
/** @typedef {import("../../dialogue-core/src/index.ts").TurnVerb} TurnVerb */
/**
 * @typedef {{
 *   mode?: import("../../dialogue-core/src/index.ts").DialogueMode,
 *   maxIterations?: number,
 *   runId?: string,
 *   verbSequence?: TurnVerb[]
 * }} TraceOptions
 */
/**
 * @typedef {{
 *   status?: import("../../dialogue-core/src/index.ts").TurnEventStatus,
 *   skipReason?: string,
 *   runId?: string,
 *   runSpecHash?: import("../../dialogue-core/src/index.ts").RunSpecHash,
 *   decision?: import("../../dialogue-core/src/index.ts").DecisionBlock
 * }} EventOverrides
 */

const SENTINEL = "P004B-SENTINEL-MUST-NOT-APPEAR";
const STARTED_AT = "2026-08-11T00:00:00.000Z";

const participant = {
  id: "p1",
  provider: "test",
  model: "test-model",
};
const secondParticipant = {
  id: "p2",
  provider: "test",
  model: "test-model",
};
const validationSpec = {
  commandId: "test",
  cwdRoot: ".",
};
const agentRecording = {
  result: { raw: SENTINEL },
};
const validatorRecording = {
  result: {
    ok: true,
    exitCode: 0,
    output: SENTINEL,
    durationMs: 1,
  },
};
const snapshotRecording = {
  baseRevision: "base-revision",
  treeHash: "base-tree",
};
const effectRecording = {
  beforeSnapshot: snapshotRecording,
  effect: {
    diff: SENTINEL,
    changedFiles: ["synthetic.txt"],
    postRevision: "post-revision",
    treeHash: "post-tree",
    applyStatus: "clean",
  },
};

/**
 * @param {string} id
 * @param {TurnVerb} verb
 * @returns {import("../../dialogue-core/src/index.ts").RunTurnSpec}
 */
function runTurn(id, verb) {
  const common = { id, verb, participantId: participant.id };
  switch (verb) {
    case "validate":
      return { ...common, validation: validationSpec };
    case "handoff":
      return {
        ...common,
        handoff: {
          fromParticipantId: participant.id,
          toParticipantId: secondParticipant.id,
          reason: "synthetic handoff",
        },
      };
    default:
      return { ...common, prompt: `synthetic ${verb}` };
  }
}

/**
 * @param {import("../../dialogue-core/src/index.ts").RunTurnSpec} turn
 * @param {Readonly<Record<string, unknown>>} [recordings]
 * @returns {GoldenTraceTurn}
 */
function groupFor(turn, recordings = {}) {
  return /** @type {GoldenTraceTurn} */ ({
    turnId: turn.id,
    verb: turn.verb,
    agentCalls: recordings.agentCalls ?? [],
    validatorCalls: recordings.validatorCalls ?? [],
    workspaceSnapshots: recordings.workspaceSnapshots ?? [],
    workspaceEffects: recordings.workspaceEffects ?? [],
  });
}

/**
 * @param {import("../../dialogue-core/src/index.ts").RunTurnSpec[]} turns
 * @param {GoldenTraceTurn[]} groups
 * @param {TraceOptions} [options]
 * @returns {GoldenTrace}
 */
function traceFor(turns, groups, options = {}) {
  const runSpec = {
    mode: options.mode ?? "build",
    participants: [participant, secondParticipant],
    turns,
    ...(options.maxIterations === undefined
      ? {}
      : { maxIterations: options.maxIterations }),
  };
  return {
    runId: options.runId ?? "p004b-synthetic-run",
    runSpecHash: core.hashRunSpec(runSpec),
    verbSequence: options.verbSequence ?? turns.map((turn) => turn.verb),
    runSpec,
    turns: groups,
  };
}

/**
 * @param {GoldenTrace} trace
 * @param {Partial<import("../../dialogue-core/src/index.ts").DialogueSchedulerResult>} [overrides]
 * @returns {import("../../dialogue-core/src/index.ts").DialogueSchedulerResult}
 */
function schedulerResult(trace, overrides = {}) {
  return {
    runId: trace.runId,
    runSpecHash: trace.runSpecHash,
    turnsCompleted: 0,
    turnsSkipped: 0,
    turnsFailed: 0,
    traceEmits: 0,
    telemetry: {
      dialogue_core_turn_event_emitted: 0,
      dialogue_core_mode_gate_skip_count: 0,
      dialogue_core_escape_request_rejected_count: 0,
    },
    ...overrides,
  };
}

/**
 * @param {GoldenTrace} trace
 * @param {(ports: SchedulerPorts, input: import("../../dialogue-core/src/index.ts").DialogueSchedulerRunInput) => unknown | Promise<unknown>} execute
 * @returns {import("../src/replay-dialogue.ts").SchedulerFactory}
 */
function schedulerFactory(trace, execute) {
  return (ports) => {
    const scheduler = new core.DialogueScheduler(ports);
    scheduler.run = async (input) => {
      await execute(ports, input);
      return schedulerResult(trace);
    };
    return scheduler;
  };
}

/**
 * @param {GoldenTrace} trace
 * @param {"persisted" | "stream"} visibility
 * @param {number} turnIndex
 * @param {TurnVerb} turnType
 * @param {EventOverrides} [overrides]
 * @returns {import("../../dialogue-core/src/index.ts").PersistedTurnEvent | import("../../dialogue-core/src/index.ts").StreamTurnEvent}
 */
function sinkEvent(trace, visibility, turnIndex, turnType, overrides = {}) {
  return /** @type {import("../../dialogue-core/src/index.ts").PersistedTurnEvent | import("../../dialogue-core/src/index.ts").StreamTurnEvent} */ ({
    visibility,
    runId: trace.runId,
    runSpecHash: trace.runSpecHash,
    turnIndex,
    turnType,
    mode: trace.runSpec.mode,
    timing: { startedAt: STARTED_AT, ms: 0 },
    escape: false,
    status: "completed",
    ...overrides,
  });
}

/**
 * @param {SchedulerPorts} ports
 * @param {GoldenTrace} trace
 * @param {number} turnIndex
 * @param {TurnVerb} turnType
 * @param {{ persisted?: EventOverrides, stream?: EventOverrides }} [overrides]
 */
async function emitPair(ports, trace, turnIndex, turnType, overrides = {}) {
  await ports.tracePort.emit(
    sinkEvent(trace, "persisted", turnIndex, turnType, overrides.persisted),
  );
  await ports.tracePort.emit(
    sinkEvent(trace, "stream", turnIndex, turnType, overrides.stream),
  );
}

/**
 * @param {GoldenTrace} trace
 * @param {number} [turnIndex]
 * @param {TurnVerb} [turnType]
 * @returns {import("../../dialogue-core/src/index.ts").AgentRunRequest}
 */
function agentRequest(trace, turnIndex = 0, turnType = "deliberate") {
  return {
    runId: trace.runId,
    runSpecHash: trace.runSpecHash,
    turnIndex,
    turnType,
    participantId: participant.id,
    provider: participant.provider,
    model: participant.model,
    mode: trace.runSpec.mode,
    input: { prompt: "synthetic request" },
    escape: false,
  };
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 * @param {Readonly<Record<string, unknown>>} [fields]
 */
async function expectReplayAssertion(promise, code, fields = {}) {
  await expect(promise).rejects.toSatisfy((error) => {
    if (!(error instanceof replay.ReplayAssertionError)) {
      return false;
    }
    expect(error).toBeInstanceOf(replay.ReplayAssertionError);
    expect(error.code).toBe(code);
    for (const [key, value] of Object.entries(fields)) {
      expect(mutableRecord(error)[key]).toBe(value);
    }
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(256);
    expect(error.message).not.toContain(SENTINEL);
    return true;
  });
}

/** @type {Array<{
 *   label: string,
 *   field: string,
 *   recording: unknown,
 *   invoke: (ports: SchedulerPorts, trace: GoldenTrace) => Promise<unknown>
 * }>} */
const methodCases = [
  {
    label: "agent.run",
    field: "agentCalls",
    recording: agentRecording,
    invoke: (ports, trace) => ports.agentPort.run(agentRequest(trace)),
  },
  {
    label: "validator.validate",
    field: "validatorCalls",
    recording: validatorRecording,
    invoke: (ports) => ports.validatorPort.validate(validationSpec),
  },
  {
    label: "workspace.snapshot",
    field: "workspaceSnapshots",
    recording: snapshotRecording,
    invoke: (ports) => ports.workspacePort.snapshot(),
  },
  {
    label: "workspace.captureEffect",
    field: "workspaceEffects",
    recording: effectRecording,
    invoke: (ports) => ports.workspacePort.captureEffect(snapshotRecording),
  },
];

describe("replayDialogue grouped exact consumption", () => {
  it("does not satisfy the active turn from a later flattened agent recording", async () => {
    const turns = [runTurn("t0", "deliberate"), runTurn("t1", "deliberate")];
    const trace = traceFor(
      turns,
      [
        groupFor(required(turns[0], "first turn")),
        groupFor(required(turns[1], "second turn"), {
          agentCalls: [agentRecording],
        }),
      ],
      { verbSequence: ["deliberate"] },
    );

    await expectReplayAssertion(
      replay.replayDialogue(
        trace,
        (ports, options) => new core.DialogueScheduler(ports, options),
      ),
      "RECORDING_OVERRUN",
      {
        groupIndex: 0,
        methodName: "agent.run",
        expectedCount: 0,
        actualCount: 1,
      },
    );
  });

  it.each(methodCases)(
    "rejects $label from a later group instead of flattening ownership",
    async (method) => {
      const turns = [runTurn("t0", "handoff"), runTurn("t1", "handoff")];
      const trace = traceFor(
        turns,
        [
          groupFor(required(turns[0], "first turn")),
          groupFor(required(turns[1], "second turn"), {
            [method.field]: [method.recording],
          }),
        ],
        { verbSequence: ["handoff"] },
      );
      const factory = schedulerFactory(trace, async (ports) => {
        await method.invoke(ports, trace);
        await emitPair(ports, trace, 0, "handoff");
      });

      await expectReplayAssertion(
        replay.replayDialogue(trace, factory),
        "RECORDING_OVERRUN",
        {
          groupIndex: 0,
          methodName: method.label,
          expectedCount: 0,
          actualCount: 1,
        },
      );
    },
  );

  it.each(methodCases)(
    "rejects an unused $label recording at the terminal pair",
    async (method) => {
      const turn = runTurn("t0", "handoff");
      const trace = traceFor(
        [turn],
        [groupFor(turn, { [method.field]: [method.recording] })],
      );
      const factory = schedulerFactory(trace, (ports) =>
        emitPair(ports, trace, 0, "handoff"),
      );

      await expectReplayAssertion(
        replay.replayDialogue(trace, factory),
        "RECORDING_UNDERRUN",
        {
          groupIndex: 0,
          methodName: method.label,
          expectedCount: 1,
          actualCount: 0,
        },
      );
    },
  );

  it("rejects a persisted event without its stream pair", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor([turn], [groupFor(turn)]);
    const factory = schedulerFactory(trace, (ports) =>
      ports.tracePort.emit(sinkEvent(trace, "persisted", 0, "handoff")),
    );

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "EVENT_ORDER_MISMATCH",
      { groupIndex: 0 },
    );
  });

  it("rejects a stream event before a persisted event", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor([turn], [groupFor(turn)], { verbSequence: [] });
    const factory = schedulerFactory(trace, (ports) =>
      ports.tracePort.emit(sinkEvent(trace, "stream", 0, "handoff")),
    );

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "EVENT_ORDER_MISMATCH",
      { groupIndex: 0 },
    );
  });

  it("rejects duplicate persisted events in one pair", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor([turn], [groupFor(turn)], {
      verbSequence: ["handoff", "handoff"],
    });
    const factory = schedulerFactory(trace, async (ports) => {
      await ports.tracePort.emit(sinkEvent(trace, "persisted", 0, "handoff"));
      await ports.tracePort.emit(sinkEvent(trace, "persisted", 0, "handoff"));
    });

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "EVENT_ORDER_MISMATCH",
      { groupIndex: 0 },
    );
  });

  it("rejects persisted and stream outcome drift", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor([turn], [groupFor(turn)]);
    const factory = schedulerFactory(trace, (ports) =>
      emitPair(ports, trace, 0, "handoff", {
        stream: { status: "failed", skipReason: "synthetic-drift" },
      }),
    );

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "EVENT_OUTCOME_MISMATCH",
      { groupIndex: 0 },
    );
  });

  it.each(
    /** @type {Array<[string, number, TurnVerb]>} */ ([
      ["turn index", 1, "handoff"],
      ["turn verb", 0, "deliberate"],
    ]),
  )("rejects runtime %s drift from the active group", async (_label, index, verb) => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor([turn], [groupFor(turn)], { verbSequence: [verb] });
    const factory = schedulerFactory(trace, (ports) =>
      emitPair(ports, trace, index, verb),
    );

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "EVENT_IDENTITY_MISMATCH",
      { groupIndex: 0 },
    );
  });

  it("rejects scheduler completion with future supplied groups", async () => {
    const turns = [runTurn("t0", "handoff"), runTurn("t1", "handoff")];
    const trace = traceFor(turns, turns.map((turn) => groupFor(turn)), {
      verbSequence: ["handoff"],
    });
    const factory = schedulerFactory(trace, (ports) =>
      emitPair(ports, trace, 0, "handoff"),
    );

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "GROUP_COUNT_MISMATCH",
      { groupIndex: 1, expectedCount: 2, actualCount: 1 },
    );
  });

  it("replays all four method lanes and a fully empty group through DialogueScheduler", async () => {
    const turns = [
      runTurn("t0", "deliberate"),
      runTurn("t1", "validate"),
      runTurn("t2", "implement"),
      runTurn("t3", "handoff"),
    ];
    const trace = traceFor(turns, [
      groupFor(required(turns[0], "deliberate turn"), {
        agentCalls: [agentRecording],
      }),
      groupFor(required(turns[1], "validation turn"), {
        validatorCalls: [validatorRecording],
      }),
      groupFor(required(turns[2], "implementation turn"), {
        agentCalls: [agentRecording],
        workspaceSnapshots: [snapshotRecording],
        workspaceEffects: [effectRecording],
      }),
      groupFor(required(turns[3], "handoff turn")),
    ]);

    const result = await replay.replayDialogue(
      trace,
      (ports, options) => new core.DialogueScheduler(ports, options),
    );

    expect([...result.actualVerbSequence]).toEqual(trace.verbSequence);
    expect(result.schedulerResult.turnsCompleted).toBe(4);
  });

  it("accepts exact failed and skipped groups without inventing recordings", async () => {
    const turns = [runTurn("t0", "validate"), runTurn("t1", "implement")];
    const failedValidation = {
      result: {
        ok: false,
        exitCode: 1,
        output: "synthetic failure",
        durationMs: 1,
      },
    };
    const trace = traceFor(
      turns,
      [
        groupFor(required(turns[0], "validation turn"), {
          validatorCalls: [failedValidation],
        }),
        groupFor(required(turns[1], "implementation turn")),
      ],
      { maxIterations: 1, verbSequence: [] },
    );

    const result = await replay.replayDialogue(
      trace,
      (ports, options) => new core.DialogueScheduler(ports, options),
    );

    expect(result.schedulerResult.turnsFailed).toBe(1);
    expect(result.schedulerResult.turnsSkipped).toBe(1);
    expect(result.actualVerbSequence).toEqual([]);
  });

  it("preserves recorded-port counters and detached return values across a group", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor(
      [turn],
      [
        groupFor(turn, {
          agentCalls: [agentRecording],
          validatorCalls: [validatorRecording],
          workspaceSnapshots: [snapshotRecording],
          workspaceEffects: [effectRecording],
        }),
      ],
    );
    const factory = schedulerFactory(trace, async (ports) => {
      const agentResult = await ports.agentPort.run(
        agentRequest(trace, 0, "handoff"),
      );
      const validatorResult = await ports.validatorPort.validate(validationSpec);
      const snapshot = await ports.workspacePort.snapshot();
      const effect = await ports.workspacePort.captureEffect(snapshot);

      expect(
        mutableRecord(ports.agentPort).dialogueReplayRecordedPortCallCount,
      ).toBe(1);
      expect(
        mutableRecord(ports.validatorPort).dialogueReplayRecordedPortCallCount,
      ).toBe(1);
      expect(
        mutableRecord(ports.workspacePort).dialogueReplayRecordedPortCallCount,
      ).toBe(2);
      expect(
        mutableRecord(ports.workspacePort)
          .dialogueReplayWorkspaceWriteMismatchCount,
      ).toBe(0);

      agentResult.raw = "mutated";
      validatorResult.output = "mutated";
      snapshot.baseRevision = "mutated";
      effect.changedFiles.push("mutated.txt");
      await emitPair(ports, trace, 0, "handoff");
    });

    await replay.replayDialogue(trace, factory);

    const recordedTurn = required(trace.turns[0], "recorded turn");
    expect(required(recordedTurn.agentCalls[0], "agent call").result.raw).toBe(
      SENTINEL,
    );
    expect(
      required(recordedTurn.validatorCalls[0], "validator call").result.output,
    ).toBe(SENTINEL);
    expect(
      required(recordedTurn.workspaceSnapshots[0], "workspace snapshot")
        .baseRevision,
    ).toBe("base-revision");
    expect(
      required(recordedTurn.workspaceEffects[0], "workspace effect").effect
        .changedFiles,
    ).toEqual(["synthetic.txt"]);
  });

  it("exhausts multiple recordings independently in every method lane", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor(
      [turn],
      [
        groupFor(turn, {
          agentCalls: [agentRecording, agentRecording],
          validatorCalls: [validatorRecording, validatorRecording],
          workspaceSnapshots: [snapshotRecording, snapshotRecording],
          workspaceEffects: [effectRecording, effectRecording],
        }),
      ],
    );
    const factory = schedulerFactory(trace, async (ports) => {
      for (let index = 0; index < 2; index += 1) {
        await ports.agentPort.run(agentRequest(trace, 0, "handoff"));
        await ports.validatorPort.validate(validationSpec);
        const snapshot = await ports.workspacePort.snapshot();
        await ports.workspacePort.captureEffect(snapshot);
      }

      expect(
        mutableRecord(ports.agentPort).dialogueReplayRecordedPortCallCount,
      ).toBe(2);
      expect(
        mutableRecord(ports.validatorPort).dialogueReplayRecordedPortCallCount,
      ).toBe(2);
      expect(
        mutableRecord(ports.workspacePort).dialogueReplayRecordedPortCallCount,
      ).toBe(4);
      await emitPair(ports, trace, 0, "handoff");
    });

    await replay.replayDialogue(trace, factory);
  });

  it("rejects reordered agent requests within their owning group", async () => {
    const turn = runTurn("t0", "handoff");
    const firstRequest = {
      ...agentRequest(traceFor([turn], [groupFor(turn)]), 0, "handoff"),
      input: { prompt: "first" },
    };
    const secondRequest = {
      ...firstRequest,
      input: { prompt: "second" },
    };
    const trace = traceFor(
      [turn],
      [
        groupFor(turn, {
          agentCalls: [
            { request: firstRequest, result: agentRecording.result },
            { request: secondRequest, result: agentRecording.result },
          ],
        }),
      ],
    );
    const factory = schedulerFactory(trace, (ports) =>
      ports.agentPort.run(secondRequest),
    );

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "RECORDING_MISMATCH",
      { groupIndex: 0, methodName: "agent.run" },
    );
  });

  it("rejects agent runtime identity drift even without a recorded request", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor(
      [turn],
      [groupFor(turn, { agentCalls: [agentRecording] })],
    );
    const factory = schedulerFactory(trace, (ports) =>
      ports.agentPort.run(agentRequest(trace, 1, "handoff")),
    );

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "RECORDING_MISMATCH",
      { groupIndex: 0, methodName: "agent.run" },
    );
  });

  it("preserves validator spec mismatch checks", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor(
      [turn],
      [
        groupFor(turn, {
          validatorCalls: [{ spec: validationSpec, ...validatorRecording }],
        }),
      ],
    );
    const factory = schedulerFactory(trace, (ports) =>
      ports.validatorPort.validate({ ...validationSpec, commandId: "other" }),
    );

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "RECORDING_MISMATCH",
      { groupIndex: 0, methodName: "validator.validate" },
    );
  });

  it("preserves workspace input mismatch accounting", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor(
      [turn],
      [groupFor(turn, { workspaceEffects: [effectRecording] })],
    );
    let mismatchCount = -1;
    const factory = schedulerFactory(trace, async (ports) => {
      try {
        await ports.workspacePort.captureEffect({
          ...snapshotRecording,
          baseRevision: "different-revision",
        });
      } catch (error) {
        mismatchCount = Number(
          mutableRecord(ports.workspacePort)
            .dialogueReplayWorkspaceWriteMismatchCount,
        );
        throw error;
      }
    });

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "RECORDING_MISMATCH",
      { groupIndex: 0, methodName: "workspace.captureEffect" },
    );
    expect(mismatchCount).toBe(1);
  });

  it("rejects an extra terminal turn after every group is consumed", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor([turn], [groupFor(turn)]);
    const factory = schedulerFactory(trace, async (ports) => {
      await emitPair(ports, trace, 0, "handoff");
      await emitPair(ports, trace, 1, "handoff");
    });

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "GROUP_COUNT_MISMATCH",
      { groupIndex: 1, expectedCount: 1, actualCount: 2 },
    );
  });

  it("rejects method calls inserted inside a terminal event pair", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor(
      [turn],
      [groupFor(turn, { validatorCalls: [validatorRecording] })],
    );
    const factory = schedulerFactory(trace, async (ports) => {
      await ports.tracePort.emit(sinkEvent(trace, "persisted", 0, "handoff"));
      await ports.validatorPort.validate(validationSpec);
    });

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "EVENT_ORDER_MISMATCH",
      { groupIndex: 0, methodName: "validator.validate" },
    );
  });

  it.each(
    /** @type {Array<[string, EventOverrides]>} */ ([
      ["run id", { runId: "different-run" }],
      [
        "run-spec hash",
        {
          runSpecHash:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      ],
    ]),
  )("rejects runtime %s drift", async (_label, overrides) => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor([turn], [groupFor(turn)]);
    const factory = schedulerFactory(trace, (ports) =>
      emitPair(ports, trace, 0, "handoff", { persisted: overrides }),
    );

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "EVENT_IDENTITY_MISMATCH",
      { groupIndex: 0 },
    );
  });

  it("snapshots nested event outcome data before accepting the stream pair", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor([turn], [groupFor(turn)]);
    /** @type {import("../../dialogue-core/src/index.ts").DecisionBlock} */
    const decision = {
      verdict: "continue",
      criteria: [{ name: "synthetic", met: true }],
      rationale: "synthetic",
    };
    const persisted = sinkEvent(trace, "persisted", 0, "handoff", {
      decision,
    });
    const factory = schedulerFactory(trace, async (ports) => {
      await ports.tracePort.emit(persisted);
      required(decision.criteria[0], "decision criterion").met = false;
      await ports.tracePort.emit({ ...persisted, visibility: "stream" });
    });

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "EVENT_OUTCOME_MISMATCH",
      { groupIndex: 0 },
    );
  });

  it("keeps GoldenTrace turnId as metadata rather than claiming runtime identity", async () => {
    const turn = runTurn("runtime-turn", "handoff");
    const group = { ...groupFor(turn), turnId: "fixture-metadata-only" };
    const trace = traceFor([turn], [group]);

    const result = await replay.replayDialogue(
      trace,
      (ports, options) => new core.DialogueScheduler(ports, options),
    );

    expect(result.actualVerbSequence).toEqual(["handoff"]);
  });

  it("reports verb-sequence divergence after exact group consumption", async () => {
    const turn = runTurn("t0", "handoff");
    const trace = traceFor([turn], [groupFor(turn)], { verbSequence: [] });
    const factory = schedulerFactory(trace, (ports) =>
      emitPair(ports, trace, 0, "handoff"),
    );

    await expectReplayAssertion(
      replay.replayDialogue(trace, factory),
      "VERB_SEQUENCE_MISMATCH",
      { groupIndex: 0 },
    );
  });

  it("bounds direct ReplayAssertionError diagnostics at a UTF-8 boundary", () => {
    const error = new replay.ReplayAssertionError("🙂".repeat(200));

    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(256);
    expect(error.message.endsWith("...")).toBe(true);
    expect(error.code).toBe("ASSERTION_FAILED");
  });
});
