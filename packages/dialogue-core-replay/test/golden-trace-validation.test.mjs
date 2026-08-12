import { describe, expect, it } from "vitest";

import {
  GoldenTraceValidationError,
  validateGoldenTrace,
} from "../src/index.ts";
import {
  minimalTrace,
  VALID_HASH,
} from "./golden-trace-fixture-builders.mjs";
import { mutableRecord, required } from "./typecheck-helpers.mjs";

const MAX_STRING_BYTES = 1_048_576;
const MAX_COLLECTION_ITEMS = 512;
const MAX_DEPTH = 8;
const MAX_TOTAL_NODES = 4_096;
const MAX_ENCODED_BYTES = 8 * 1_048_576;

/**
 * @typedef {{
 *   runId: string,
 *   runSpec: { participants: unknown[] },
 *   turns: Array<{
 *     agentCalls: Array<{
 *       request: { input: { scopeFiles: unknown[] } },
 *       result: Record<PropertyKey, unknown>
 *     }>
 *   }>
 * }} MutableAgentRequestTrace
 */

/** @returns {MutableAgentRequestTrace} */
function traceWithAgentRequest() {
  return /** @type {MutableAgentRequestTrace} */ (minimalTrace({
    turns: [
      {
        turnId: "turn-1",
        verb: "deliberate",
        agentCalls: [
          {
            request: {
              runId: "run-1",
              runSpecHash: VALID_HASH,
              turnIndex: 0,
              turnType: "deliberate",
              participantId: "participant-1",
              mode: "deliberate",
              input: {
                prompt: "prompt",
                scopeFiles: [],
              },
            },
            result: { raw: "result" },
          },
        ],
        validatorCalls: [],
        workspaceSnapshots: [],
        workspaceEffects: [],
      },
    ],
  }));
}

/** @param {unknown} value */
function expectInvalid(value) {
  expect(() => validateGoldenTrace(value)).toThrow(
    GoldenTraceValidationError,
  );
}

/** @param {number} verbCount */
function nodeBoundaryTrace(verbCount) {
  return minimalTrace({
    verbSequence: Array.from({ length: verbCount }, () => "deliberate"),
    runSpec: {
      mode: "deliberate",
      participants: Array.from({ length: 512 }, () => ({
        id: "p",
        provider: "provider",
        model: "model",
      })),
      turns: Array.from({ length: 512 }, () => ({
        id: "t",
        verb: "deliberate",
      })),
    },
  });
}

/** @param {number} targetBytes */
function encodedBoundaryTrace(targetBytes) {
  const trace = minimalTrace({
    runSpec: {
      mode: "deliberate",
      participants: Array.from({ length: 8 }, (_, index) => ({
        id: `p-${index}`,
        provider: "provider",
        model: "model",
        systemPrompt: "",
      })),
      turns: [],
    },
  });
  let remaining = targetBytes - Buffer.byteLength(JSON.stringify(trace));

  for (const participant of trace.runSpec.participants) {
    const byteCount = Math.min(remaining, MAX_STRING_BYTES);
    mutableRecord(participant).systemPrompt = "x".repeat(byteCount);
    remaining -= byteCount;
  }

  if (remaining !== 0) {
    throw new Error("test builder cannot reach requested encoded size");
  }
  expect(Buffer.byteLength(JSON.stringify(trace))).toBe(targetBytes);
  return trace;
}

