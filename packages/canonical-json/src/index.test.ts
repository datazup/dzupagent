/**
 * Option-axis unit tests: each test varies exactly one option dimension
 * against a fixture that disagrees with the alternative, so no axis can go
 * vacuous. Preset-level byte equivalence with the dzupagent sources lives
 * in golden-vectors.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  AUTHORING_V1_OPTIONS,
  type CanonicalJsonOptions,
  canonicalDigestHex,
  canonicalDigestPrefixed,
  canonicalStringify,
  canonicalize,
  sha256Hex,
  sha256Prefixed,
  sortedJsonV1Stringify,
} from "./index.js";

/** A baseline that renders every special case visibly, then vary one axis. */
const BASE: CanonicalJsonOptions = {
  undefinedValues: { objectValue: "token", arrayItem: "token", topLevel: "token" },
  functionsAndSymbols: {
    objectValue: "placeholder",
    arrayItem: "placeholder",
    topLevel: "placeholder",
  },
  bigint: "decimal-string",
  cycles: { policy: "throw", message: "boom" },
};

describe("key ordering", () => {
  it("sorts by UTF-16 code units, not locale ('é' after 'z')", () => {
    expect(canonicalStringify({ "é": 1, z: 2, Z: 3, a: 4 }, BASE)).toBe(
      '{"Z":3,"a":4,"z":2,"é":1}',
    );
  });

  it("keeps integer-like keys in UTF-16 order ('10' before '2')", () => {
    expect(canonicalStringify({ "10": 5, "2": 6 }, BASE)).toBe(
      '{"10":5,"2":6}',
    );
  });

  it("idempotency-v1 instead promotes integer-like keys to numeric order", () => {
    expect(canonicalize({ "10": 5, "2": 6, a: 1 }, "idempotency-v1")).toBe(
      '{"2":6,"10":5,"a":1}',
    );
    expect(canonicalize({ "10": 5, "2": 6, a: 1 }, "authoring-v1")).toBe(
      '{"10":5,"2":6,"a":1}',
    );
  });
});

describe("undefinedValues axis", () => {
  const input = { a: 1, gone: undefined };

  it("objectValue token keeps the key with a bare token", () => {
    expect(canonicalStringify(input, BASE)).toBe('{"a":1,"gone":undefined}');
  });

  it("objectValue omit drops the entry", () => {
    expect(
      canonicalStringify(input, {
        ...BASE,
        undefinedValues: { ...BASE.undefinedValues, objectValue: "omit" },
      }),
    ).toBe('{"a":1}');
  });

  it("arrayItem elide / null / token", () => {
    const arr = [1, undefined, 3];
    expect(
      canonicalStringify(arr, {
        ...BASE,
        undefinedValues: { ...BASE.undefinedValues, arrayItem: "elide" },
      }),
    ).toBe("[1,,3]");
    expect(
      canonicalStringify(arr, {
        ...BASE,
        undefinedValues: { ...BASE.undefinedValues, arrayItem: "null" },
      }),
    ).toBe("[1,null,3]");
    expect(canonicalStringify(arr, BASE)).toBe("[1,undefined,3]");
  });

  it("topLevel throw / null / token", () => {
    expect(() =>
      canonicalStringify(undefined, {
        ...BASE,
        undefinedValues: { ...BASE.undefinedValues, topLevel: "throw" },
      }),
    ).toThrowError(
      new TypeError("cannot canonicalize `undefined` at the top level"),
    );
    expect(
      canonicalStringify(undefined, {
        ...BASE,
        undefinedValues: { ...BASE.undefinedValues, topLevel: "null" },
      }),
    ).toBe("null");
    expect(canonicalStringify(undefined, BASE)).toBe("undefined");
  });
});

