/**
 * Eval dataset management tests — train/test split, deterministic splits,
 * stratified splits, sampling without replacement, seeded sampling,
 * dataset merge, advanced filtering, and empty dataset edge cases.
 *
 * All operations are purely in-memory using EvalDataset plus thin helpers
 * defined in this file. No production source is modified.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EvalDataset } from "../dataset/eval-dataset.js";
import type { EvalEntry } from "../dataset/eval-dataset.js";

// ---------------------------------------------------------------------------
// Helpers — train/test split, merge, stratified split
// ---------------------------------------------------------------------------

/**
 * Split a dataset into train and test subsets.
 * @param ds      Source dataset
 * @param ratio   Fraction of entries to put in train (default 0.8)
 * @param seed    Optional PRNG seed for deterministic shuffling
 */
function trainTestSplit(
  ds: EvalDataset,
  ratio = 0.8,
  seed?: number,
): { train: EvalDataset; test: EvalDataset } {
  const shuffled = ds.sample(ds.size, seed ?? 42);
  const splitIdx = Math.round(shuffled.size * ratio);
  const trainEntries = [...shuffled.entries].slice(0, splitIdx);
  const testEntries = [...shuffled.entries].slice(splitIdx);
  return {
    train: EvalDataset.from(trainEntries, {
      name: `${ds.metadata.name}-train`,
      version: ds.metadata.version,
    }),
    test: EvalDataset.from(testEntries, {
      name: `${ds.metadata.name}-test`,
      version: ds.metadata.version,
    }),
  };
}

/**
 * Stratified train/test split — preserves class distribution by tag.
 * @param ds        Source dataset
 * @param classTag  Tag key to stratify on (entries without this tag form their own class)
 * @param ratio     Train fraction (default 0.8)
 * @param seed      PRNG seed
 */
function stratifiedSplit(
  ds: EvalDataset,
  classTag: string,
  ratio = 0.8,
  seed = 42,
): { train: EvalDataset; test: EvalDataset } {
  // Group entries by their class label (first matching tag value)
  const groups = new Map<string, EvalEntry[]>();
  for (const entry of ds.entries) {
    const label =
      entry.tags?.find((t) => t.startsWith(`${classTag}:`)) ?? "__none__";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }

  const trainEntries: EvalEntry[] = [];
  const testEntries: EvalEntry[] = [];

  for (const [, members] of groups) {
    const groupDs = EvalDataset.from(members);
    const shuffled = groupDs.sample(groupDs.size, seed);
    const splitIdx = Math.round(shuffled.size * ratio);
    trainEntries.push(...[...shuffled.entries].slice(0, splitIdx));
    testEntries.push(...[...shuffled.entries].slice(splitIdx));
  }

  return {
    train: EvalDataset.from(trainEntries, {
      name: `${ds.metadata.name}-train`,
    }),
    test: EvalDataset.from(testEntries, { name: `${ds.metadata.name}-test` }),
  };
}

/**
 * Merge two or more datasets into a single dataset.
 * Duplicate ids are kept (caller's responsibility to deduplicate if needed).
 */
function mergeDatasets(
  datasets: EvalDataset[],
  metadata?: { name?: string; description?: string; version?: string },
): EvalDataset {
  const allEntries: EvalEntry[] = [];
  for (const ds of datasets) {
    allEntries.push(...ds.entries);
  }
  return EvalDataset.from(allEntries, metadata ?? {});
}

/**
 * Deduplicate a dataset by entry id — keeps first occurrence.
 */