describe("validateGoldenTrace exact admission", () => {
  it("rejects unknown top-level and deeply nested keys", () => {
    expectInvalid(minimalTrace({ runId: "" }));
    expectInvalid({ ...minimalTrace(), unknown: true });

    const nested = minimalTrace({
      runSpec: {
        mode: "deliberate",
        participants: [
          { id: "p", provider: "provider", model: "model", unknown: true },
        ],
        turns: [],
      },
    });
    expectInvalid(nested);
  });

  it("rejects invalid verbs and malformed recorded result/effect shapes", () => {
    expectInvalid(
      minimalTrace({
        runSpec: {
          mode: "deliberate",
          participants: [],
          turns: [{ id: "t", verb: "invalid" }],
        },
      }),
    );

    const badResult = traceWithAgentRequest();
    const firstCall = required(
      required(badResult.turns[0], "first trace turn").agentCalls[0],
      "first agent call",
    );
    firstCall.result.extra = true;
    expectInvalid(badResult);

    const badEffect = minimalTrace({
      turns: [
        {
          turnId: "turn-1",
          verb: "implement",
          agentCalls: [],
          validatorCalls: [],
          workspaceSnapshots: [],
          workspaceEffects: [
            {
              effect: {
                diff: "",
                changedFiles: [42],
                postRevision: "rev",
                treeHash: "tree",
                applyStatus: "clean",
              },
            },
          ],
        },
      ],
    });
    expectInvalid(badEffect);
  });

  it.each([
    "sha256:abc",
    `sha256:${"A".repeat(64)}`,
    `sha256:${"g".repeat(64)}`,
    "md5:00000000000000000000000000000000",
  ])("rejects a non-canonical digest: %s", (runSpecHash) => {
    expectInvalid(minimalTrace({ runSpecHash }));
  });

  it("does not invoke accessors while rejecting them", () => {
    let getterCalls = 0;
    const trace = minimalTrace();
    Object.defineProperty(trace, "runId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "run-1";
      },
    });

    expectInvalid(trace);
    expect(getterCalls).toBe(0);
  });

  it("rejects symbols, non-enumerable fields, and class instances", () => {
    const withSymbol = minimalTrace();
    mutableRecord(withSymbol)[Symbol("hidden")] = true;
    expectInvalid(withSymbol);

    const nonEnumerable = minimalTrace();
    Object.defineProperty(nonEnumerable.runSpec, "hidden", {
      value: true,
      enumerable: false,
    });
    expectInvalid(nonEnumerable);

    class TraceRecord {}
    expectInvalid(Object.assign(new TraceRecord(), minimalTrace()));
  });

  it("rejects sparse and augmented arrays", () => {
    const sparse = minimalTrace({ verbSequence: new Array(1) });
    expectInvalid(sparse);

    const augmented = minimalTrace({ verbSequence: [] });
    mutableRecord(augmented.verbSequence).extra = true;
    expectInvalid(augmented);
  });

  it("rejects cycles before recursion can overflow", () => {
    const trace = minimalTrace();
    mutableRecord(trace.runSpec.participants)[0] = trace.runSpec;
    expectInvalid(trace);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["undefined", undefined],
    ["function", () => undefined],
    ["bigint", 1n],
    ["null", null],
  ])("rejects unsupported optional scalar %s", (_label, value) => {
    const trace = minimalTrace();
    mutableRecord(trace.runSpec).maxIterations = value;
    expectInvalid(trace);
  });

  it("enforces the per-string UTF-8 byte boundary", () => {
    expect(validateGoldenTrace(minimalTrace({ runId: "x".repeat(MAX_STRING_BYTES - 1) })).runId)
      .toHaveLength(MAX_STRING_BYTES - 1);
    expect(validateGoldenTrace(minimalTrace({ runId: "x".repeat(MAX_STRING_BYTES) })).runId)
      .toHaveLength(MAX_STRING_BYTES);
    expectInvalid(minimalTrace({ runId: "x".repeat(MAX_STRING_BYTES + 1) }));
  });

  it("enforces the collection item boundary", () => {
    expect(
      validateGoldenTrace(
        minimalTrace({
          verbSequence: Array.from(
            { length: MAX_COLLECTION_ITEMS - 1 },
            () => "review",
          ),
        }),
      ).verbSequence,
    ).toHaveLength(MAX_COLLECTION_ITEMS - 1);
    expect(
      validateGoldenTrace(
        minimalTrace({
          verbSequence: Array.from(
            { length: MAX_COLLECTION_ITEMS },
            () => "review",
          ),
        }),
      ).verbSequence,
    ).toHaveLength(MAX_COLLECTION_ITEMS);
    expectInvalid(
      minimalTrace({
        verbSequence: Array.from(
          { length: MAX_COLLECTION_ITEMS + 1 },
          () => "review",
        ),
      }),
    );
  });

  it(`enforces the container depth boundary of ${MAX_DEPTH}`, () => {
    const below = traceWithAgentRequest();
    expect(validateGoldenTrace(below)).toBeDefined();

    const at = traceWithAgentRequest();
    const atScopeFiles = required(
      required(at.turns[0], "first trace turn").agentCalls[0],
      "first agent call",
    ).request.input.scopeFiles;
    atScopeFiles.push({
      path: "file.txt",
      content: "contents",
    });
    expect(validateGoldenTrace(at)).toBeDefined();

    const above = traceWithAgentRequest();
    const aboveScopeFiles = required(
      required(above.turns[0], "first trace turn").agentCalls[0],
      "first agent call",
    ).request.input.scopeFiles;
    aboveScopeFiles.push({
      path: "file.txt",
      content: { nested: true },
    });
    expectInvalid(above);
  });

  it("enforces the total visited-node boundary", () => {
    expect(validateGoldenTrace(nodeBoundaryTrace(502))).toBeDefined();
    expect(validateGoldenTrace(nodeBoundaryTrace(503))).toBeDefined();
    expectInvalid(nodeBoundaryTrace(504));
    expect(MAX_TOTAL_NODES).toBe(4_096);
  });

  it("enforces the final encoded UTF-8 byte boundary", () => {
    expect(
      validateGoldenTrace(encodedBoundaryTrace(MAX_ENCODED_BYTES - 1)),
    ).toBeDefined();
    expect(
      validateGoldenTrace(encodedBoundaryTrace(MAX_ENCODED_BYTES)),
    ).toBeDefined();
    expectInvalid(encodedBoundaryTrace(MAX_ENCODED_BYTES + 1));
  });

  it("returns a detached deeply frozen tree", () => {
    const input = traceWithAgentRequest();
    const decoded = validateGoldenTrace(input);

    input.runId = "mutated";
    required(
      required(input.turns[0], "first trace turn").agentCalls[0],
      "first agent call",
    ).result.raw = "mutated";
    input.turns.push(required(input.turns[0], "first trace turn"));

    expect(decoded.runId).toBe("run-1");
    expect(
      required(
        required(decoded.turns[0], "decoded first turn").agentCalls[0],
        "decoded first agent call",
      ).result.raw,
    ).toBe("result");
    expect(decoded.turns).toHaveLength(1);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.runSpec)).toBe(true);
    expect(Object.isFrozen(decoded.turns)).toBe(true);
    expect(
      Object.isFrozen(
        required(
          required(decoded.turns[0], "decoded first turn").agentCalls[0],
          "decoded first agent call",
        ).result,
      ),
    ).toBe(true);
  });

  it("keeps diagnostics bounded and never echoes supplied values", () => {
    const sentinel = `SENSITIVE-${"x".repeat(2_000)}`;
    const trace = minimalTrace({ [sentinel]: true });

    try {
      validateGoldenTrace(trace);
      throw new Error("expected validation to fail");
    } catch (error) {
      if (!(error instanceof GoldenTraceValidationError)) {
        throw error;
      }
      expect(error).toBeInstanceOf(GoldenTraceValidationError);
      expect(error.message).not.toContain(sentinel);
      expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(256);
    }
  });
});
