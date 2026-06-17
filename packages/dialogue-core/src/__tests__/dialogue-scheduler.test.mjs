import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllFakesOnly,
  assertTraceHasNoSecret,
  baseRunSpec,
  createPorts,
  fixedClock,
  loadDialogueCore,
  validationSpec,
} from "./fakes.mjs";

test("deliberate mode skips implement and validate after prior build port calls", async () => {
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

  assert.equal(ports.workspacePort.snapshotCalls.length, 1);
  assert.equal(ports.workspacePort.captureEffectCalls.length, 1);
  assert.equal(ports.validatorPort.calls.length, 1);

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

  assert.equal(result.turnsSkipped, 2);
  assert.equal(result.turnsCompleted, 0);
  assert.equal(
    result.telemetry.dialogue_core_mode_gate_skip_count,
    2,
  );
  assert.equal(ports.agentPort.calls.length, 0);
  assert.equal(ports.workspacePort.snapshotCalls.length, 0);
  assert.equal(ports.workspacePort.captureEffectCalls.length, 0);
  assert.equal(ports.validatorPort.calls.length, 0);
  assert.deepEqual(
    ports.tracePort.byVisibility("persisted").map((event) => event.skipReason),
    ["mode=deliberate", "mode=deliberate"],
  );
  assertAllFakesOnly(ports);
});

test("agent turns pass participant systemPrompt through the agent request and redacted trace", async () => {
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

  assert.equal(ports.agentPort.calls.length, 1);
  assert.equal(
    ports.agentPort.calls[0].input.systemPrompt,
    "You are Ada. SECRET-PERSONA",
  );

  const [persisted] = ports.tracePort.byVisibility("persisted");
  assert.equal(
    persisted.input.systemPromptRedacted,
    "You are Ada. [REDACTED]",
  );
  assert.equal(JSON.stringify(persisted).includes("SECRET-PERSONA"), false);
});

test("build mode records implement applyStatus and validation outcomes", async () => {
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

  assert.equal(ports.workspacePort.snapshotCalls.length, 4);
  assert.equal(ports.workspacePort.captureEffectCalls.length, 4);
  assert.equal(ports.validatorPort.calls.length, 2);
  assert.deepEqual(
    implementEvents.map((event) => event.workspace.applyStatus),
    ["clean", "no-op", "partial", "failed"],
  );
  assert.deepEqual(
    implementEvents.map((event) => event.status),
    ["completed", "completed", "completed", "failed"],
  );
  assert.deepEqual(
    validationEvents.map((event) => event.status),
    ["completed", "failed"],
  );
  assert.deepEqual(
    validationEvents.map((event) => event.validation.ok),
    [true, false],
  );
  assert.equal(result.turnsCompleted, 4);
  assert.equal(result.turnsFailed, 2);
  assertAllFakesOnly(ports);
});

test("redaction scrubs raw secrets before TracePort sees persisted or stream events", async () => {
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

  assert.equal(
    ports.redactionPolicy.calls.some((event) =>
      JSON.stringify(event).includes(secret),
    ),
    true,
  );
  assertTraceHasNoSecret(ports.tracePort, secret);
  assert.equal(ports.tracePort.events.every((event) => event.runSpecHash), true);
  assertAllFakesOnly(ports);
});

test("run schedule expands loops, branch paths, and maxIterations deterministically", async () => {
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

  assert.deepEqual(
    ports.agentPort.calls.map((call) => call.input.prompt),
    ["loop body", "loop body", "branch fork", "selected path", "merge point"],
  );
  assert.equal(result.stopReason, "loop=maxIterations");
  assert.equal(result.turnsCompleted, 5);
  assert.equal(result.traceEmits, 10);
  assertAllFakesOnly(ports);
});

test("turn boundary maxIterations emits skipped event and stops runaway schedule", async () => {
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

  assert.deepEqual(
    ports.agentPort.calls.map((call) => call.input.prompt),
    ["first", "second"],
  );
  assert.equal(result.stopReason, "maxIterations");
  assert.equal(result.turnsCompleted, 2);
  assert.equal(result.turnsSkipped, 1);
  assert.deepEqual(
    ports.tracePort.byVisibility("persisted").map((event) => event.status),
    ["completed", "completed", "skipped"],
  );
  assertAllFakesOnly(ports);
});

test("handoff failure followed by success updates active participant by id", async () => {
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

  assert.deepEqual(
    persisted.map((event) => event.status),
    ["failed", "completed", "completed"],
  );
  assert.equal(persisted[0].skipReason, "handoff=unknown-participant");
  assert.equal(ports.agentPort.calls[0].participantId, "builder");
  assert.equal(result.activeParticipantId, "builder");
  assert.equal(result.turnsFailed, 1);
  assert.equal(result.turnsCompleted, 2);
  assertAllFakesOnly(ports);
});

test("review and decide expose structured criteria and wouldFlipIf", async () => {
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

  assert.equal(reviewEvent.decision.verdict, "branch");
  assert.deepEqual(reviewEvent.decision.criteria, [
    {
      name: "tests",
      met: false,
      weight: 0.7,
    },
  ]);
  assert.equal(reviewEvent.decision.wouldFlipIf, "tests pass");
  assert.equal(decideEvent.decision.verdict, "accept");
  assert.deepEqual(decideEvent.decision.criteria, [
    {
      name: "all-fakes",
      met: true,
    },
  ]);
  assert.equal(decideEvent.decision.wouldFlipIf, "live call detected");
  assert.equal(result.stopReason, "decision=accept");
  assert.equal(ports.agentPort.calls.length, 2);
  assertAllFakesOnly(ports);
});

test("escape gating rejects by default and allowed escape still avoids WorkspacePort", async () => {
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

  assert.equal(rejected.turnsSkipped, 1);
  assert.equal(
    rejected.telemetry.dialogue_core_escape_request_rejected_count,
    1,
  );
  assert.equal(ports.agentPort.calls.length, 0);
  assert.equal(ports.workspacePort.snapshotCalls.length, 0);
  assert.equal(ports.tracePort.byVisibility("persisted")[0].escape, true);

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

  assert.equal(allowed.turnsCompleted, 1);
  assert.equal(ports.agentPort.calls.length, 1);
  assert.equal(ports.agentPort.calls[0].escape, true);
  assert.equal(ports.agentPort.calls[0].runId, "escape-allowed");
  assert.equal(ports.workspacePort.snapshotCalls.length, 0);
  assert.equal(ports.workspacePort.captureEffectCalls.length, 0);
  assert.equal(ports.validatorPort.calls.length, 0);
  assert.equal(ports.tracePort.byVisibility("persisted")[0].escape, true);
  assertAllFakesOnly(ports);
});

test("all-fakes ports reject live provider, workspace, and validation attempts", async () => {
  const ports = createPorts();
  const liveWorkspacePorts = createPorts({
    workspace: {
      live: true,
    },
  });

  await assert.rejects(
    () =>
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
    /live provider calls are forbidden/,
  );
  await assert.rejects(
    () => liveWorkspacePorts.workspacePort.snapshot(),
    /live workspace calls are forbidden/,
  );
  await assert.rejects(
    () =>
      ports.validatorPort.validate({
        ...validationSpec("live:validate"),
      }),
    /live validation calls are forbidden/,
  );
  assert.deepEqual(ports.liveCallSensor, {
    agent: 1,
    workspace: 0,
    validator: 1,
    trace: 0,
  });
  assert.deepEqual(liveWorkspacePorts.liveCallSensor, {
    agent: 0,
    workspace: 1,
    validator: 0,
    trace: 0,
  });
});
