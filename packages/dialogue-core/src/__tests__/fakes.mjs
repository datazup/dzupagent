import { expect } from "vitest";

const secretPattern = /SECRET-[A-Z0-9_-]+/g;

export async function loadDialogueCore() {
  return import("../index.ts");
}

export function createPorts(options = {}) {
  const liveCallSensor = {
    agent: 0,
    workspace: 0,
    validator: 0,
    trace: 0,
  };
  const agentPort = createFakeAgentPort(options.agent ?? {}, liveCallSensor);
  const workspacePort = createFakeWorkspacePort(
    options.workspace ?? {},
    liveCallSensor,
  );
  const validatorPort = createFakeValidatorPort(
    options.validator ?? {},
    liveCallSensor,
  );
  const tracePort = createFakeTracePort(liveCallSensor);
  const redactionPolicy = createFakeRedactionPolicy(options.redaction ?? {});

  return {
    agentPort,
    workspacePort,
    validatorPort,
    tracePort,
    redactionPolicy,
    liveCallSensor,
  };
}

export function assertAllFakesOnly(ports) {
  expect(ports.liveCallSensor).toEqual({
    agent: 0,
    workspace: 0,
    validator: 0,
    trace: 0,
  });
}

export function assertTraceHasNoSecret(tracePort, secret) {
  for (const event of tracePort.events) {
    expect(JSON.stringify(event).includes(secret)).toBe(false);
    expect(event.visibility).not.toBe("raw");
  }
}

export function baseRunSpec(overrides = {}) {
  return {
    mode: "build",
    participants: [
      {
        id: "planner",
        provider: "fake-agent",
        model: "planner-v1",
        role: "planner",
        systemPrompt: "You are a careful planner.",
      },
      {
        id: "builder",
        provider: "fake-agent",
        model: "builder-v1",
        role: "builder",
        systemPrompt: "You are a precise builder.",
      },
      {
        id: "critic",
        provider: "fake-agent",
        model: "critic-v1",
        role: "critic",
        systemPrompt: "You are a skeptical critic.",
      },
    ],
    turns: [],
    ...overrides,
  };
}

export function fixedClock() {
  let tick = 0;

  return {
    now() {
      tick += 1;

      return new Date(Date.UTC(2026, 5, 5, 10, 0, tick));
    },
  };
}

export function validationSpec(commandId = "fake-validate") {
  return {
    commandId,
    args: ["--fake"],
    cwdRoot: "repo",
    sandboxPolicy: "none",
  };
}

function createFakeAgentPort(options, liveCallSensor) {
  const calls = [];
  const responses = [...(options.responses ?? [])];
  const defaultResponse = options.defaultResponse ?? {
    raw: "fake-agent-response",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };

  return {
    calls,
    resetCalls() {
      calls.length = 0;
    },
    async run(request) {
      if (isLiveProvider(request.provider)) {
        liveCallSensor.agent += 1;
        throw new Error("live provider calls are forbidden in all-fakes tests");
      }

      calls.push(clone(request));
      const next = responses.length > 0 ? responses.shift() : defaultResponse;

      if (next instanceof Error) {
        throw next;
      }

      return clone(next);
    },
  };
}

function createFakeWorkspacePort(options, liveCallSensor) {
  const snapshotCalls = [];
  const captureEffectCalls = [];
  const snapshots = [...(options.snapshots ?? [])];
  const effects = [...(options.effects ?? [])];

  return {
    snapshotCalls,
    captureEffectCalls,
    resetCalls() {
      snapshotCalls.length = 0;
      captureEffectCalls.length = 0;
    },
    async snapshot() {
      if (options.live === true) {
        liveCallSensor.workspace += 1;
        throw new Error("live workspace calls are forbidden in all-fakes tests");
      }

      const snapshot = snapshots.shift() ?? {
        baseRevision: `rev-${snapshotCalls.length}`,
        treeHash: `tree-${snapshotCalls.length}`,
      };
      snapshotCalls.push(clone(snapshot));

      return clone(snapshot);
    },
    async captureEffect(beforeSnapshot) {
      if (options.live === true) {
        liveCallSensor.workspace += 1;
        throw new Error("live workspace calls are forbidden in all-fakes tests");
      }

      captureEffectCalls.push(clone(beforeSnapshot));
      const index = captureEffectCalls.length;
      const effect = effects.shift() ?? {
        diff: `diff-${index}`,
        changedFiles: [`file-${index}.ts`],
        postRevision: `post-${index}`,
        treeHash: `post-tree-${index}`,
        applyStatus: "clean",
      };

      return clone(effect);
    },
  };
}

