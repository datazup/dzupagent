import { describe, expect, it } from "vitest";

import * as replay from "../src/index.ts";
import {
  manifestFor,
  manifestForBytes,
  minimalTraceJson,
  payloadBytesFor,
  payloadFor,
  utf8Bytes,
} from "./golden-trace-fixture-manifest-builders.mjs";
import { mutableRecord, required } from "./typecheck-helpers.mjs";

const MAX_MANIFEST_BYTES = 64 * 1_024;
const MAX_PAYLOAD_BYTES = 8 * 1_048_576;

function manifestValidator() {
  expect(replay.validateGoldenTraceFixtureManifestV1).toBeTypeOf("function");
  return replay.validateGoldenTraceFixtureManifestV1;
}

function fixtureLoader() {
  expect(replay.loadGoldenTraceFixtureV1).toBeTypeOf("function");
  return replay.loadGoldenTraceFixtureV1;
}

/**
 * @param {() => unknown} run
 * @returns {InstanceType<typeof replay.GoldenTraceFixtureValidationError>}
 */
function captureFailure(run) {
  try {
    run();
    throw new Error("expected fixture admission to fail");
  } catch (error) {
    if (!(error instanceof replay.GoldenTraceFixtureValidationError)) {
      throw error;
    }
    expect(error).toBeInstanceOf(replay.GoldenTraceFixtureValidationError);
    expect(typeof error.code).toBe("string");
    expect(
      ["$manifest", "$payloads", "$fixture"].some(
        (root) =>
          error.location === root ||
          error.location.startsWith(`${root}.`) ||
          error.location.startsWith(`${root}[`),
      ),
    ).toBe(true);
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(256);
    return error;
  }
}

/**
 * @param {unknown} manifestJson
 * @param {unknown} payloads
 */
function loadFixtureUntrusted(manifestJson, payloads) {
  return Reflect.apply(fixtureLoader(), undefined, [manifestJson, payloads]);
}

function validBundle() {
  const utf8 = minimalTraceJson();
  const manifest = manifestFor("hostile", utf8);
  return { manifest, manifestJson: JSON.stringify(manifest), utf8 };
}