function deduplicateById(ds: EvalDataset): EvalDataset {
  const seen = new Set<string>();
  const unique: EvalEntry[] = [];
  for (const entry of ds.entries) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      unique.push(entry);
    }
  }
  return EvalDataset.from(unique, {
    name: ds.metadata.name,
    version: ds.metadata.version,
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MATH_ENTRIES: EvalEntry[] = [
  { id: "m1", input: "1+1", expectedOutput: "2", tags: ["class:math", "easy"] },
  {
    id: "m2",
    input: "7*8",
    expectedOutput: "56",
    tags: ["class:math", "hard"],
  },
  {
    id: "m3",
    input: "sqrt(16)",
    expectedOutput: "4",
    tags: ["class:math", "easy"],
  },
  {
    id: "m4",
    input: "log(100)",
    expectedOutput: "2",
    tags: ["class:math", "hard"],
  },
  {
    id: "m5",
    input: "2^10",
    expectedOutput: "1024",
    tags: ["class:math", "easy"],
  },
];

const LANG_ENTRIES: EvalEntry[] = [
  {
    id: "l1",
    input: "hello→Spanish",
    expectedOutput: "hola",
    tags: ["class:lang", "easy"],
  },
  {
    id: "l2",
    input: "goodbye→French",
    expectedOutput: "au revoir",
    tags: ["class:lang", "hard"],
  },
  {
    id: "l3",
    input: "please→German",
    expectedOutput: "bitte",
    tags: ["class:lang", "easy"],
  },
  {
    id: "l4",
    input: "thanks→Italian",
    expectedOutput: "grazie",
    tags: ["class:lang", "hard"],
  },
  {
    id: "l5",
    input: "yes→Japanese",
    expectedOutput: "hai",
    tags: ["class:lang", "easy"],
  },
];

/** 10 entries, 5 math / 5 lang — balanced for stratification tests */
const BALANCED_ENTRIES = [...MATH_ENTRIES, ...LANG_ENTRIES];

/** 20 entries used for larger sampling tests */
const LARGE_ENTRIES: EvalEntry[] = Array.from({ length: 20 }, (_, i) => ({
  id: `e${i}`,
  input: `question ${i}`,
  expectedOutput: `answer ${i}`,
  tags: [i % 2 === 0 ? "even" : "odd", i < 10 ? "first-half" : "second-half"],
}));

// ---------------------------------------------------------------------------
// Train / Test Split
// ---------------------------------------------------------------------------

describe("trainTestSplit() — basic split behaviour", () => {
  it("splits entries with no overlap between train and test", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { train, test } = trainTestSplit(ds, 0.8, 1);

    const trainIds = new Set(train.entries.map((e) => e.id));
    const testIds = new Set(test.entries.map((e) => e.id));
    for (const id of testIds) {
      expect(trainIds.has(id)).toBe(false);
    }
  });

  it("train + test sizes sum to total dataset size", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { train, test } = trainTestSplit(ds, 0.8, 1);
    expect(train.size + test.size).toBe(ds.size);
  });

  it("all entries appear in either train or test (no entries lost)", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { train, test } = trainTestSplit(ds, 0.8, 1);
    const allIds = new Set([
      ...train.entries.map((e) => e.id),
      ...test.entries.map((e) => e.id),
    ]);
    for (const entry of ds.entries) {
      expect(allIds.has(entry.id)).toBe(true);
    }
  });

  it("80/20 split produces approximately 8 train and 2 test for 10 entries", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { train, test } = trainTestSplit(ds, 0.8, 1);
    expect(train.size).toBe(8);
    expect(test.size).toBe(2);
  });

  it("50/50 split produces equal halves for even-sized dataset", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { train, test } = trainTestSplit(ds, 0.5, 7);
    expect(train.size).toBe(5);
    expect(test.size).toBe(5);
  });

  it("returns correct metadata names for train/test splits", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "myds" });
    const { train, test } = trainTestSplit(ds, 0.8, 1);
    expect(train.metadata.name).toBe("myds-train");
    expect(test.metadata.name).toBe("myds-test");
  });

  it("train dataset is an EvalDataset with proper size property", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { train } = trainTestSplit(ds, 0.8, 1);
    expect(train).toBeInstanceOf(EvalDataset);
    expect(typeof train.size).toBe("number");
  });

  it("100% ratio puts all entries in train and none in test", () => {
    const ds = EvalDataset.from(MATH_ENTRIES, { name: "math" });
    const { train, test } = trainTestSplit(ds, 1.0, 1);
    expect(train.size).toBe(5);
    expect(test.size).toBe(0);
  });

  it("0% ratio puts all entries in test and none in train", () => {
    const ds = EvalDataset.from(MATH_ENTRIES, { name: "math" });
    const { train, test } = trainTestSplit(ds, 0.0, 1);
    expect(train.size).toBe(0);
    expect(test.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Split Determinism
// ---------------------------------------------------------------------------

describe("trainTestSplit() — determinism", () => {
  it("same seed produces identical train/test partition", () => {
    const ds = EvalDataset.from(LARGE_ENTRIES, { name: "large" });
    const { train: t1, test: te1 } = trainTestSplit(ds, 0.8, 99);
    const { train: t2, test: te2 } = trainTestSplit(ds, 0.8, 99);

    expect(t1.entries.map((e) => e.id)).toEqual(t2.entries.map((e) => e.id));
    expect(te1.entries.map((e) => e.id)).toEqual(te2.entries.map((e) => e.id));
  });

  it("different seeds produce different partitions", () => {
    const ds = EvalDataset.from(LARGE_ENTRIES, { name: "large" });
    const { train: t1 } = trainTestSplit(ds, 0.8, 111);
    const { train: t2 } = trainTestSplit(ds, 0.8, 222);

    const ids1 = t1.entries.map((e) => e.id).join(",");
    const ids2 = t2.entries.map((e) => e.id).join(",");
    expect(ids1).not.toBe(ids2);
  });

  it("split result is reproducible across calls with same seed", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "b" });
    const results = Array.from({ length: 3 }, () =>
      trainTestSplit(ds, 0.8, 42)
        .train.entries.map((e) => e.id)
        .join(","),
    );
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });
});

