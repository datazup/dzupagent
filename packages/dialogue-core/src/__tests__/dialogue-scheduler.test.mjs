import { describe, it, expect } from "vitest";

import {
  assertAllFakesOnly,
  assertTraceHasNoSecret,
  baseRunSpec,
  createPorts,
  fixedClock,
  loadDialogueCore,
  validationSpec,
} from "./fakes.mjs";

describe("DialogueScheduler", () => {
  it("deliberate mode skips implement and validate after prior build port calls", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const ports = createPorts();
    const buildScheduler = new DialogueScheduler(ports, { clock: fixedClock() });

    await buildScheduler.run({
      runId: "build-before-deliberate",
      runSpec: baseRunSpec({
        mode: "build",
        turns: [
          {
            id: "implement-once",
            verb: "implement",
            participantId: "builder",
            prompt: "build before deliberate",
          },
          {
            id: "validate-once",
            verb: "validate",
            participantId: "critic",
            validation: validationSpec(),
          },
        ],
      }),
    });

    expect(ports.workspacePort.snapshotCalls.length).toBe(1);
    expect(ports.workspacePort.captureEffectCalls.length).toBe(1);
    expect(ports.validatorPort.calls.length).toBe(1);

    ports.agentPort.resetCalls();
    ports.workspacePort.resetCalls();
    ports.validatorPort.resetCalls();
    ports.tracePort.reset();

    const deliberateScheduler = new DialogueScheduler(ports, { clock: fixedClock() });
    const result = await deliberateScheduler.run({
      runId: "deliberate-skip",
      runSpec: baseRunSpec({
        mode: "deliberate",
        turns: [
          {
            id: "implement-skipped",
            verb: "implement",
            participantId: "builder",
            prompt: "SECRET-DELIBERATE should not trigger workspace",
          },
          {
            id: "validate-skipped",
            verb: "validate",
            participantId: "critic",
            validation: validationSpec("fake-deliberate-validation"),
          },
        ],
      }),
    });

    expect(result.turnsSkipped).toBe(2);
    expect(result.turnsCompleted).toBe(0);
    expect(result.telemetry.dialogue_core_mode_gate_skip_count).toBe(2);
    expect(ports.agentPort.calls.length).toBe(0);
    expect(ports.workspacePort.snapshotCalls.length).toBe(0);
    expect(ports.workspacePort.captureEffectCalls.length).toBe(0);
    expect(ports.validatorPort.calls.length).toBe(0);
    expect(
      ports.tracePort.byVisibility("persisted").map((event) => event.skipReason),
    ).toEqual(["mode=deliberate", "mode=deliberate"]);
    assertAllFakesOnly(ports);
  });

  it("agent turns pass participant systemPrompt through the agent request and redacted trace", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const ports = createPorts();
    const scheduler = new DialogueScheduler(ports, { clock: fixedClock() });

    await scheduler.run({
      runId: "participant-system-prompt",
      runSpec: baseRunSpec({
        mode: "build",
        participants: [
          {
            id: "architect",
            provider: "fake-agent",
            model: "architect-v1",
            role: "architect",
            systemPrompt: "You are Ada. SECRET-PERSONA",
          },
        ],
        turns: [
          {
            id: "speak",
            verb: "deliberate",
            participantId: "architect",
            prompt: "Draft a proposal.",
          },
        ],
      }),
    });

    expect(ports.agentPort.calls.length).toBe(1);
    expect(ports.agentPort.calls[0].input.systemPrompt).toBe("You are Ada. SECRET-PERSONA");

    const [persisted] = ports.tracePort.byVisibility("persisted");
    expect(persisted.input.systemPromptRedacted).toBe("You are Ada. [REDACTED]");
    expect(JSON.stringify(persisted).includes("SECRET-PERSONA")).toBe(false);
  });

  it("build mode records implement applyStatus and validation outcomes", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const ports = createPorts({
      workspace: {
        effects: ["clean", "no-op", "partial", "failed"].map((applyStatus) => ({
          diff: `fake ${applyStatus} diff`,
          changedFiles: applyStatus === "no-op" ? [] : [`${applyStatus}.ts`],
          postRevision: `post-${applyStatus}`,
          treeHash: `tree-${applyStatus}`,
          applyStatus,
        })),
      },
      validator: {
        results: [
          {
            ok: true,
            exitCode: 0,
            output: "validation passed",
            durationMs: 3,
          },
          {
            ok: false,
            exitCode: 2,
            output: "validation failed",
            durationMs: 4,
          },
        ],
      },
    });
    const scheduler = new DialogueScheduler(ports, { clock: fixedClock() });
    const result = await scheduler.run({
      runId: "build-statuses",
      runSpec: baseRunSpec({
        mode: "build",
        turns: [
          {
            id: "implement-clean",
            verb: "implement",
            participantId: "builder",
            prompt: "clean",
          },
          {
            id: "implement-no-op",
            verb: "implement",
            participantId: "builder",
            prompt: "no-op",
          },
          {
            id: "implement-partial",
            verb: "implement",
            participantId: "builder",
            prompt: "partial",
          },
          {
            id: "implement-failed",
            verb: "implement",
            participantId: "builder",
            prompt: "failed",
          },
          {
            id: "validate-ok",
            verb: "validate",
            participantId: "critic",
            validation: validationSpec("fake-pass"),
          },
          {
            id: "validate-failed",
            verb: "validate",
            participantId: "critic",
            validation: validationSpec("fake-fail"),
          },
        ],
      }),
    });

    const persisted = ports.tracePort.byVisibility("persisted");
    const implementEvents = persisted.filter((event) => event.turnType === "implement");
    const validationEvents = persisted.filter((event) => event.turnType === "validate");

    expect(ports.workspacePort.snapshotCalls.length).toBe(4);
    expect(ports.workspacePort.captureEffectCalls.length).toBe(4);
    expect(ports.validatorPort.calls.length).toBe(2);
    expect(implementEvents.map((event) => event.workspace.applyStatus)).toEqual([
      "clean",
      "no-op",
      "partial",
      "failed",
    ]);
    expect(implementEvents.map((event) => event.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "failed",
    ]);
    expect(validationEvents.map((event) => event.status)).toEqual(["completed", "failed"]);
    expect(validationEvents.map((event) => event.validation.ok)).toEqual([true, false]);
    expect(result.turnsCompleted).toBe(4);
    expect(result.turnsFailed).toBe(2);
    assertAllFakesOnly(ports);
  });

  it("redaction scrubs raw secrets before TracePort sees persisted or stream events", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const secret = "SECRET-TRACE-123";
    const ports = createPorts({
      agent: {
        responses: [
          {
            raw: `agent output ${secret}`,
            usage: {
              inputTokens: 2,
              outputTokens: 3,
              totalTokens: 5,
            },
          },
        ],
      },
      workspace: {
        effects: [
          {
            diff: `diff contains ${secret}`,
            changedFiles: ["secret.ts"],
            postRevision: "post-secret",
            treeHash: "tree-secret",
            applyStatus: "clean",
          },
        ],
      },
      validator: {
        results: [
          {
            ok: true,
            exitCode: 0,
            output: `validator output ${secret}`,
            durationMs: 9,
          },
        ],
      },
    });
    const scheduler = new DialogueScheduler(ports, { clock: fixedClock() });

    await scheduler.run({
      runId: "redaction",
      runSpec: baseRunSpec({
        mode: "build",
        turns: [
          {
            id: "implement-secret",
            verb: "implement",
            participantId: "builder",
            prompt: `prompt contains ${secret}`,
          },
          {
            id: "validate-secret",
            verb: "validate",
            participantId: "critic",
            validation: validationSpec("fake-secret-validation"),
          },
        ],
      }),
    });

    expect(
      ports.redactionPolicy.calls.some((event) => JSON.stringify(event).includes(secret)),
    ).toBe(true);
    assertTraceHasNoSecret(ports.tracePort, secret);
    expect(ports.tracePort.events.every((event) => event.runSpecHash)).toBe(true);
    assertAllFakesOnly(ports);
  });

  it("run schedule expands loops, branch paths, and maxIterations deterministically", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const ports = createPorts();
    const scheduler = new DialogueScheduler(ports, { clock: fixedClock() });
    const result = await scheduler.run({
      runId: "loop-branch",
      runSpec: baseRunSpec({
        mode: "build",
        turns: [
          {
            id: "loop-deliberate",
            verb: "deliberate",
            participantId: "planner",
            prompt: "loop body",
          },
          {
            id: "branch-fork",
            verb: "deliberate",
            participantId: "planner",
            prompt: "branch fork",
            branch: {
              id: "branch-1",
              fromTurnId: "branch-fork",
              paths: [
                {
                  id: "false-path",
                  condition: {
                    expression: "false",
                  },
                  turnIds: ["unselected-path"],
                },
                {
                  id: "true-path",
                  condition: {
                    expression: "true",
                  },
                  turnIds: ["selected-path", "merge-point"],
                },
              ],
            },
          },
          {
            id: "unselected-path",
            verb: "deliberate",
            participantId: "planner",
            prompt: "must not run",
          },
          {
            id: "selected-path",
            verb: "review",
            participantId: "critic",
            prompt: "selected path",
          },
          {
            id: "merge-point",
            verb: "deliberate",
            participantId: "planner",
            prompt: "merge point",
          },
        ],
        loops: [
          {
            id: "loop-1",
            condition: "true",
            turnIds: ["loop-deliberate"],
            maxIterations: 2,
          },
        ],
      }),
    });

    expect(ports.agentPort.calls.map((call) => call.input.prompt)).toEqual([
      "loop body",
      "loop body",
      "branch fork",
      "selected path",
      "merge point",
    ]);
    expect(result.stopReason).toBe("loop=maxIterations");
    expect(result.turnsCompleted).toBe(5);
    expect(result.traceEmits).toBe(10);
    assertAllFakesOnly(ports);
  });

  it("turn boundary maxIterations emits skipped event and stops runaway schedule", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const ports = createPorts();
    const scheduler = new DialogueScheduler(ports, { clock: fixedClock() });
    const result = await scheduler.run({
      runId: "boundary-max-iterations",
      runSpec: baseRunSpec({
        mode: "build",
        maxIterations: 2,
        turns: [
          {
            id: "first",
            verb: "deliberate",
            participantId: "planner",
            prompt: "first",
          },
          {
            id: "second",
            verb: "deliberate",
            participantId: "planner",
            prompt: "second",
          },
          {
            id: "third",
            verb: "deliberate",
            participantId: "planner",
            prompt: "third",
          },
        ],
      }),
    });

    expect(ports.agentPort.calls.map((call) => call.input.prompt)).toEqual(["first", "second"]);
    expect(result.stopReason).toBe("maxIterations");
    expect(result.turnsCompleted).toBe(2);
    expect(result.turnsSkipped).toBe(1);
    expect(
      ports.tracePort.byVisibility("persisted").map((event) => event.status),
    ).toEqual(["completed", "completed", "skipped"]);
    assertAllFakesOnly(ports);
  });

  it("handoff failure followed by success updates active participant by id", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const ports = createPorts();
    const scheduler = new DialogueScheduler(ports, { clock: fixedClock() });
    const result = await scheduler.run({
      runId: "handoff",
      runSpec: baseRunSpec({
        mode: "build",
        turns: [
          {
            id: "bad-handoff",
            verb: "handoff",
            handoff: {
              fromParticipantId: "planner",
              toParticipantId: "missing",
              reason: "adversarial missing participant",
            },
          },
          {
            id: "good-handoff",
            verb: "handoff",
            handoff: {
              fromParticipantId: "planner",
              toParticipantId: "builder",
              reason: "builder owns implementation",
            },
          },
          {
            id: "post-handoff",
            verb: "deliberate",
            prompt: "active participant should be builder",
          },
        ],
      }),
    });

    const persisted = ports.tracePort.byVisibility("persisted");

    expect(persisted.map((event) => event.status)).toEqual(["failed", "completed", "completed"]);
    expect(persisted[0].skipReason).toBe("handoff=unknown-participant");
    expect(ports.agentPort.calls[0].participantId).toBe("builder");
    expect(result.activeParticipantId).toBe("builder");
    expect(result.turnsFailed).toBe(1);
    expect(result.turnsCompleted).toBe(2);
    assertAllFakesOnly(ports);
  });

  it("review and decide expose structured criteria and wouldFlipIf", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const ports = createPorts({
      agent: {
        responses: [
          {
            raw: JSON.stringify({
              decision: {
                verdict: "branch",
                criteria: [
                  {
                    name: "tests",
                    met: false,
                    weight: 0.7,
                  },
                ],
                rationale: "branch until fake tests pass",
                wouldFlipIf: "tests pass",
              },
            }),
          },
          {
            raw: JSON.stringify({
              verdict: "accept",
              criteria: [
                {
                  name: "all-fakes",
                  met: true,
                },
              ],
              rationale: "fake validation is complete",
              wouldFlipIf: "live call detected",
            }),
          },
        ],
      },
    });
    const scheduler = new DialogueScheduler(ports, { clock: fixedClock() });
    const result = await scheduler.run({
      runId: "decisions",
      runSpec: baseRunSpec({
        mode: "build",
        decidePolicy: {
          kind: "agent",
          participantId: "critic",
        },
        turns: [
          {
            id: "review",
            verb: "review",
            participantId: "critic",
            prompt: "review fake evidence",
          },
          {
            id: "decide",
            verb: "decide",
            participantId: "planner",
            prompt: "decide fake outcome",
          },
          {
            id: "after-accept",
            verb: "deliberate",
            participantId: "planner",
            prompt: "must not run after accept",
          },
        ],
      }),
    });

    const [reviewEvent, decideEvent] = ports.tracePort.byVisibility("persisted");

    expect(reviewEvent.decision.verdict).toBe("branch");
    expect(reviewEvent.decision.criteria).toEqual([
      {
        name: "tests",
        met: false,
        weight: 0.7,
      },
    ]);
    expect(reviewEvent.decision.wouldFlipIf).toBe("tests pass");
    expect(decideEvent.decision.verdict).toBe("accept");
    expect(decideEvent.decision.criteria).toEqual([
      {
        name: "all-fakes",
        met: true,
      },
    ]);
    expect(decideEvent.decision.wouldFlipIf).toBe("live call detected");
    expect(result.stopReason).toBe("decision=accept");
    expect(ports.agentPort.calls.length).toBe(2);
    assertAllFakesOnly(ports);
  });

  it("escape gating rejects by default and allowed escape still avoids WorkspacePort", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const ports = createPorts();
    const rejectedScheduler = new DialogueScheduler(ports, { clock: fixedClock() });
    const escapeRequest = {
      runId: "external-run-id",
      runSpecHash: "sha256:external",
      turnIndex: 99,
      turnType: "implement",
      participantId: "builder",
      provider: "fake-agent",
      model: "builder-v1",
      mode: "build",
      input: {
        prompt: "escape request",
      },
      escape: true,
    };
    const rejected = await rejectedScheduler.run({
      runId: "escape-rejected",
      runSpec: baseRunSpec({
        mode: "build",
        turns: [],
      }),
      schedule: [escapeRequest],
    });

    expect(rejected.turnsSkipped).toBe(1);
    expect(rejected.telemetry.dialogue_core_escape_request_rejected_count).toBe(1);
    expect(ports.agentPort.calls.length).toBe(0);
    expect(ports.workspacePort.snapshotCalls.length).toBe(0);
    expect(ports.tracePort.byVisibility("persisted")[0].escape).toBe(true);

    ports.agentPort.resetCalls();
    ports.workspacePort.resetCalls();
    ports.validatorPort.resetCalls();
    ports.tracePort.reset();

    const allowedScheduler = new DialogueScheduler(ports, { clock: fixedClock() });
    const allowed = await allowedScheduler.run({
      runId: "escape-allowed",
      runSpec: baseRunSpec({
        mode: "build",
        allowEscape: true,
        turns: [],
      }),
      schedule: [escapeRequest],
    });

    expect(allowed.turnsCompleted).toBe(1);
    expect(ports.agentPort.calls.length).toBe(1);
    expect(ports.agentPort.calls[0].escape).toBe(true);
    expect(ports.agentPort.calls[0].runId).toBe("escape-allowed");
    expect(ports.workspacePort.snapshotCalls.length).toBe(0);
    expect(ports.workspacePort.captureEffectCalls.length).toBe(0);
    expect(ports.validatorPort.calls.length).toBe(0);
    expect(ports.tracePort.byVisibility("persisted")[0].escape).toBe(true);
    assertAllFakesOnly(ports);
  });

  it("all-fakes ports reject live provider, workspace, and validation attempts", async () => {
    const ports = createPorts();
    const liveWorkspacePorts = createPorts({
      workspace: {
        live: true,
      },
    });

    await expect(
      ports.agentPort.run({
        runId: "live",
        runSpecHash: "sha256:live",
        turnIndex: 0,
        turnType: "deliberate",
        participantId: "live",
        provider: "openai",
        model: "gpt-live",
        mode: "build",
        input: {
          prompt: "do not call live provider",
        },
      }),
    ).rejects.toThrow(/live provider calls are forbidden/);

    await expect(liveWorkspacePorts.workspacePort.snapshot()).rejects.toThrow(
      /live workspace calls are forbidden/,
    );

    await expect(
      ports.validatorPort.validate({
        ...validationSpec("live:validate"),
      }),
    ).rejects.toThrow(/live validation calls are forbidden/);

    expect(ports.liveCallSensor).toEqual({
      agent: 1,
      workspace: 0,
      validator: 1,
      trace: 0,
    });
    expect(liveWorkspacePorts.liveCallSensor).toEqual({
      agent: 0,
      workspace: 1,
      validator: 0,
      trace: 0,
    });
  });
});