describe("functionsAndSymbols axis", () => {
  const fn = () => 1;
  const sym = Symbol("marker");

  it("placeholder renders JSON strings; symbols keep their description", () => {
    expect(canonicalStringify({ f: fn, s: sym }, BASE)).toBe(
      '{"f":"[Function]","s":"Symbol(marker)"}',
    );
    expect(canonicalStringify([fn, sym], BASE)).toBe(
      '["[Function]","Symbol(marker)"]',
    );
    expect(canonicalStringify(fn, BASE)).toBe('"[Function]"');
  });

  it("token keeps object keys with bare tokens; elide skips array items", () => {
    const options: CanonicalJsonOptions = {
      ...BASE,
      functionsAndSymbols: {
        objectValue: "token",
        arrayItem: "elide",
        topLevel: "throw",
      },
    };
    expect(canonicalStringify({ f: fn }, options)).toBe('{"f":undefined}');
    expect(canonicalStringify([1, fn], options)).toBe("[1,]");
    expect(() => canonicalStringify(fn, options)).toThrowError(
      new TypeError(
        "cannot canonicalize a function or symbol value at the top level",
      ),
    );
  });

  it("functions and undefined follow their own policies independently", () => {
    // undefined omitted, function tokenized — the classification-envelope shape.
    expect(
      canonicalStringify(
        { u: undefined, f: fn },
        {
          ...BASE,
          undefinedValues: { ...BASE.undefinedValues, objectValue: "omit" },
          functionsAndSymbols: {
            ...BASE.functionsAndSymbols,
            objectValue: "token",
          },
        },
      ),
    ).toBe('{"f":undefined}');
  });
});

describe("bigint axis", () => {
  it("decimal-string emits the digits as a JSON string", () => {
    expect(canonicalStringify({ n: 123n }, BASE)).toBe('{"n":"123"}');
  });

  it("throw matches the native JSON.stringify error", () => {
    expect(() =>
      canonicalStringify({ n: 123n }, { ...BASE, bigint: "throw" }),
    ).toThrowError(new TypeError("Do not know how to serialize a BigInt"));
  });
});

describe("cycles axis", () => {
  function cyclic(): Record<string, unknown> {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    return o;
  }

  it("throw uses the configured message and unwinds, so shared refs pass", () => {
    expect(() => canonicalStringify(cyclic(), BASE)).toThrowError(
      new TypeError("boom"),
    );
    const shared = { x: 1 };
    expect(canonicalStringify({ a: shared, b: shared }, BASE)).toBe(
      '{"a":{"x":1},"b":{"x":1}}',
    );
  });

  it("marker never unwinds: every repeated reference renders [Circular]", () => {
    const options: CanonicalJsonOptions = {
      ...BASE,
      cycles: { policy: "marker" },
    };
    expect(canonicalStringify(cyclic(), options)).toBe(
      '{"a":1,"self":"[Circular]"}',
    );
    const shared = { x: 1 };
    expect(canonicalStringify({ a: shared, b: shared }, options)).toBe(
      '{"a":{"x":1},"b":"[Circular]"}',
    );
  });
});

describe("sortedJsonV1Stringify (idempotency-v1 engine)", () => {
  it("preserves __proto__ keys as data", () => {
    expect(
      sortedJsonV1Stringify(JSON.parse('{"__proto__":{"x":1},"a":2}')),
    ).toBe('{"__proto__":{"x":1},"a":2}');
  });

  it("honors an own toJSON without re-sorting its result", () => {
    expect(sortedJsonV1Stringify({ a: 2, toJSON: () => ({ z: 1, y: 2 }) })).toBe(
      '{"z":1,"y":2}',
    );
  });

  it("strips an inherited toJSON (Date renders as {})", () => {
    expect(sortedJsonV1Stringify({ d: new Date(0) })).toBe('{"d":{}}');
  });

  it("throws the source's TypeError on non-serializable top-level input", () => {
    expect(() => sortedJsonV1Stringify(undefined)).toThrowError(
      new TypeError("Canonical JSON input must be JSON-serializable."),
    );
  });
});

describe("digest helpers", () => {
  it("sha256Hex / sha256Prefixed agree", () => {
    const hex = sha256Hex("null");
    expect(hex).toBe(
      "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
    );
    expect(sha256Prefixed("null")).toBe(`sha256:${hex}`);
  });

  it("canonicalDigestHex and canonicalDigestPrefixed hash the canonical form", () => {
    const value = { b: 1, a: 2 };
    expect(canonicalDigestHex(value, "idempotency-v1")).toBe(
      sha256Hex('{"a":2,"b":1}'),
    );
    expect(canonicalDigestPrefixed(value, "authoring-v1")).toBe(
      sha256Prefixed('{"a":2,"b":1}'),
    );
  });
});

describe("presets are frozen", () => {
  it("rejects mutation of a preset's options", () => {
    expect(() => {
      (AUTHORING_V1_OPTIONS as { bigint: string }).bigint = "decimal-string";
    }).toThrow();
  });
});