// ---------------------------------------------------------------------------
// Stratified Split
// ---------------------------------------------------------------------------

describe("stratifiedSplit() — class distribution preservation", () => {
  it("both classes appear in training set", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { train } = stratifiedSplit(ds, "class", 0.8, 1);
    const trainTags = new Set(train.entries.flatMap((e) => e.tags ?? []));
    expect(trainTags.has("class:math")).toBe(true);
    expect(trainTags.has("class:lang")).toBe(true);
  });

  it("both classes appear in test set", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { test } = stratifiedSplit(ds, "class", 0.8, 1);
    const testTags = new Set(test.entries.flatMap((e) => e.tags ?? []));
    expect(testTags.has("class:math")).toBe(true);
    expect(testTags.has("class:lang")).toBe(true);
  });

  it("total entries preserved across stratified split", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { train, test } = stratifiedSplit(ds, "class", 0.8, 1);
    expect(train.size + test.size).toBe(ds.size);
  });

  it("no overlap between stratified train and test sets", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { train, test } = stratifiedSplit(ds, "class", 0.8, 1);
    const trainIds = new Set(train.entries.map((e) => e.id));
    for (const entry of test.entries) {
      expect(trainIds.has(entry.id)).toBe(false);
    }
  });

  it("stratified split with same seed is deterministic", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const r1 = stratifiedSplit(ds, "class", 0.8, 55);
    const r2 = stratifiedSplit(ds, "class", 0.8, 55);
    expect(r1.train.entries.map((e) => e.id).sort()).toEqual(
      r2.train.entries.map((e) => e.id).sort(),
    );
  });

  it("class sizes are proportionally maintained in train set", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { train } = stratifiedSplit(ds, "class", 0.8, 1);
    const mathInTrain = train.entries.filter((e) =>
      e.tags?.includes("class:math"),
    ).length;
    const langInTrain = train.entries.filter((e) =>
      e.tags?.includes("class:lang"),
    ).length;
    // 5 math entries at 80% → 4, 5 lang entries at 80% → 4
    expect(mathInTrain).toBe(4);
    expect(langInTrain).toBe(4);
  });

  it("class sizes are proportionally maintained in test set", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES, { name: "balanced" });
    const { test } = stratifiedSplit(ds, "class", 0.8, 1);
    const mathInTest = test.entries.filter((e) =>
      e.tags?.includes("class:math"),
    ).length;
    const langInTest = test.entries.filter((e) =>
      e.tags?.includes("class:lang"),
    ).length;
    expect(mathInTest).toBe(1);
    expect(langInTest).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sampling — without replacement and seeded