describe("GoldenTrace fixture hostile input", () => {
  it("never coerces manifest or payload text", () => {
    let coercionCalls = 0;
    const hostileText = {
      toString() {
        coercionCalls += 1;
        return "{}";
      },
    };
    const { manifest, manifestJson } = validBundle();

    captureFailure(() => loadFixtureUntrusted(hostileText, []));
    captureFailure(() =>
      fixtureLoader()(manifestJson, [
        {
          path: required(manifest.files[0], "manifest file").path,
          bytes: hostileText,
        },
      ]),
    );
    expect(coercionCalls).toBe(0);
  });

  it("bounds manifest parse diagnostics without echoing input", () => {
    const sentinel = `SENSITIVE-${"x".repeat(2_000)}`;
    const failure = captureFailure(() =>
      fixtureLoader()(`{\"fixtureId\":\"${sentinel}\",`, []),
    );

    expect(failure.code).toBe("MANIFEST_JSON_INVALID");
    expect(failure.message).not.toContain(sentinel);
  });

  it("rejects manifest Proxies without running traps", () => {
    let trapCalls = 0;
    const trap = () => {
      trapCalls += 1;
      throw new Error("trap must not run");
    };
    const proxy = new Proxy(validBundle().manifest, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    });

    captureFailure(() => manifestValidator()(proxy));
    expect(trapCalls).toBe(0);
  });

  it("rejects accessors, symbols, non-enumerables, and custom prototypes without hooks", () => {
    let getterCalls = 0;
    const accessor = validBundle().manifest;
    Object.defineProperty(accessor.bindings.source, "baseCommit", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "untrusted";
      },
    });
    captureFailure(() => manifestValidator()(accessor));

    const symbol = validBundle().manifest;
    mutableRecord(symbol)[Symbol("hidden")] = true;
    captureFailure(() => manifestValidator()(symbol));

    const nonEnumerable = validBundle().manifest;
    Object.defineProperty(nonEnumerable.privacy, "hidden", {
      enumerable: false,
      value: true,
    });
    captureFailure(() => manifestValidator()(nonEnumerable));

    class Manifest {}
    captureFailure(() =>
      manifestValidator()(Object.assign(new Manifest(), validBundle().manifest)),
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects sparse or augmented arrays, cycles, and unsupported scalars", () => {
    const sparse = validBundle().manifest;
    sparse.files = new Array(1);
    captureFailure(() => manifestValidator()(sparse));

    const augmented = validBundle().manifest;
    mutableRecord(augmented.files).extra = true;
    captureFailure(() => manifestValidator()(augmented));

    const cyclic = validBundle().manifest;
    mutableRecord(cyclic.bindings).source = cyclic.bindings;
    captureFailure(() => manifestValidator()(cyclic));

    for (const value of [undefined, null, 1n, Symbol("value"), () => undefined]) {
      const unsupported = validBundle().manifest;
      mutableRecord(unsupported).fixtureId = value;
      captureFailure(() => manifestValidator()(unsupported));
    }
  });

  it("accepts null-prototype records and returns detached deeply frozen records", () => {
    const input = validBundle().manifest;
    input.bindings = Object.assign(Object.create(null), input.bindings);
    const decoded = manifestValidator()(input);

    input.fixtureId = "mutated";
    input.bindings.runtimeTarget = "mutated";
    expect(decoded.fixtureId).toBe("hostile");
    expect(decoded.bindings.runtimeTarget).toBe("node20-esm");
    expect(Object.getPrototypeOf(decoded.bindings)).toBe(Object.prototype);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.bindings)).toBe(true);
    expect(Object.isFrozen(decoded.files)).toBe(true);
    expect(() => {
      mutableRecord(decoded.privacy).classification = "mutated";
    }).toThrow(TypeError);
  });

  it("decodes shared aliases independently", () => {
    const input = validBundle().manifest;
    mutableRecord(input.bindings).source = input.custody;
    captureFailure(() => manifestValidator()(input));

    const privacy = input.privacy;
    const second = validBundle().manifest;
    second.privacy = privacy;
    const decoded = manifestValidator()(second);
    privacy.authorship = "mutated";
    expect(decoded.privacy.authorship).toBe("datazup");
  });

  it("rejects hostile payload records and arrays without invoking accessors", () => {
    const { manifest, manifestJson, utf8 } = validBundle();
    let getterCalls = 0;
    const payloads = payloadFor(manifest, utf8);
    Object.defineProperty(required(payloads[0], "payload"), "bytes", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return utf8Bytes(utf8);
      },
    });
    captureFailure(() => fixtureLoader()(manifestJson, payloads));

    const augmented = payloadFor(manifest, utf8);
    mutableRecord(augmented).extra = true;
    captureFailure(() => fixtureLoader()(manifestJson, augmented));

    let trapCalls = 0;
    const trap = () => {
      trapCalls += 1;
      throw new Error("trap must not run");
    };
    const proxy = new Proxy(payloadFor(manifest, utf8), {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    });
    captureFailure(() => fixtureLoader()(manifestJson, proxy));
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);
  });

  it("rejects byte-view Proxies, Buffers, custom prototypes, and shared memory", () => {
    const { manifest, manifestJson, utf8 } = validBundle();
    const bytes = utf8Bytes(utf8);
    let trapCalls = 0;
    const trap = () => {
      trapCalls += 1;
      throw new Error("trap must not run");
    };
    const proxyBytes = new Proxy(bytes, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    });
    captureFailure(() =>
      fixtureLoader()(manifestJson, [
        {
          path: required(manifest.files[0], "manifest file").path,
          bytes: proxyBytes,
        },
      ]),
    );

    captureFailure(() =>
      fixtureLoader()(manifestJson, [
        {
          path: required(manifest.files[0], "manifest file").path,
          bytes: Buffer.from(utf8, "utf8"),
        },
      ]),
    );

    const customPrototype = utf8Bytes(utf8);
    Object.setPrototypeOf(
      customPrototype,
      Object.create(ArrayBuffer.prototype),
    );
    captureFailure(() =>
      fixtureLoader()(manifestJson, [
        {
          path: required(manifest.files[0], "manifest file").path,
          bytes: customPrototype,
        },
      ]),
    );

    const sharedBytes = new SharedArrayBuffer(bytes.byteLength);
    new Uint8Array(sharedBytes).set(new Uint8Array(bytes));
    captureFailure(() =>
      fixtureLoader()(manifestJson, [
        {
          path: required(manifest.files[0], "manifest file").path,
          bytes: sharedBytes,
        },
      ]),
    );
    expect(trapCalls).toBe(0);
  });

  it("rejects every own byte-buffer property without invoking accessors", () => {
    const { manifest, manifestJson, utf8 } = validBundle();
    let getterCalls = 0;
    const accessorBytes = utf8Bytes(utf8);
    Object.defineProperty(accessorBytes, "hidden", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "hidden";
      },
    });
    captureFailure(() =>
      fixtureLoader()(manifestJson, [
        {
          path: required(manifest.files[0], "manifest file").path,
          bytes: accessorBytes,
        },
      ]),
    );

    const symbolBytes = utf8Bytes(utf8);
    mutableRecord(symbolBytes)[Symbol("hidden")] = true;
    captureFailure(() =>
      fixtureLoader()(manifestJson, [
        {
          path: required(manifest.files[0], "manifest file").path,
          bytes: symbolBytes,
        },
      ]),
    );

    const nonEnumerableBytes = utf8Bytes(utf8);
    Object.defineProperty(nonEnumerableBytes, "hidden", {
      value: true,
      enumerable: false,
    });
    captureFailure(() =>
      fixtureLoader()(manifestJson, [
        {
          path: required(manifest.files[0], "manifest file").path,
          bytes: nonEnumerableBytes,
        },
      ]),
    );
    expect(getterCalls).toBe(0);
  });

  it("hashes a detached byte copy and rejects malformed UTF-8 before JSON parsing", () => {
    const { manifest, manifestJson, utf8 } = validBundle();
    const bytes = utf8Bytes(utf8);
    const admission = fixtureLoader()(
      manifestJson,
      payloadBytesFor(manifest, bytes),
    );
    new Uint8Array(bytes).fill(32);
    expect(admission.trace.runId).toBe("fixture-run");

    const malformedBytes = Uint8Array.from([0xc3, 0x28]).buffer;
    const malformedManifest = manifestForBytes("hostile", malformedBytes);
    expect(
      captureFailure(() =>
        fixtureLoader()(
          JSON.stringify(malformedManifest),
          payloadBytesFor(malformedManifest, malformedBytes),
        ),
      ).code,
    ).toBe("TRACE_INVALID");
  });

  it("does not invoke manifest serialization, iteration, or coercion hooks", () => {
    let hookCalls = 0;
    const withToJson = validBundle().manifest;
    mutableRecord(withToJson).toJSON = () => {
      hookCalls += 1;
      return {};
    };
    captureFailure(() => manifestValidator()(withToJson));

    const withIterator = validBundle().manifest;
    Object.defineProperty(withIterator.files, Symbol.iterator, {
      configurable: true,
      value() {
        hookCalls += 1;
        return [][Symbol.iterator]();
      },
    });
    captureFailure(() => manifestValidator()(withIterator));

    const withCoercion = validBundle().manifest;
    Object.defineProperty(withCoercion.bindings, Symbol.toPrimitive, {
      configurable: true,
      value() {
        hookCalls += 1;
        return "coerced";
      },
    });
    captureFailure(() => manifestValidator()(withCoercion));
    expect(hookCalls).toBe(0);
  });

  it("enforces container-depth and total-node ceilings", () => {
    const tooDeep = validBundle().manifest;
    mutableRecord(tooDeep.bindings.source).baseCommit = { nested: true };
    expect(captureFailure(() => manifestValidator()(tooDeep)).code).toBe(
      "MANIFEST_DEPTH_LIMIT",
    );

    const tooManyNodes = validBundle().manifest;
    for (let index = 0; index < 129; index += 1) {
      mutableRecord(tooManyNodes)[`unknown${index}`] = index;
    }
    expect(captureFailure(() => manifestValidator()(tooManyNodes)).code).toBe(
      "MANIFEST_NODE_LIMIT",
    );
  });

  it("bounds manifest text before parsing at one below, at, and one above", () => {
    const { manifest, utf8 } = validBundle();
    const compact = JSON.stringify(manifest);
    for (const target of [MAX_MANIFEST_BYTES - 1, MAX_MANIFEST_BYTES]) {
      const manifestJson = compact.padEnd(target, " ");
      expect(Buffer.byteLength(manifestJson, "utf8")).toBe(target);
      expect(fixtureLoader()(manifestJson, payloadFor(manifest, utf8)).trace).toBeDefined();
    }

    const oversized = compact.padEnd(MAX_MANIFEST_BYTES + 1, " ");
    expect(captureFailure(() => fixtureLoader()(oversized, payloadFor(manifest, utf8))).code)
      .toBe("MANIFEST_BYTES_LIMIT");
  });

  it("bounds per-file and aggregate payload bytes before hashing or parsing", () => {
    for (const target of [MAX_PAYLOAD_BYTES - 1, MAX_PAYLOAD_BYTES]) {
      const bytes = new ArrayBuffer(target);
      new Uint8Array(bytes).fill(32);
      const manifest = manifestForBytes("hostile", bytes);
      expect(captureFailure(() => fixtureLoader()(JSON.stringify(manifest), payloadBytesFor(manifest, bytes))).code)
        .toBe("TRACE_INVALID");
    }

    const oversizedBytes = new ArrayBuffer(MAX_PAYLOAD_BYTES + 1);
    const manifest = manifestForBytes("hostile", oversizedBytes);
    expect(captureFailure(() => fixtureLoader()(JSON.stringify(manifest), payloadBytesFor(manifest, oversizedBytes))).code)
      .toBe("PAYLOAD_BYTES_LIMIT");
  });

  it("keeps diagnostics structured, bounded, and free of supplied paths or bytes", () => {
    const sentinel = `SENSITIVE-${"x".repeat(2_000)}`;
    const { manifest, utf8 } = validBundle();
    required(manifest.files[0], "manifest file").path =
      `${sentinel}.golden.json`;
    const pathFailure = captureFailure(() =>
      fixtureLoader()(JSON.stringify(manifest), [
        { path: sentinel, bytes: utf8Bytes(utf8) },
      ]),
    );
    expect(pathFailure.message).not.toContain(sentinel);

    const valid = validBundle();
    required(valid.manifest.files[0], "manifest file").byteLength += 1;
    const payloadFailure = captureFailure(() =>
      fixtureLoader()(
        JSON.stringify(valid.manifest),
        payloadFor(valid.manifest, `${valid.utf8}${sentinel}`),
      ),
    );
    expect(payloadFailure.message).not.toContain(sentinel);
    expect(JSON.stringify(payloadFailure)).not.toContain(sentinel);
  });
});
