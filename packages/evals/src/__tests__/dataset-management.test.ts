/**
 * Dataset management tests — filtering, import/export round-trips, edge cases
 * and metadata, all exercised directly against the production `EvalDataset`
 * value object.
 *
 * DZUPAGENT-TEST-C-14: this file used to declare a `DatasetStore` class inside
 * the spec (CRUD, versioning, rollback, date/input-type filters, an importJSON
 * validator and field-selective exporters) and ran most of its cases against
 * that local helper. No dataset store, versioning or validating importer ships
 * in `@dzupagent/evals`, so those cases tested the spec's own code. They were
 * deleted rather than kept as coverage of a feature that does not exist; the
 * cases that exercised real `EvalDataset` behaviour now call it directly.
 */

import { describe, it, expect } from "vitest";
import { EvalDataset } from "../dataset/eval-dataset.js";
import type { EvalEntry } from "../dataset/eval-dataset.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MATH_ENTRIES: EvalEntry[] = [
  {
    id: "m1",
    input: "What is 1+1?",
    expectedOutput: "2",
    tags: ["math", "easy"],
  },
  {
    id: "m2",
    input: "What is 7*8?",
    expectedOutput: "56",
    tags: ["math", "hard"],
  },
  {
    id: "m3",
    input: "What is sqrt(16)?",
    expectedOutput: "4",
    tags: ["math", "easy"],
  },
];

const LANG_ENTRIES: EvalEntry[] = [
  {
    id: "l1",
    input: 'Translate "hello" to Spanish',
    expectedOutput: "hola",
    tags: ["translation", "easy"],
  },
  {
    id: "l2",
    input: 'Translate "goodbye" to French',
    expectedOutput: "au revoir",
    tags: ["translation", "hard"],
  },
];

const EXPORT_ENTRIES: EvalEntry[] = [
  {
    id: "e1",
    input: "q1",
    expectedOutput: "a1",
    tags: ["math"],
    metadata: { src: "test" },
  },
  { id: "e2", input: "q2", expectedOutput: "a2", tags: ["lang"] },
  { id: "e3", input: "q3", tags: ["math", "hard"] },
];

