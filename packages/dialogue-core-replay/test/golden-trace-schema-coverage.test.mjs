import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as core from "../../dialogue-core/src/index.ts";
import {
  GoldenTraceValidationError,
  loadGoldenTrace,
  replayDialogue,
  validateGoldenTrace,
} from "../src/index.ts";
import {
  maximalTrace,
  minimalTrace,
} from "./golden-trace-fixture-builders.mjs";
import { mutableRecord, required } from "./typecheck-helpers.mjs";

/** @typedef {import("./typecheck-types.d.ts").DeepMutable<import("../src/golden-trace.ts").GoldenTrace>} MutableGoldenTrace */

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

/** @param {unknown} value */
function expectInvalid(value) {
  expect(() => validateGoldenTrace(value)).toThrow(
    GoldenTraceValidationError,
  );
}

/**
 * @param {import("../../dialogue-core/src/index.ts").DialogueSchedulerPorts} ports
 * @param {import("../../dialogue-core/src/index.ts").DialogueSchedulerOptions | undefined} options
 */
function schedulerFactory(ports, options) {
  return new core.DialogueScheduler(ports, options);
}

/**
 * @param {unknown} value
 * @param {WeakSet<object>} [visited]
 */
function expectDeeplyFrozen(value, visited = new WeakSet()) {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return;
  }
  visited.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if ("value" in descriptor) {
      expectDeeplyFrozen(descriptor.value, visited);
    }
  }
}

/** @param {MutableGoldenTrace | import("../src/golden-trace.ts").GoldenTrace} trace */
function firstRunTurn(trace) {
  return required(trace.runSpec.turns[0], "first run turn");
}

/** @param {MutableGoldenTrace | import("../src/golden-trace.ts").GoldenTrace} trace */
function firstRecordedTurn(trace) {
  return required(trace.turns[0], "first recorded turn");
}

/** @param {MutableGoldenTrace | import("../src/golden-trace.ts").GoldenTrace} trace */
function firstAgentCall(trace) {
  return required(firstRecordedTurn(trace).agentCalls[0], "first agent call");
}

/** @param {MutableGoldenTrace | import("../src/golden-trace.ts").GoldenTrace} trace */
function firstValidatorCall(trace) {
  return required(
    firstRecordedTurn(trace).validatorCalls[0],
    "first validator call",
  );
}

/** @param {MutableGoldenTrace | import("../src/golden-trace.ts").GoldenTrace} trace */
function firstWorkspaceEffect(trace) {
  return required(
    firstRecordedTurn(trace).workspaceEffects[0],
    "first workspace effect",
  );
}

