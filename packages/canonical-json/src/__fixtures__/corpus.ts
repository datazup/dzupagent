/**
 * Golden-vector corpus. Each entry is a factory so non-JSON values (cycles,
 * bigints, Dates, functions) are constructed fresh per run.
 *
 * MUST stay in byte-for-byte sync with the generator corpus used to produce
 * `dzupagent-golden-vectors.json` (see that file's provenance block). If you
 * add an entry here, regenerate the fixture from the dzupagent source
 * implementations — never hand-edit the fixture.
 */
export interface CorpusEntry {
  id: string;
  make: () => unknown;
}

export const corpus: CorpusEntry[] = [
  { id: "simple-nested", make: () => ({ b: { d: 2, c: [3, 1] }, a: 1 }) },
  {
    id: "unicode-and-numeric-keys",
    make: () => ({ é: 1, z: 2, Z: 3, a: 4, "10": 5, "2": 6 }),
  },
  { id: "undefined-object-value", make: () => ({ a: 1, b: undefined, c: 3 }) },
  { id: "undefined-array-item", make: () => [1, undefined, 3] },
  { id: "top-level-undefined", make: () => undefined },
  { id: "top-level-null", make: () => null },
  { id: "top-level-number", make: () => 42 },
  { id: "top-level-string", make: () => "plain" },
  { id: "top-level-boolean", make: () => false },
  {
    id: "special-numbers",
    make: () => ({
      nan: NaN,
      inf: Infinity,
      ninf: -Infinity,
      negzero: -0,
      exp: 1e21,
      frac: 0.1,
    }),
  },
  {
    id: "string-escapes",
    // Explicit escapes only -- invisible characters must never live in this file.
    make: () => ({ s: 'line\nbrk\t"q"\\ \u0000 \u2028' }),
  },
  {
    id: "proto-key-as-data",
    make: () => JSON.parse('{"__proto__":{"x":1},"a":2}') as unknown,
  },
  { id: "function-object-value", make: () => ({ a: 1, f: () => 1 }) },
  { id: "function-array-item", make: () => [1, () => 1] },
  { id: "symbol-object-value", make: () => ({ a: 1, s: Symbol("x") }) },
  { id: "bigint-object-value", make: () => ({ n: 123n }) },
  { id: "top-level-bigint", make: () => 456n },
  { id: "date-object-value", make: () => ({ d: new Date(0) }) },
  {
    id: "own-tojson",
    make: () => ({ a: 2, toJSON: () => ({ z: 1, y: 2 }) }),
  },
  {
    id: "cycle",
    make: () => {
      const o: Record<string, unknown> = { a: 1 };
      o.self = o;
      return o;
    },
  },
  { id: "empty-object", make: () => ({}) },
  { id: "empty-array", make: () => [] },
  {
    id: "array-of-objects",
    make: () => [
      { b: 1, a: 2 },
      { d: [], c: {} },
    ],
  },
  {
    id: "nested-empty-and-null",
    make: () => ({ z: null, a: { b: [null, {}, []] } }),
  },
  {
    id: "shared-ref-dag",
    make: () => {
      const shared = { x: 1 };
      return { a: shared, b: shared };
    },
  },
  {
    id: "top-level-function",
    make: () => {
      const fn = (): number => 1;
      return fn;
    },
  },
];