function toJSONL(dataset: EvalDataset): string {
  return dataset.entries.map((entry) => JSON.stringify(entry)).join("\n");
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("EvalDataset — filtering", () => {
  it("filter({ tags }) keeps entries carrying the tag", () => {
    const ds = EvalDataset.from([...MATH_ENTRIES, ...LANG_ENTRIES]);
    const filtered = ds.filter({ tags: ["easy"] });
    // m1, m3 (math+easy), l1 (translation+easy) = 3
    expect(filtered.size).toBe(3);
    expect(filtered.entries.map((e) => e.id)).toEqual(["m1", "m3", "l1"]);
  });

  it("filter({ tags }) uses AND logic across tags", () => {
    const ds = EvalDataset.from([...MATH_ENTRIES, ...LANG_ENTRIES]);
    const filtered = ds.filter({ tags: ["math", "hard"] });
    expect(filtered.size).toBe(1);
    expect(filtered.entries[0]!.id).toBe("m2");
  });

  it("filter({ tags }) returns an empty dataset when nothing matches", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    expect(ds.filter({ tags: ["nonexistent-tag"] }).size).toBe(0);
  });

  it("applies tag + id filter together", () => {
    const entries: EvalEntry[] = [
      { id: "a1", input: "q1", tags: ["alpha", "beta"] },
      { id: "a2", input: "q2", tags: ["beta", "gamma"] },
      { id: "a3", input: "q3", tags: ["alpha"] },
    ];
    const ds = EvalDataset.from(entries);
    const filtered = ds.filter({ tags: ["alpha"], ids: ["a1", "a2"] });
    expect(filtered.size).toBe(1);
    expect(filtered.entries[0]!.id).toBe("a1");
  });

  it("chaining multiple filter() calls", () => {
    const entries: EvalEntry[] = [
      { id: "b1", input: "q1", tags: ["easy", "math"] },
      { id: "b2", input: "q2", tags: ["easy", "lang"] },
      { id: "b3", input: "q3", tags: ["hard", "math"] },
    ];
    const ds = EvalDataset.from(entries);
    const result = ds.filter({ tags: ["easy"] }).filter({ ids: ["b1"] });
    expect(result.size).toBe(1);
    expect(result.entries[0]!.id).toBe("b1");
  });

  it("filter preserves metadata name and version", () => {
    const ds = EvalDataset.from(MATH_ENTRIES, {
      name: "math-ds",
      version: "2",
    });
    const filtered = ds.filter({ tags: ["easy"] });
    expect(filtered.metadata.name).toBe("math-ds");
    expect(filtered.metadata.version).toBe("2");
  });

  it("filter on empty dataset returns empty dataset", () => {
    const ds = EvalDataset.from([]);
    expect(ds.filter({ tags: ["any"] }).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

describe("EvalDataset — import", () => {
  it("fromJSON parses a JSON array of entries", () => {
    const json = JSON.stringify([
      { id: "j1", input: "hello", tags: ["greet"] },
      { id: "j2", input: "Capital of Germany?", expectedOutput: "Berlin" },
    ]);
    const ds = EvalDataset.fromJSON(json);
    expect(ds.size).toBe(2);
    expect(ds.entries[0]!.id).toBe("j1");
    expect(ds.entries[0]!.tags).toEqual(["greet"]);
    expect(ds.entries[1]!.expectedOutput).toBe("Berlin");
  });

  it("fromJSON keeps entry metadata", () => {
    const json = JSON.stringify([
      { id: "i1", input: "q1", metadata: { source: "benchmark-v2", difficulty: 3 } },
    ]);
    const ds = EvalDataset.fromJSON(json);
    expect(ds.entries[0]!.metadata?.["source"]).toBe("benchmark-v2");
  });

  it("fromJSON rejects malformed JSON", () => {
    expect(() => EvalDataset.fromJSON("not valid json!!")).toThrow(SyntaxError);
  });

  it("fromJSON rejects non-array JSON", () => {
    expect(() => EvalDataset.fromJSON('{"id":"1","input":"q"}')).toThrow(
      "expects a JSON array",
    );
  });

  it("fromJSON accepts an empty array", () => {
    expect(EvalDataset.fromJSON("[]").size).toBe(0);
  });

  it("fromJSONL parses one entry per non-empty line", () => {
    const jsonl = [
      '{"id":"jl1","input":"first question","tags":["greet"]}',
      "",
      '{"id":"jl2","input":"second question","expectedOutput":"answer 2"}',
    ].join("\n");
    const ds = EvalDataset.fromJSONL(jsonl);
    expect(ds.entries.map((e) => e.id)).toEqual(["jl1", "jl2"]);
    expect(ds.entries[0]!.tags).toEqual(["greet"]);
    expect(ds.entries[1]!.expectedOutput).toBe("answer 2");
  });
});

// ---------------------------------------------------------------------------
// Export round-trips
// ---------------------------------------------------------------------------

describe("EvalDataset — export round-trips", () => {
  it("serialised entries round-trip via fromJSON with every field intact", () => {
    const dataset = EvalDataset.from(EXPORT_ENTRIES);
    const restored = EvalDataset.fromJSON(JSON.stringify(dataset.entries));
    expect(restored.size).toBe(dataset.size);
    expect(restored.entries).toEqual(dataset.entries);
  });

  it("serialised entries round-trip via fromJSONL preserving order", () => {
    const dataset = EvalDataset.from(EXPORT_ENTRIES);
    const restored = EvalDataset.fromJSONL(toJSONL(dataset));
    expect(restored.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(restored.entries).toEqual(dataset.entries);
  });

  it("an empty dataset serialises to an empty JSON array", () => {
    const emptyDs = EvalDataset.from([]);
    expect(JSON.parse(JSON.stringify(emptyDs.entries))).toEqual([]);
    expect(EvalDataset.fromJSONL(toJSONL(emptyDs)).size).toBe(0);
  });

  it("unicode content survives a JSON round-trip", () => {
    const unicodeEntries: EvalEntry[] = [
      { id: "u1", input: "日本語テスト", expectedOutput: "Japanese test", tags: ["unicode"] },
      { id: "u2", input: "مرحبا بالعالم", expectedOutput: "Hello world in Arabic", tags: ["unicode", "rtl"] },
      { id: "u3", input: "🚀🌍✨", expectedOutput: "emoji test", tags: ["emoji"] },
      { id: "u4", input: "Ångström Å", expectedOutput: "Nordic char", tags: ["special"] },
    ];
    const ds = EvalDataset.from(unicodeEntries);
    expect(ds.size).toBe(4);
    const restored = EvalDataset.fromJSON(JSON.stringify(ds.entries));
    expect(restored.entries.map((e) => e.input)).toEqual(unicodeEntries.map((e) => e.input));
  });

  it("very long input strings survive a JSON round-trip", () => {
    const longInput = "A".repeat(10_000);
    const ds = EvalDataset.from([{ id: "long1", input: longInput }]);
    expect(ds.entries[0]!.input).toBe(longInput);
    const restored = EvalDataset.fromJSON(JSON.stringify(ds.entries));
    expect(restored.entries[0]!.input).toHaveLength(10_000);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("EvalDataset — edge cases", () => {
  it("handles a large dataset (1000 items) through filter and sample", () => {
    const entries: EvalEntry[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `large-${i}`,
      input: `question number ${i}`,
      expectedOutput: `answer ${i}`,
      tags: i % 2 === 0 ? ["even"] : ["odd"],
    }));
    const ds = EvalDataset.from(entries, { name: "large-ds" });
    expect(ds.size).toBe(1000);
    expect(ds.filter({ tags: ["even"] }).size).toBe(500);

    const sampled = ds.sample(100, 7);
    expect(sampled.size).toBe(100);
    expect(new Set(sampled.entries.map((e) => e.id)).size).toBe(100);
    // Same seed, same sample.
    expect(ds.sample(100, 7).entries.map((e) => e.id)).toEqual(
      sampled.entries.map((e) => e.id),
    );
  });

  it("dataset and its entries are frozen after creation", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    expect(Object.isFrozen(ds.entries)).toBe(true);
    expect(Object.isFrozen(ds)).toBe(true);
  });

  it("sample from empty dataset returns empty dataset", () => {
    expect(EvalDataset.from([]).sample(5).size).toBe(0);
  });

  it("allTags deduplicated correctly across large entry set", () => {
    const entries: EvalEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: `t${i}`,
      input: `q${i}`,
      tags: [`tag-${i % 5}`, `shared`],
    }));
    const tags = EvalDataset.from(entries).allTags();
    // 5 unique numbered tags + 1 shared = 6
    expect(tags).toHaveLength(6);
    expect(tags).toContain("shared");
    expect(tags).toEqual([...tags].sort());
  });
});

// ---------------------------------------------------------------------------
// EvalDataset metadata — additional coverage
// ---------------------------------------------------------------------------

describe("EvalDataset — metadata and identity", () => {
  it("totalEntries matches entries array length", () => {
    const ds = EvalDataset.from(MATH_ENTRIES, { name: "test" });
    expect(ds.metadata.totalEntries).toBe(ds.entries.length);
  });

  it("metadata tags list contains sorted deduplicated tags from entries", () => {
    const entries: EvalEntry[] = [
      { id: "1", input: "q", tags: ["z", "a", "z"] },
      { id: "2", input: "q", tags: ["m", "a"] },
    ];
    const ds = EvalDataset.from(entries);
    // collectTags deduplicates via Set
    expect(ds.metadata.tags).toEqual(["a", "m", "z"]);
  });

  it("metadata version is preserved from factory options", () => {
    const ds = EvalDataset.from([], { name: "v-test", version: "3.1.0" });
    expect(ds.metadata.version).toBe("3.1.0");
  });

  it("metadata createdAt is preserved from factory options", () => {
    const ts = "2024-01-01T00:00:00Z";
    const ds = EvalDataset.from([], { createdAt: ts });
    expect(ds.metadata.createdAt).toBe(ts);
  });

  it("metadata description is preserved from factory options", () => {
    const ds = EvalDataset.from([], { description: "My test set" });
    expect(ds.metadata.description).toBe("My test set");
  });

  it('unnamed dataset has default name of "unnamed"', () => {
    const ds = EvalDataset.from([]);
    expect(ds.metadata.name).toBe("unnamed");
  });
});