// ---------------------------------------------------------------------------

describe("EvalDataset.sample() — without replacement", () => {
  it("sampled entries are unique (no duplicates)", () => {
    const ds = EvalDataset.from(LARGE_ENTRIES);
    const sampled = ds.sample(10, 7);
    const ids = sampled.entries.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("sample of full size returns all entries exactly once", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const sampled = ds.sample(MATH_ENTRIES.length, 1);
    const ids = sampled.entries.map((e) => e.id).sort();
    const origIds = MATH_ENTRIES.map((e) => e.id).sort();
    expect(ids).toEqual(origIds);
  });

  it("no entry appears more than once across repeated samples with same seed", () => {
    const ds = EvalDataset.from(LARGE_ENTRIES);
    const sampled = ds.sample(15, 13);
    const seen = new Set<string>();
    for (const entry of sampled.entries) {
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
    }
  });

  it("requesting more than dataset size clamps to dataset size", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const sampled = ds.sample(1000, 1);
    expect(sampled.size).toBe(MATH_ENTRIES.length);
  });

  it("requesting 1 item returns exactly 1 entry", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const sampled = ds.sample(1, 42);
    expect(sampled.size).toBe(1);
  });

  it("sampled entries are all from the original dataset", () => {
    const ds = EvalDataset.from(LARGE_ENTRIES);
    const originalIds = new Set(LARGE_ENTRIES.map((e) => e.id));
    const sampled = ds.sample(12, 5);
    for (const entry of sampled.entries) {
      expect(originalIds.has(entry.id)).toBe(true);
    }
  });
});

