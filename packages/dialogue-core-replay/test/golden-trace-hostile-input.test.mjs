import { describe, expect, it } from "vitest";

import {
  GoldenTraceValidationError,
  loadGoldenTrace,
  validateGoldenTrace,
} from "../src/index.ts";
import {
  maximalTrace,
  minimalTrace,
} from "./golden-trace-fixture-builders.mjs";
import { mutableRecord, required } from "./typecheck-helpers.mjs";

/** @typedef {import("./typecheck-types.d.ts").DeepMutable<import("../src/golden-trace.ts").GoldenTrace>} MutableGoldenTrace */

const MAX_STRING_BYTES = 1_048_576;
const MAX_ENCODED_BYTES = 8 * 1_048_576;

/** @param {unknown} value */
function expectInvalid(value) {
  expect(() => validateGoldenTrace(value)).toThrow(
    GoldenTraceValidationError,
  );
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

/** @param {unknown} value */
function loadUntrusted(value) {
  return Reflect.apply(loadGoldenTrace, undefined, [value]);
}

describe("GoldenTrace hostile JavaScript input", () => {
  it("rejects a Proxy without running any traps", () => {
    let trapCalls = 0;
    const trap = () => {
      trapCalls += 1;
      throw new Error("trap must not run");
    };
    const proxy = new Proxy(minimalTrace(), {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    });

    expectInvalid(proxy);
    expect(trapCalls).toBe(0);
  });

  it("rejects a revoked Proxy without leaking its runtime exception", () => {
    const revocable = Proxy.revocable(minimalTrace(), {});
    revocable.revoke();

    expectInvalid(revocable.proxy);
  });

  it("rejects nested record and array accessors without invoking them", () => {
    let getterCalls = 0;
    const recordAccessor = maximalTrace();
    Object.defineProperty(
      firstAgentCall(recordAccessor).result,
      "raw",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "result";
        },
      },
    );
    expectInvalid(recordAccessor);

    const arrayAccessor = minimalTrace({ verbSequence: ["review"] });
    Object.defineProperty(arrayAccessor.verbSequence, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "review";
      },
    });
    expectInvalid(arrayAccessor);
    expect(getterCalls).toBe(0);
  });

  it("does not invoke toJSON, iterators, or coercion hooks", () => {
    let hookCalls = 0;
    const withToJson = minimalTrace();
    mutableRecord(withToJson.runSpec).toJSON = () => {
      hookCalls += 1;
      return {};
    };
    expectInvalid(withToJson);

    const withIterator = minimalTrace();
    Object.defineProperty(withIterator.verbSequence, Symbol.iterator, {
      configurable: true,
      value() {
        hookCalls += 1;
        return [][Symbol.iterator]();
      },
    });
    expectInvalid(withIterator);

    const withCoercion = minimalTrace();
    Object.defineProperty(withCoercion.runSpec, Symbol.toPrimitive, {
      configurable: true,
      value() {
        hookCalls += 1;
        return "coerced";
      },
    });
    expectInvalid(withCoercion);
    expect(hookCalls).toBe(0);
  });

  it("rejects custom array prototypes and non-enumerable elements", () => {
    const customPrototype = minimalTrace({ verbSequence: [] });
    Object.setPrototypeOf(customPrototype.verbSequence, Object.create(Array.prototype));
    expectInvalid(customPrototype);

    const hiddenElement = minimalTrace({ verbSequence: ["review"] });
    Object.defineProperty(hiddenElement.verbSequence, "0", {
      configurable: true,
      enumerable: false,
      value: "review",
      writable: true,
    });
    expectInvalid(hiddenElement);
  });

  it("accepts null-prototype data records and still returns ordinary frozen clones", () => {
    const input = Object.assign(Object.create(null), minimalTrace());
    input.runSpec = Object.assign(Object.create(null), input.runSpec);

    const decoded = validateGoldenTrace(input);

    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(decoded.runSpec)).toBe(Object.prototype);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.runSpec)).toBe(true);
  });

  it("clones shared caller aliases into independent output records", () => {
    const participant = {
      id: "participant",
      provider: "fixture",
      model: "model",
    };
    const input = minimalTrace({
      runSpec: {
        mode: "deliberate",
        participants: [participant, participant],
        turns: [],
      },
    });

    const decoded = validateGoldenTrace(input);
    participant.model = "mutated";

    const firstParticipant = required(
      decoded.runSpec.participants[0],
      "first participant",
    );
    const secondParticipant = required(
      decoded.runSpec.participants[1],
      "second participant",
    );
    expect(firstParticipant.model).toBe("model");
    expect(secondParticipant.model).toBe("model");
    expect(firstParticipant).not.toBe(
      secondParticipant,
    );
  });

  it("prevents mutation of every returned container", () => {
    const decoded = validateGoldenTrace(maximalTrace());

    expect(() => {
      mutableRecord(
        required(decoded.runSpec.participants[0], "first participant"),
      ).model = "mutated";
    }).toThrow(TypeError);
    expect(() => {
      const mutableTurns = /** @type {MutableGoldenTrace["turns"]} */ (
        decoded.turns
      );
      mutableTurns.push(required(mutableTurns[0], "first recorded turn"));
    }).toThrow(TypeError);
    expect(() => {
      const validatorCall = required(
        firstRecordedTurn(decoded).validatorCalls[0],
        "first validator call",
      );
      mutableRecord(
        required(validatorCall.spec, "validator spec").env,
      ).NEW_KEY = "value";
    }).toThrow(TypeError);
  });

  it("handles prototype-sensitive environment keys without pollution", () => {
    const input = maximalTrace();
    required(firstRunTurn(input).validation, "validation spec").env = JSON.parse(
      '{"__proto__":"data","constructor":"also-data"}',
    );

    const decoded = validateGoldenTrace(input);
    const env = required(
      required(firstRunTurn(decoded).validation, "decoded validation spec").env,
      "decoded environment",
    );

    expect(Object.hasOwn(env, "__proto__")).toBe(true);
    expect(env.__proto__).toBe("data");
    expect(env.constructor).toBe("also-data");
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    expect(mutableRecord({}).polluted).toBeUndefined();
  });

  it("rejects hostile environment descriptors without invoking them", () => {
    let getterCalls = 0;
    const input = maximalTrace();
    const env = required(
      required(firstRunTurn(input).validation, "validation spec").env,
      "input environment",
    );
    Object.defineProperty(env, "SECRET", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "hidden";
      },
    });

    expectInvalid(input);
    expect(getterCalls).toBe(0);
  });

  it("counts UTF-8 bytes rather than UTF-16 code units", () => {
    const atLimit = "é".repeat(MAX_STRING_BYTES / 2);
    const decoded = validateGoldenTrace(minimalTrace({ runId: atLimit }));
    expect(decoded.runId).toHaveLength(MAX_STRING_BYTES / 2);

    expectInvalid(minimalTrace({ runId: `${atLimit}a` }));
  });

  it("rejects unsupported symbol values at a documented field", () => {
    const input = minimalTrace();
    mutableRecord(input.runSpec).maxIterations = Symbol("unsupported");
    expectInvalid(input);
  });
});

describe("loadGoldenTrace hostile text input", () => {
  it("never coerces a non-string input", () => {
    let coercionCalls = 0;
    const input = {
      toString() {
        coercionCalls += 1;
        return JSON.stringify(minimalTrace());
      },
    };

    expect(() => loadUntrusted(input)).toThrow(GoldenTraceValidationError);
    expect(coercionCalls).toBe(0);
  });

  it("bounds parse diagnostics without echoing parser or input text", () => {
    const sentinel = `SENSITIVE-${"x".repeat(2_000)}`;

    try {
      loadGoldenTrace(`{"runId":"${sentinel}",`);
      throw new Error("expected parse failure");
    } catch (error) {
      if (!(error instanceof GoldenTraceValidationError)) {
        throw error;
      }
      expect(error).toBeInstanceOf(GoldenTraceValidationError);
      expect(error.message).not.toContain(sentinel);
      expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(256);
    }
  });

  it("bounds JSON text before parsing", () => {
    expect(() => loadGoldenTrace(" ".repeat(MAX_ENCODED_BYTES + 1))).toThrow(
      GoldenTraceValidationError,
    );
  });
});