describe("GoldenTrace schema coverage", () => {
  it("admits the minimal shape with every optional key absent", () => {
    const decoded = validateGoldenTrace(minimalTrace());

    expect(decoded).toEqual(minimalTrace());
    expectDeeplyFrozen(decoded);
  });

  it("decodes every optional field in every nested record", () => {
    const input = maximalTrace();
    const decoded = validateGoldenTrace(input);

    expect(decoded).toEqual(input);
    expect(decoded).not.toBe(input);
    expect(decoded.runSpec).not.toBe(input.runSpec);
    const decodedRequest = required(
      firstAgentCall(decoded).request,
      "decoded agent request",
    );
    const inputRequest = required(
      firstAgentCall(input).request,
      "input agent request",
    );
    expect(
      required(decodedRequest.input.scopeFiles, "decoded scope files")[0],
    ).not.toBe(required(inputRequest.input.scopeFiles, "input scope files")[0]);
    expectDeeplyFrozen(decoded);
  });

  it.each([
    "done-path.golden.json",
    "escalate-path.golden.json",
    "branch-fork-merge.golden.json",
  ])("loads and replays the existing fixture %s", async (fixtureName) => {
    const json = await readFile(
      path.join(fixturesDirectory, fixtureName),
      "utf8",
    );
    const decoded = loadGoldenTrace(json);
    const result = await replayDialogue(decoded, schedulerFactory);

    expect(result.actualRunSpecHash).toBe(decoded.runSpecHash);
    expect(result.actualVerbSequence).toEqual(decoded.verbSequence);
    expectDeeplyFrozen(decoded);
  });

  it("admits both exact decide-policy variants", () => {
    const agentPolicy = maximalTrace();
    expect(validateGoldenTrace(agentPolicy).runSpec.decidePolicy).toEqual({
      kind: "agent",
      participantId: "participant-1",
    });

    const rulePolicy = maximalTrace();
    rulePolicy.runSpec.decidePolicy = { kind: "rule", ruleId: "rule-1" };
    expect(validateGoldenTrace(rulePolicy).runSpec.decidePolicy).toEqual({
      kind: "rule",
      ruleId: "rule-1",
    });
  });

  it("rejects contradictory and missing decide-policy fields", () => {
    for (const decidePolicy of [
      { kind: "agent", participantId: "p", ruleId: "r" },
      { kind: "rule", participantId: "p", ruleId: "r" },
      { kind: "agent" },
      { kind: "rule" },
      { kind: "unknown", ruleId: "r" },
    ]) {
      const input = maximalTrace();
      mutableRecord(input.runSpec).decidePolicy = decidePolicy;
      expectInvalid(input);
    }
  });

  it.each(
    /** @type {import("../../dialogue-core/src/index.ts").DirtyPolicy[]} */ ([
      "reject",
      "isolate",
      "allow",
    ]),
  )(
    "admits dirtyPolicy literal %s",
    (dirtyPolicy) => {
      const input = maximalTrace();
      input.runSpec.dirtyPolicy = dirtyPolicy;
      expect(validateGoldenTrace(input).runSpec.dirtyPolicy).toBe(dirtyPolicy);
    },
  );

  it.each(
    /** @type {import("../../dialogue-core/src/index.ts").SandboxPolicy[]} */ ([
      "none",
      "read-only",
      "workspace-write",
    ]),
  )(
    "admits sandboxPolicy literal %s",
    (sandboxPolicy) => {
      const input = maximalTrace();
      required(firstRunTurn(input).validation, "validation spec").sandboxPolicy =
        sandboxPolicy;
      expect(
        required(
          firstRunTurn(validateGoldenTrace(input)).validation,
          "decoded validation spec",
        ).sandboxPolicy,
      ).toBe(sandboxPolicy);
    },
  );

  it.each(
    /** @type {Array<import("../../dialogue-core/src/index.ts").WorkspaceEffect["applyStatus"]>} */ ([
      "clean",
      "partial",
      "failed",
      "no-op",
    ]),
  )(
    "admits workspace applyStatus literal %s",
    (applyStatus) => {
      const input = maximalTrace();
      firstWorkspaceEffect(input).effect.applyStatus = applyStatus;
      expect(
        firstWorkspaceEffect(validateGoldenTrace(input)).effect.applyStatus,
      ).toBe(applyStatus);
    },
  );

  it("admits every turn verb and rejects an unsupported verb at each site", () => {
    /** @type {import("../../dialogue-core/src/index.ts").TurnVerb[]} */
    const verbs = [
      "deliberate",
      "implement",
      "validate",
      "review",
      "decide",
      "handoff",
    ];
    const valid = minimalTrace({ verbSequence: verbs });
    expect(validateGoldenTrace(valid).verbSequence).toEqual(verbs);

    const invalidSequence = minimalTrace({ verbSequence: ["unknown"] });
    expectInvalid(invalidSequence);
    const invalidRunTurn = maximalTrace();
    mutableRecord(firstRunTurn(invalidRunTurn)).verb = "unknown";
    expectInvalid(invalidRunTurn);
    const invalidRecordedTurn = maximalTrace();
    mutableRecord(firstRecordedTurn(invalidRecordedTurn)).verb = "unknown";
    expectInvalid(invalidRecordedTurn);
    const invalidRequest = maximalTrace();
    mutableRecord(
      required(firstAgentCall(invalidRequest).request, "agent request"),
    ).turnType = "unknown";
    expectInvalid(invalidRequest);
  });

  it("rejects unsupported enum literals", () => {
    /** @type {Array<(input: MutableGoldenTrace) => void>} */
    const mutations = [
      (input) => {
        mutableRecord(input.runSpec).mode = "unknown";
      },
      (input) => {
        mutableRecord(input.runSpec).dirtyPolicy = "unknown";
      },
      (input) => {
        mutableRecord(
          required(firstRunTurn(input).validation, "validation spec"),
        ).sandboxPolicy = "unknown";
      },
      (input) => {
        mutableRecord(firstWorkspaceEffect(input).effect).applyStatus = "unknown";
      },
    ];
    for (const mutate of mutations) {
      const input = maximalTrace();
      mutate(input);
      expectInvalid(input);
    }
  });

  it("enforces finite and field-specific number constraints", () => {
    /** @type {Array<(input: MutableGoldenTrace) => void>} */
    const mutations = [
      (input) => {
        input.runSpec.maxIterations = -1;
      },
      (input) => {
        required(
          required(input.runSpec.loops, "run loops")[0],
          "first run loop",
        ).maxIterations = 0.5;
      },
      (input) => {
        required(input.runSpec.budget, "run budget").maxUsd = -0.01;
      },
      (input) => {
        required(input.runSpec.budget, "run budget").maxInputTokens =
          Number.MAX_SAFE_INTEGER + 1;
      },
      (input) => {
        required(firstRunTurn(input).validation, "validation spec").timeoutMs =
          Number.POSITIVE_INFINITY;
      },
      (input) => {
        required(firstAgentCall(input).request, "agent request").turnIndex = -1;
      },
      (input) => {
        required(firstAgentCall(input).result.usage, "agent usage").totalTokens =
          1.5;
      },
      (input) => {
        firstValidatorCall(input).result.exitCode = 0.5;
      },
      (input) => {
        firstValidatorCall(input).result.durationMs = -1;
      },
    ];
    for (const mutate of mutations) {
      const input = maximalTrace();
      mutate(input);
      expectInvalid(input);
    }
  });

  it("admits zero counters, a fractional non-negative budget, and integer exit codes", () => {
    const input = maximalTrace();
    input.runSpec.maxIterations = 0;
    required(
      required(input.runSpec.loops, "run loops")[0],
      "first run loop",
    ).maxIterations = 0;
    input.runSpec.budget = {
      maxUsd: 0.25,
      maxInputTokens: 0,
      maxOutputTokens: 0,
    };
    required(firstAgentCall(input).request, "agent request").turnIndex = 0;
    firstAgentCall(input).result.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    firstValidatorCall(input).result.exitCode = -1;
    firstValidatorCall(input).result.durationMs = 0;

    expect(validateGoldenTrace(input)).toEqual(input);
  });

  it("rejects explicit undefined instead of treating it as omission", () => {
    /** @type {Array<(input: MutableGoldenTrace) => void>} */
    const mutations = [
      (input) => {
        mutableRecord(
          required(input.runSpec.participants[0], "first participant"),
        ).role = undefined;
      },
      (input) => {
        mutableRecord(firstRunTurn(input)).prompt = undefined;
      },
      (input) => {
        mutableRecord(
          required(firstAgentCall(input).request, "agent request"),
        ).provider = undefined;
      },
      (input) => {
        mutableRecord(firstWorkspaceEffect(input)).beforeSnapshot = undefined;
      },
    ];
    for (const mutate of mutations) {
      const input = maximalTrace();
      mutate(input);
      expectInvalid(input);
    }
  });

  it("rejects missing required keys throughout the nested schema", () => {
    /** @type {Array<(input: MutableGoldenTrace) => void>} */
    const mutations = [
      (input) => {
        delete mutableRecord(input.runSpec).mode;
      },
      (input) => {
        delete mutableRecord(
          required(input.runSpec.participants[0], "first participant"),
        ).provider;
      },
      (input) => {
        const branch = required(firstRunTurn(input).branch, "turn branch");
        const firstPath = required(branch.paths[0], "first branch path");
        delete mutableRecord(firstPath.condition).expression;
      },
      (input) => {
        delete mutableRecord(
          required(firstAgentCall(input).request, "agent request").input,
        ).prompt;
      },
      (input) => {
        delete mutableRecord(firstValidatorCall(input).result).ok;
      },
      (input) => {
        delete mutableRecord(firstWorkspaceEffect(input).effect).changedFiles;
      },
    ];
    for (const mutate of mutations) {
      const input = maximalTrace();
      mutate(input);
      expectInvalid(input);
    }
  });
});