function createFakeValidatorPort(options, liveCallSensor) {
  const calls = [];
  const results = [...(options.results ?? [])];

  return {
    calls,
    resetCalls() {
      calls.length = 0;
    },
    async validate(spec) {
      if (options.live === true || spec.commandId.startsWith("live:")) {
        liveCallSensor.validator += 1;
        throw new Error("live validation calls are forbidden in all-fakes tests");
      }

      calls.push(clone(spec));

      return clone(
        results.shift() ?? {
          ok: true,
          exitCode: 0,
          output: "fake validation passed",
          durationMs: 7,
        },
      );
    },
  };
}

function createFakeTracePort(liveCallSensor) {
  const events = [];

  return {
    events,
    async emit(event) {
      if (event.visibility === "raw") {
        liveCallSensor.trace += 1;
        throw new Error("raw events must not reach TracePort");
      }

      events.push(clone(event));
    },
    byVisibility(visibility) {
      return events.filter((event) => event.visibility === visibility);
    },
    turnEvents(turnType) {
      return events.filter((event) => event.turnType === turnType);
    },
    reset() {
      events.length = 0;
    },
  };
}

function createFakeRedactionPolicy(options) {
  const calls = [];
  const replacement = options.replacement ?? "[REDACTED]";

  return {
    calls,
    redact(event) {
      calls.push(clone(event));

      return {
        persisted: toPersistedEvent(event, replacement),
        stream: toStreamEvent(event, replacement),
      };
    },
  };
}

function toPersistedEvent(event, replacement) {
  return stripUndefined({
    ...baseEvent(event),
    visibility: "persisted",
    input:
      event.input === undefined
        ? undefined
        : stripUndefined({
            role: event.input.role,
            systemPromptRedacted: redactText(event.input.systemPrompt, replacement),
            scopeFiles: scrubValue(event.input.scopeFiles, replacement),
            promptRedacted: redactText(event.input.prompt, replacement),
          }),
    output:
      event.output === undefined
        ? undefined
        : stripUndefined({
            rawRedacted: redactText(event.output.raw, replacement),
            usage: clone(event.output.usage),
          }),
    workspace:
      event.workspace === undefined
        ? undefined
        : stripUndefined({
            ...event.workspace,
            diff: undefined,
            diffRedacted: redactText(event.workspace.diff, replacement),
          }),
    validation:
      event.validation === undefined
        ? undefined
        : stripUndefined({
            ...event.validation,
            output: undefined,
            outputRedacted: redactText(event.validation.output, replacement),
          }),
  });
}

function toStreamEvent(event, replacement) {
  return stripUndefined({
    ...baseEvent(event),
    visibility: "stream",
    input:
      event.input === undefined
        ? undefined
        : stripUndefined({
            role: event.input.role,
            systemPromptPreview: preview(redactText(event.input.systemPrompt, replacement)),
            promptPreview: preview(redactText(event.input.prompt, replacement)),
          }),
    output:
      event.output === undefined
        ? undefined
        : stripUndefined({
            rawPreview: preview(redactText(event.output.raw, replacement)),
            usage: clone(event.output.usage),
          }),
    workspace:
      event.workspace === undefined
        ? undefined
        : stripUndefined({
            ...event.workspace,
            diff: undefined,
            diffPreview: preview(redactText(event.workspace.diff, replacement)),
          }),
    validation:
      event.validation === undefined
        ? undefined
        : stripUndefined({
            ...event.validation,
            output: undefined,
            outputPreview: preview(redactText(event.validation.output, replacement)),
          }),
  });
}

function baseEvent(event) {
  return stripUndefined({
    runId: event.runId,
    runSpecHash: event.runSpecHash,
    turnIndex: event.turnIndex,
    turnType: event.turnType,
    participantId: event.participantId,
    provider: event.provider,
    model: event.model,
    mode: event.mode,
    decision: scrubValue(event.decision, "[REDACTED]"),
    cost: scrubValue(event.cost, "[REDACTED]"),
    timing: clone(event.timing),
    escape: event.escape,
    status: event.status,
    skipReason: event.skipReason,
  });
}

function isLiveProvider(provider) {
  return (
    typeof provider === "string" &&
    /claude|codex|gemini|openai|openrouter|live/i.test(provider)
  );
}

function redactText(value, replacement) {
  if (typeof value !== "string") {
    return value;
  }

  return value.replace(secretPattern, replacement);
}

function scrubValue(value, replacement) {
  if (typeof value === "string") {
    return redactText(value, replacement);
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, replacement));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        scrubValue(item, replacement),
      ]),
    );
  }

  return value;
}

function preview(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value.slice(0, 80);
}

function stripUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