describe("EvalDataset.sample() — seeded reproducibility", () => {
  it("same seed produces same sample order", () => {
    const ds = EvalDataset.from(LARGE_ENTRIES);
    const s1 = ds.sample(10, 777);
    const s2 = ds.sample(10, 777);
    expect(s1.entries.map((e) => e.id)).toEqual(s2.entries.map((e) => e.id));
  });

  it("different seeds produce different sample order", () => {
    const ds = EvalDataset.from(LARGE_ENTRIES);
    const s1 = ds.sample(10, 100);
    const s2 = ds.sample(10, 200);
    const ids1 = s1.entries.map((e) => e.id).join(",");
    const ids2 = s2.entries.map((e) => e.id).join(",");
    expect(ids1).not.toBe(ids2);
  });

  it("default seed (42) produces same result as explicit seed 42", () => {
    const ds = EvalDataset.from(LARGE_ENTRIES);
    const s1 = ds.sample(8);
    const s2 = ds.sample(8, 42);
    expect(s1.entries.map((e) => e.id)).toEqual(s2.entries.map((e) => e.id));
  });

  it("sampling is reproducible across independent dataset instances", () => {
    const ds1 = EvalDataset.from([...LARGE_ENTRIES]);
    const ds2 = EvalDataset.from([...LARGE_ENTRIES]);
    const s1 = ds1.sample(10, 999);
    const s2 = ds2.sample(10, 999);
    expect(s1.entries.map((e) => e.id)).toEqual(s2.entries.map((e) => e.id));
  });

  it("consecutive calls with same seed on same instance produce same result", () => {
    const ds = EvalDataset.from(LARGE_ENTRIES);
    const ids = Array.from({ length: 5 }, () =>
      ds
        .sample(5, 123)
        .entries.map((e) => e.id)
        .join(","),
    );
    const distinct = new Set(ids);
    expect(distinct.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dataset Merge
// ---------------------------------------------------------------------------

describe("mergeDatasets()", () => {
  it("merges two datasets into one with combined entries", () => {
    const ds1 = EvalDataset.from(MATH_ENTRIES);
    const ds2 = EvalDataset.from(LANG_ENTRIES);
    const merged = mergeDatasets([ds1, ds2]);
    expect(merged.size).toBe(MATH_ENTRIES.length + LANG_ENTRIES.length);
  });

  it("merged dataset contains all entry ids from both sources", () => {
    const ds1 = EvalDataset.from(MATH_ENTRIES);
    const ds2 = EvalDataset.from(LANG_ENTRIES);
    const merged = mergeDatasets([ds1, ds2]);
    const mergedIds = new Set(merged.entries.map((e) => e.id));
    for (const e of [...MATH_ENTRIES, ...LANG_ENTRIES]) {
      expect(mergedIds.has(e.id)).toBe(true);
    }
  });

  it("preserves metadata name when provided", () => {
    const ds1 = EvalDataset.from(MATH_ENTRIES);
    const ds2 = EvalDataset.from(LANG_ENTRIES);
    const merged = mergeDatasets([ds1, ds2], { name: "combined-ds" });
    expect(merged.metadata.name).toBe("combined-ds");
  });

  it("merged dataset collects tags from all constituent entries", () => {
    const ds1 = EvalDataset.from(MATH_ENTRIES);
    const ds2 = EvalDataset.from(LANG_ENTRIES);
    const merged = mergeDatasets([ds1, ds2]);
    const tags = merged.allTags();
    expect(tags).toContain("class:math");
    expect(tags).toContain("class:lang");
    expect(tags).toContain("easy");
    expect(tags).toContain("hard");
  });

  it("merges three datasets correctly", () => {
    const ds1 = EvalDataset.from(MATH_ENTRIES);
    const ds2 = EvalDataset.from(LANG_ENTRIES);
    const ds3 = EvalDataset.from([
      { id: "extra1", input: "bonus", tags: ["bonus"] },
    ]);
    const merged = mergeDatasets([ds1, ds2, ds3]);
    expect(merged.size).toBe(11);
  });

  it("merging with an empty dataset returns the other dataset's entries", () => {
    const ds1 = EvalDataset.from(MATH_ENTRIES);
    const empty = EvalDataset.from([]);
    const merged = mergeDatasets([ds1, empty]);
    expect(merged.size).toBe(MATH_ENTRIES.length);
    expect(merged.entries.map((e) => e.id)).toEqual(
      MATH_ENTRIES.map((e) => e.id),
    );
  });

  it("merging two empty datasets returns empty dataset", () => {
    const merged = mergeDatasets([EvalDataset.from([]), EvalDataset.from([])]);
    expect(merged.size).toBe(0);
  });

  it("merge with single dataset returns equivalent dataset", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const merged = mergeDatasets([ds]);
    expect(merged.size).toBe(ds.size);
    expect(merged.entries.map((e) => e.id)).toEqual(
      ds.entries.map((e) => e.id),
    );
  });

  it("merged dataset keeps duplicate ids from overlapping sources", () => {
    const overlap: EvalEntry = { id: "shared-id", input: "q", tags: ["x"] };
    const ds1 = EvalDataset.from([overlap]);
    const ds2 = EvalDataset.from([overlap, { id: "unique", input: "y" }]);
    const merged = mergeDatasets([ds1, ds2]);
    const sharedCount = merged.entries.filter(
      (e) => e.id === "shared-id",
    ).length;
    expect(sharedCount).toBe(2); // duplicates kept — dedup is caller's job
  });
});

// ---------------------------------------------------------------------------
// Deduplication after merge
// ---------------------------------------------------------------------------

describe("deduplicateById()", () => {
  it("removes duplicate entries keeping first occurrence", () => {
    const entry: EvalEntry = { id: "dup", input: "original" };
    const dupe: EvalEntry = { id: "dup", input: "duplicate" };
    const ds = EvalDataset.from([entry, dupe, { id: "unique", input: "only" }]);
    const deduped = deduplicateById(ds);
    expect(deduped.size).toBe(2);
    expect(deduped.entries.find((e) => e.id === "dup")!.input).toBe("original");
  });

  it("returns same size when no duplicates exist", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const deduped = deduplicateById(ds);
    expect(deduped.size).toBe(MATH_ENTRIES.length);
  });

  it("returns empty dataset when given empty dataset", () => {
    const ds = EvalDataset.from([]);
    expect(deduplicateById(ds).size).toBe(0);
  });

  it("deduplication after merge yields unique ids only", () => {
    const ds1 = EvalDataset.from(MATH_ENTRIES);
    const ds2 = EvalDataset.from(MATH_ENTRIES); // exact duplicate
    const merged = mergeDatasets([ds1, ds2]);
    const deduped = deduplicateById(merged);
    expect(deduped.size).toBe(MATH_ENTRIES.length);
  });
});

// ---------------------------------------------------------------------------
// Empty Dataset Edge Cases
// ---------------------------------------------------------------------------

describe("empty dataset — operations do not throw", () => {
  let empty: EvalDataset;

  beforeEach(() => {
    empty = EvalDataset.from([]);
  });

  it("EvalDataset.from([]) creates dataset of size 0", () => {
    expect(empty.size).toBe(0);
    expect(empty.entries).toHaveLength(0);
  });

  it("filter on empty dataset returns empty dataset", () => {
    const filtered = empty.filter({ tags: ["anything"] });
    expect(filtered.size).toBe(0);
  });

  it("filter by ids on empty dataset returns empty dataset", () => {
    const filtered = empty.filter({ ids: ["id1", "id2"] });
    expect(filtered.size).toBe(0);
  });

  it("sample on empty dataset returns empty dataset", () => {
    const sampled = empty.sample(5);
    expect(sampled.size).toBe(0);
  });

  it("sample with seed on empty dataset returns empty dataset", () => {
    const sampled = empty.sample(5, 42);
    expect(sampled.size).toBe(0);
  });

  it("allTags on empty dataset returns empty array", () => {
    expect(empty.allTags()).toEqual([]);
  });

  it("trainTestSplit on empty dataset produces two empty datasets", () => {
    const { train, test } = trainTestSplit(empty, 0.8, 1);
    expect(train.size).toBe(0);
    expect(test.size).toBe(0);
  });

  it("mergeDatasets([empty, empty]) returns empty dataset", () => {
    const merged = mergeDatasets([empty, empty]);
    expect(merged.size).toBe(0);
  });

  it("deduplicateById on empty dataset returns empty dataset", () => {
    expect(deduplicateById(empty).size).toBe(0);
  });

  it("metadata.totalEntries is 0 for empty dataset", () => {
    expect(empty.metadata.totalEntries).toBe(0);
  });

  it("metadata.tags is empty array for empty dataset", () => {
    expect(empty.metadata.tags).toEqual([]);
  });

  it("stratifiedSplit on empty dataset produces two empty datasets", () => {
    const { train, test } = stratifiedSplit(empty, "class", 0.8, 1);
    expect(train.size).toBe(0);
    expect(test.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Advanced filtering — chaining and metadata preservation
// ---------------------------------------------------------------------------

describe("EvalDataset — advanced filter chaining", () => {
  it("chained filter calls narrow results progressively", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES);
    const step1 = ds.filter({ tags: ["easy"] }); // m1, m3, m5, l1, l3, l5 → 6
    const step2 = step1.filter({ tags: ["class:math"] }); // m1, m3, m5 → 3
    expect(step1.size).toBe(6);
    expect(step2.size).toBe(3);
    expect(step2.entries.every((e) => e.tags?.includes("class:math"))).toBe(
      true,
    );
  });

  it("filter by non-existent tag on non-empty dataset yields 0 results", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const filtered = ds.filter({ tags: ["no-such-tag"] });
    expect(filtered.size).toBe(0);
  });

  it("filter with empty tags array returns all entries", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const filtered = ds.filter({ tags: [] });
    expect(filtered.size).toBe(MATH_ENTRIES.length);
  });

  it("filter with empty ids array returns all entries", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const filtered = ds.filter({ ids: [] });
    expect(filtered.size).toBe(MATH_ENTRIES.length);
  });

  it("filter preserves entry data fidelity", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const filtered = ds.filter({ ids: ["m2"] });
    const entry = filtered.entries[0]!;
    expect(entry.id).toBe("m2");
    expect(entry.input).toBe("7*8");
    expect(entry.expectedOutput).toBe("56");
    expect(entry.tags).toEqual(["class:math", "hard"]);
  });

  it("filter result allTags reflects only filtered entries", () => {
    const ds = EvalDataset.from(BALANCED_ENTRIES);
    const mathOnly = ds.filter({ tags: ["class:math"] });
    expect(mathOnly.allTags()).not.toContain("class:lang");
    expect(mathOnly.allTags()).toContain("class:math");
  });

  it("filter on single-entry dataset returns that entry when id matches", () => {
    const ds = EvalDataset.from([{ id: "only", input: "solo", tags: ["x"] }]);
    const filtered = ds.filter({ ids: ["only"] });
    expect(filtered.size).toBe(1);
  });

  it("filter on single-entry dataset returns empty when id does not match", () => {
    const ds = EvalDataset.from([{ id: "only", input: "solo", tags: ["x"] }]);
    const filtered = ds.filter({ ids: ["other"] });
    expect(filtered.size).toBe(0);
  });

  it("metadata version is preserved through filter", () => {
    const ds = EvalDataset.from(MATH_ENTRIES, { name: "math", version: "3" });
    const filtered = ds.filter({ tags: ["easy"] });
    expect(filtered.metadata.version).toBe("3");
  });

  it("metadata description is preserved through filter", () => {
    const ds = EvalDataset.from(MATH_ENTRIES, {
      name: "math",
      description: "Math benchmark v3",
    });
    const filtered = ds.filter({ tags: ["easy"] });
    expect(filtered.metadata.description).toBe("Math benchmark v3");
  });
});

// ---------------------------------------------------------------------------
// Dataset metadata correctness
// ---------------------------------------------------------------------------

describe("EvalDataset — metadata correctness", () => {
  it("totalEntries always equals entries.length", () => {
    const sizes = [0, 1, 5, 10, 20];
    for (const n of sizes) {
      const entries = Array.from({ length: n }, (_, i) => ({
        id: `x${i}`,
        input: `q${i}`,
      }));
      const ds = EvalDataset.from(entries);
      expect(ds.metadata.totalEntries).toBe(n);
      expect(ds.entries.length).toBe(n);
    }
  });

  it("metadata.tags is sorted deduplicated union of all entry tags", () => {
    const entries: EvalEntry[] = [
      { id: "1", input: "a", tags: ["zebra", "apple"] },
      { id: "2", input: "b", tags: ["mango", "apple"] },
      { id: "3", input: "c", tags: ["kiwi"] },
    ];
    const ds = EvalDataset.from(entries);
    expect(ds.metadata.tags).toEqual(["apple", "kiwi", "mango", "zebra"]);
  });

  it("dataset is fully frozen (Object.isFrozen)", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    expect(Object.isFrozen(ds)).toBe(true);
    expect(Object.isFrozen(ds.entries)).toBe(true);
  });

  it("sampled dataset is also immutable", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const sampled = ds.sample(3, 1);
    expect(Object.isFrozen(sampled)).toBe(true);
    expect(Object.isFrozen(sampled.entries)).toBe(true);
  });

  it("filtered dataset is also immutable", () => {
    const ds = EvalDataset.from(MATH_ENTRIES);
    const filtered = ds.filter({ tags: ["easy"] });
    expect(Object.isFrozen(filtered)).toBe(true);
    expect(Object.isFrozen(filtered.entries)).toBe(true);
  });

  it("merged dataset is also immutable", () => {
    const merged = mergeDatasets([
      EvalDataset.from(MATH_ENTRIES),
      EvalDataset.from(LANG_ENTRIES),
    ]);
    expect(Object.isFrozen(merged)).toBe(true);
    expect(Object.isFrozen(merged.entries)).toBe(true);
  });
});
