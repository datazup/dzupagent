/**
 * Dataset management tests — CRUD, versioning, filtering, import/export, edge cases.
 *
 * Tests operate entirely in-memory using EvalDataset (the existing immutable
 * value object) and a DatasetStore helper defined at the bottom of this file
 * (no real DB or filesystem required).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EvalDataset } from "../dataset/eval-dataset.js";
import type { EvalEntry, DatasetMetadata } from "../dataset/eval-dataset.js";

// ---------------------------------------------------------------------------
// In-memory DatasetStore — thin CRUD + versioning layer built on EvalDataset
// ---------------------------------------------------------------------------

interface StoredDataset {
  id: string;
  name: string;
  dataset: EvalDataset;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  tags: string[];
  description?: string;
}

interface DatasetVersion {
  version: number;
  dataset: EvalDataset;
  snapshotAt: Date;
  changeNote?: string;
}

class DatasetStore {
  private datasets = new Map<string, StoredDataset>();
  private versions = new Map<string, DatasetVersion[]>();
  private nextId = 1;

  create(
    name: string,
    entries: EvalEntry[],
    opts: { description?: string; tags?: string[] } = {},
  ): StoredDataset {
    const id = `ds-${this.nextId++}`;
    const dataset = EvalDataset.from(entries, {
      name,
      description: opts.description,
      version: "1",
    });
    const stored: StoredDataset = {
      id,
      name,
      dataset,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      tags: opts.tags ?? [],
      description: opts.description,
    };
    this.datasets.set(id, stored);
    this.versions.set(id, [
      { version: 1, dataset, snapshotAt: stored.createdAt },
    ]);
    return stored;
  }

  getById(id: string): StoredDataset | undefined {
    return this.datasets.get(id);
  }

  getByName(name: string): StoredDataset | undefined {
    for (const ds of this.datasets.values()) {
      if (ds.name === name) return ds;
    }
    return undefined;
  }

  update(
    id: string,
    entries: EvalEntry[],
    opts: { changeNote?: string; description?: string; tags?: string[] } = {},
  ): StoredDataset {
    const existing = this.datasets.get(id);
    if (!existing) throw new Error(`Dataset ${id} not found`);

    const newVersion = existing.version + 1;
    const dataset = EvalDataset.from(entries, {
      name: existing.name,
      description: opts.description ?? existing.description,
      version: String(newVersion),
    });
    const updated: StoredDataset = {
      ...existing,
      dataset,
      version: newVersion,
      updatedAt: new Date(),
      tags: opts.tags ?? existing.tags,
      description: opts.description ?? existing.description,
    };
    this.datasets.set(id, updated);

    const versionList = this.versions.get(id) ?? [];
    versionList.push({
      version: newVersion,
      dataset,
      snapshotAt: updated.updatedAt,
      changeNote: opts.changeNote,
    });
    this.versions.set(id, versionList);
    return updated;
  }

  updateMetadata(
    id: string,
    meta: { name?: string; description?: string; tags?: string[] },
  ): StoredDataset {
    const existing = this.datasets.get(id);
    if (!existing) throw new Error(`Dataset ${id} not found`);

    const updated: StoredDataset = {
      ...existing,
      name: meta.name ?? existing.name,
      description: meta.description ?? existing.description,
      tags: meta.tags ?? existing.tags,
      updatedAt: new Date(),
    };
    this.datasets.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    if (!this.datasets.has(id)) return false;
    this.datasets.delete(id);
    this.versions.delete(id);
    return true;
  }

  list(): StoredDataset[] {
    return [...this.datasets.values()];
  }

  listVersions(id: string): DatasetVersion[] {
    return this.versions.get(id) ?? [];
  }

  rollback(id: string, targetVersion: number): StoredDataset {
    const versionList = this.versions.get(id);
    if (!versionList) throw new Error(`Dataset ${id} not found`);

    const snap = versionList.find((v) => v.version === targetVersion);
    if (!snap)
      throw new Error(`Version ${targetVersion} not found for dataset ${id}`);

    const existing = this.datasets.get(id)!;
    const newVersion = existing.version + 1;
    const dataset = EvalDataset.from([...snap.dataset.entries], {
      name: existing.name,
      description: existing.description,
      version: String(newVersion),
    });
    const rolledBack: StoredDataset = {
      ...existing,
      dataset,
      version: newVersion,
      updatedAt: new Date(),
    };
    this.datasets.set(id, rolledBack);
    versionList.push({
      version: newVersion,
      dataset,
      snapshotAt: rolledBack.updatedAt,
      changeNote: `Rollback to v${targetVersion}`,
    });
    return rolledBack;
  }

  diffVersions(
    id: string,
    versionA: number,
    versionB: number,
  ): { added: EvalEntry[]; removed: EvalEntry[]; unchanged: EvalEntry[] } {
    const versionList = this.versions.get(id);
    if (!versionList) throw new Error(`Dataset ${id} not found`);

    const snapA = versionList.find((v) => v.version === versionA);
    const snapB = versionList.find((v) => v.version === versionB);
    if (!snapA) throw new Error(`Version ${versionA} not found`);
    if (!snapB) throw new Error(`Version ${versionB} not found`);

    const idsA = new Set(snapA.dataset.entries.map((e) => e.id));
    const idsB = new Set(snapB.dataset.entries.map((e) => e.id));

    const added = [...snapB.dataset.entries].filter((e) => !idsA.has(e.id));
    const removed = [...snapA.dataset.entries].filter((e) => !idsB.has(e.id));
    const unchanged = [...snapA.dataset.entries].filter((e) => idsB.has(e.id));

    return { added, removed, unchanged };
  }

  filterByTags(id: string, tags: string[]): EvalDataset {
    const stored = this.datasets.get(id);
    if (!stored) throw new Error(`Dataset ${id} not found`);
    return stored.dataset.filter({ tags });
  }

  filterByDateRange(
    _id: string,
    entries: EvalEntry[],
    from: Date,
    to: Date,
  ): EvalEntry[] {
    return entries.filter((e) => {
      const ts = e.metadata?.["createdAt"];
      if (!ts || typeof ts !== "string") return false;
      const d = new Date(ts);
      return d >= from && d <= to;
    });
  }

  filterByInputType(entries: EvalEntry[], inputType: string): EvalEntry[] {
    return entries.filter((e) => e.metadata?.["inputType"] === inputType);
  }

  importJSON(json: string): { entries: EvalEntry[]; errors: string[] } {
    const errors: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { entries: [], errors: ["Invalid JSON: parse error"] };
    }

    if (!Array.isArray(parsed)) {
      return { entries: [], errors: ["Expected a JSON array"] };
    }

    const entries: EvalEntry[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i] as Record<string, unknown>;
      if (!item || typeof item !== "object") {
        errors.push(`Entry ${i}: not an object`);
        continue;
      }
      if (typeof item["id"] !== "string" || !item["id"]) {
        errors.push(`Entry ${i}: missing or invalid "id" (string required)`);
        continue;
      }
      if (typeof item["input"] !== "string" || !item["input"]) {
        errors.push(`Entry ${i}: missing or invalid "input" (string required)`);
        continue;
      }
      entries.push({
        id: item["id"] as string,
        input: item["input"] as string,
        expectedOutput:
          typeof item["expectedOutput"] === "string"
            ? item["expectedOutput"]
            : undefined,
        tags: Array.isArray(item["tags"])
          ? (item["tags"] as string[])
          : undefined,
        metadata:
          typeof item["metadata"] === "object" && item["metadata"] !== null
            ? (item["metadata"] as Record<string, unknown>)
            : undefined,
      });
    }
    return { entries, errors };
  }

  exportJSON(dataset: EvalDataset, fields?: Array<keyof EvalEntry>): string {
    const data = [...dataset.entries].map((e) => {
      if (!fields) return e;
      const obj: Partial<EvalEntry> = {};
      for (const f of fields) {
        if (f in e) (obj as Record<string, unknown>)[f] = e[f];
      }
      return obj;
    });
    return JSON.stringify(data, null, 2);
  }

  exportJSONL(dataset: EvalDataset, fields?: Array<keyof EvalEntry>): string {
    return [...dataset.entries]
      .map((e) => {
        if (!fields) return JSON.stringify(e);
        const obj: Partial<EvalEntry> = {};
        for (const f of fields) {
          if (f in e) (obj as Record<string, unknown>)[f] = e[f];
        }
        return JSON.stringify(obj);
      })
      .join("\n");
  }
}

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

// ---------------------------------------------------------------------------
// CRUD tests
// ---------------------------------------------------------------------------

describe("DatasetStore — CRUD", () => {
  let store: DatasetStore;

  beforeEach(() => {
    store = new DatasetStore();
  });

  describe("create()", () => {
    it("creates a dataset and assigns a unique id", () => {
      const stored = store.create("math-ds", MATH_ENTRIES);
      expect(stored.id).toMatch(/^ds-\d+$/);
      expect(stored.name).toBe("math-ds");
      expect(stored.dataset.size).toBe(3);
      expect(stored.version).toBe(1);
    });

    it("assigns a createdAt timestamp", () => {
      const before = Date.now();
      const stored = store.create("ds", MATH_ENTRIES);
      const after = Date.now();
      expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(stored.createdAt.getTime()).toBeLessThanOrEqual(after);
    });

    it("stores description and tags", () => {
      const stored = store.create("ds", MATH_ENTRIES, {
        description: "Math eval set",
        tags: ["math", "benchmark"],
      });
      expect(stored.description).toBe("Math eval set");
      expect(stored.tags).toEqual(["math", "benchmark"]);
    });

    it("assigns incrementing unique ids across datasets", () => {
      const a = store.create("a", []);
      const b = store.create("b", []);
      const c = store.create("c", []);
      expect(a.id).not.toBe(b.id);
      expect(b.id).not.toBe(c.id);
    });

    it("creates initial version 1 in version history", () => {
      const stored = store.create("ds", MATH_ENTRIES);
      const versions = store.listVersions(stored.id);
      expect(versions).toHaveLength(1);
      expect(versions[0]!.version).toBe(1);
    });

    it("creates empty dataset without error", () => {
      const stored = store.create("empty-ds", []);
      expect(stored.dataset.size).toBe(0);
      expect(stored.version).toBe(1);
    });
  });

  describe("getById()", () => {
    it("retrieves dataset by id", () => {
      const stored = store.create("math-ds", MATH_ENTRIES);
      const retrieved = store.getById(stored.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe("math-ds");
      expect(retrieved!.dataset.size).toBe(3);
    });

    it("returns undefined for unknown id", () => {
      const result = store.getById("nonexistent-id");
      expect(result).toBeUndefined();
    });

    it("returns undefined after deletion", () => {
      const stored = store.create("ds", MATH_ENTRIES);
      store.delete(stored.id);
      expect(store.getById(stored.id)).toBeUndefined();
    });
  });

  describe("getByName()", () => {
    it("retrieves dataset by name", () => {
      store.create("lang-ds", LANG_ENTRIES);
      const found = store.getByName("lang-ds");
      expect(found).toBeDefined();
      expect(found!.dataset.size).toBe(2);
    });

    it("returns undefined when name not found", () => {
      expect(store.getByName("ghost")).toBeUndefined();
    });

    it("returns first match when name is duplicated", () => {
      const first = store.create("dup-name", MATH_ENTRIES);
      store.create("dup-name", LANG_ENTRIES);
      const found = store.getByName("dup-name");
      // first created should be returned (map iteration order)
      expect(found!.id).toBe(first.id);
    });
  });

  describe("updateMetadata()", () => {
    it("updates dataset name", () => {
      const stored = store.create("old-name", MATH_ENTRIES);
      const updated = store.updateMetadata(stored.id, { name: "new-name" });
      expect(updated.name).toBe("new-name");
    });

    it("updates dataset description", () => {
      const stored = store.create("ds", MATH_ENTRIES, {
        description: "original",
      });
      const updated = store.updateMetadata(stored.id, {
        description: "updated desc",
      });
      expect(updated.description).toBe("updated desc");
    });

    it("updates tags", () => {
      const stored = store.create("ds", MATH_ENTRIES, { tags: ["old"] });
      const updated = store.updateMetadata(stored.id, {
        tags: ["new", "beta"],
      });
      expect(updated.tags).toEqual(["new", "beta"]);
    });

    it("preserves unspecified metadata fields", () => {
      const stored = store.create("ds", MATH_ENTRIES, {
        description: "keep this",
        tags: ["keep-tag"],
      });
      const updated = store.updateMetadata(stored.id, { name: "new-name" });
      expect(updated.description).toBe("keep this");
      expect(updated.tags).toEqual(["keep-tag"]);
    });

    it("throws for nonexistent dataset id", () => {
      expect(() => store.updateMetadata("bad-id", { name: "x" })).toThrow(
        "not found",
      );
    });
  });

  describe("delete()", () => {
    it("deletes an existing dataset and returns true", () => {
      const stored = store.create("ds", MATH_ENTRIES);
      const result = store.delete(stored.id);
      expect(result).toBe(true);
      expect(store.getById(stored.id)).toBeUndefined();
    });

    it("returns false for nonexistent id", () => {
      const result = store.delete("ghost-id");
      expect(result).toBe(false);
    });

    it("removes version history on delete", () => {
      const stored = store.create("ds", MATH_ENTRIES);
      store.delete(stored.id);
      expect(store.listVersions(stored.id)).toHaveLength(0);
    });

    it("does not affect other datasets", () => {
      const a = store.create("a", MATH_ENTRIES);
      const b = store.create("b", LANG_ENTRIES);
      store.delete(a.id);
      expect(store.getById(b.id)).toBeDefined();
    });
  });

  describe("list()", () => {
    it("returns empty array when no datasets", () => {
      expect(store.list()).toHaveLength(0);
    });

    it("lists all created datasets", () => {
      store.create("alpha", MATH_ENTRIES);
      store.create("beta", LANG_ENTRIES);
      store.create("gamma", []);
      expect(store.list()).toHaveLength(3);
    });

    it("does not include deleted datasets", () => {
      const a = store.create("a", MATH_ENTRIES);
      store.create("b", LANG_ENTRIES);
      store.delete(a.id);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]!.name).toBe("b");
    });

    it("lists correct names", () => {
      store.create("alpha", []);
      store.create("beta", []);
      const names = store.list().map((d) => d.name);
      expect(names).toContain("alpha");
      expect(names).toContain("beta");
    });
  });
});

// ---------------------------------------------------------------------------
// Versioning tests
// ---------------------------------------------------------------------------

describe("DatasetStore — Versioning", () => {
  let store: DatasetStore;

  beforeEach(() => {
    store = new DatasetStore();
  });

  it("creates a new version on update", () => {
    const stored = store.create("ds", MATH_ENTRIES);
    const updated = store.update(stored.id, [...MATH_ENTRIES, ...LANG_ENTRIES]);
    expect(updated.version).toBe(2);
    expect(updated.dataset.size).toBe(5);
  });

  it("lists all versions including initial", () => {
    const stored = store.create("ds", MATH_ENTRIES);
    store.update(stored.id, LANG_ENTRIES);
    store.update(stored.id, MATH_ENTRIES.slice(0, 1));
    const versions = store.listVersions(stored.id);
    expect(versions).toHaveLength(3);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it("each version snapshot is independent", () => {
    const stored = store.create("ds", MATH_ENTRIES);
    store.update(stored.id, LANG_ENTRIES);
    const versions = store.listVersions(stored.id);
    expect(versions[0]!.dataset.size).toBe(3); // original
    expect(versions[1]!.dataset.size).toBe(2); // updated
  });

  it("stores changeNote in version history", () => {
    const stored = store.create("ds", MATH_ENTRIES);
    store.update(stored.id, LANG_ENTRIES, {
      changeNote: "Replaced with language entries",
    });
    const versions = store.listVersions(stored.id);
    expect(versions[1]!.changeNote).toBe("Replaced with language entries");
  });

  it("rollback restores previous version entries", () => {
    const stored = store.create("ds", MATH_ENTRIES);
    store.update(stored.id, LANG_ENTRIES);
    const rolledBack = store.rollback(stored.id, 1);
    expect(rolledBack.dataset.size).toBe(MATH_ENTRIES.length);
    const ids = rolledBack.dataset.entries.map((e) => e.id);
    expect(ids).toEqual(MATH_ENTRIES.map((e) => e.id));
  });

  it("rollback creates a new version entry (does not mutate history)", () => {
    const stored = store.create("ds", MATH_ENTRIES);
    store.update(stored.id, LANG_ENTRIES);
    store.rollback(stored.id, 1);
    const versions = store.listVersions(stored.id);
    expect(versions).toHaveLength(3);
    expect(versions[2]!.changeNote).toContain("Rollback to v1");
  });

  it("rollback throws for nonexistent version", () => {
    const stored = store.create("ds", MATH_ENTRIES);
    expect(() => store.rollback(stored.id, 99)).toThrow("Version 99 not found");
  });

  it("rollback throws for nonexistent dataset", () => {
    expect(() => store.rollback("ghost", 1)).toThrow("ghost");
  });

  it("version snapshots capture correct sizes", () => {
    const stored = store.create("ds", MATH_ENTRIES); // v1: 3 entries
    store.update(stored.id, [...MATH_ENTRIES, ...LANG_ENTRIES]); // v2: 5 entries
    store.update(stored.id, []); // v3: 0 entries
    const versions = store.listVersions(stored.id);
    expect(versions[0]!.dataset.size).toBe(3);
    expect(versions[1]!.dataset.size).toBe(5);
    expect(versions[2]!.dataset.size).toBe(0);
  });

  describe("diffVersions()", () => {
    it("detects added entries between versions", () => {
      const stored = store.create("ds", MATH_ENTRIES);
      store.update(stored.id, [...MATH_ENTRIES, ...LANG_ENTRIES]);
      const diff = store.diffVersions(stored.id, 1, 2);
      expect(diff.added).toHaveLength(2);
      expect(diff.added.map((e) => e.id)).toEqual(["l1", "l2"]);
    });

    it("detects removed entries between versions", () => {
      const stored = store.create("ds", [...MATH_ENTRIES, ...LANG_ENTRIES]);
      store.update(stored.id, MATH_ENTRIES);
      const diff = store.diffVersions(stored.id, 1, 2);
      expect(diff.removed).toHaveLength(2);
      expect(diff.removed.map((e) => e.id)).toEqual(["l1", "l2"]);
    });

    it("detects unchanged entries between versions", () => {
      const stored = store.create("ds", MATH_ENTRIES);
      store.update(stored.id, [...MATH_ENTRIES, ...LANG_ENTRIES]);
      const diff = store.diffVersions(stored.id, 1, 2);
      expect(diff.unchanged).toHaveLength(3);
      expect(diff.unchanged.map((e) => e.id)).toEqual(
        MATH_ENTRIES.map((e) => e.id),
      );
    });

    it("returns all removed when dataset is cleared", () => {
      const stored = store.create("ds", MATH_ENTRIES);
      store.update(stored.id, []);
      const diff = store.diffVersions(stored.id, 1, 2);
      expect(diff.removed).toHaveLength(3);
      expect(diff.added).toHaveLength(0);
      expect(diff.unchanged).toHaveLength(0);
    });

    it("returns all added when updating from empty", () => {
      const stored = store.create("ds", []);
      store.update(stored.id, MATH_ENTRIES);
      const diff = store.diffVersions(stored.id, 1, 2);
      expect(diff.added).toHaveLength(3);
      expect(diff.removed).toHaveLength(0);
    });

    it("throws for nonexistent dataset in diff", () => {
      expect(() => store.diffVersions("ghost", 1, 2)).toThrow("ghost");
    });

    it("throws for nonexistent version A in diff", () => {
      const stored = store.create("ds", MATH_ENTRIES);
      store.update(stored.id, LANG_ENTRIES);
      expect(() => store.diffVersions(stored.id, 99, 2)).toThrow(
        "Version 99 not found",
      );
    });

    it("throws for nonexistent version B in diff", () => {
      const stored = store.create("ds", MATH_ENTRIES);
      store.update(stored.id, LANG_ENTRIES);
      expect(() => store.diffVersions(stored.id, 1, 99)).toThrow(
        "Version 99 not found",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Filtering tests (beyond existing filter() tests)
// ---------------------------------------------------------------------------

describe("DatasetStore — Filtering", () => {
  let store: DatasetStore;

  beforeEach(() => {
    store = new DatasetStore();
  });

  it("filterByTags delegates to EvalDataset.filter()", () => {
    const stored = store.create("ds", [...MATH_ENTRIES, ...LANG_ENTRIES]);
    const filtered = store.filterByTags(stored.id, ["easy"]);
    // m1, m3 (math+easy), l1 (translation+easy) = 3
    expect(filtered.size).toBe(3);
  });

  it("filterByTags AND logic requires all tags", () => {
    const stored = store.create("ds", [...MATH_ENTRIES, ...LANG_ENTRIES]);
    const filtered = store.filterByTags(stored.id, ["math", "hard"]);
    expect(filtered.size).toBe(1);
    expect(filtered.entries[0]!.id).toBe("m2");
  });

  it("filterByTags returns empty when no match", () => {
    const stored = store.create("ds", MATH_ENTRIES);
    const filtered = store.filterByTags(stored.id, ["nonexistent-tag"]);
    expect(filtered.size).toBe(0);
  });

  it("filterByTags throws for unknown dataset id", () => {
    expect(() => store.filterByTags("ghost-id", ["easy"])).toThrow("ghost-id");
  });

  describe("filterByDateRange()", () => {
    const datedEntries: EvalEntry[] = [
      {
        id: "r1",
        input: "q1",
        metadata: { createdAt: "2024-01-15T00:00:00Z" },
      },
      {
        id: "r2",
        input: "q2",
        metadata: { createdAt: "2024-03-01T00:00:00Z" },
      },
      {
        id: "r3",
        input: "q3",
        metadata: { createdAt: "2024-06-20T00:00:00Z" },
      },
      {
        id: "r4",
        input: "q4",
        metadata: { createdAt: "2024-12-01T00:00:00Z" },
      },
      { id: "r5", input: "q5" }, // no createdAt
    ];

    it("returns entries within date range", () => {
      const stored = store.create("ds", datedEntries);
      const result = store.filterByDateRange(
        stored.id,
        datedEntries,
        new Date("2024-02-01"),
        new Date("2024-07-01"),
      );
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id)).toEqual(["r2", "r3"]);
    });

    it("excludes entries outside date range", () => {
      const stored = store.create("ds", datedEntries);
      const result = store.filterByDateRange(
        stored.id,
        datedEntries,
        new Date("2024-11-01"),
        new Date("2024-12-31"),
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("r4");
    });

    it("excludes entries without createdAt metadata", () => {
      const stored = store.create("ds", datedEntries);
      const result = store.filterByDateRange(
        stored.id,
        datedEntries,
        new Date("2020-01-01"),
        new Date("2030-01-01"),
      );
      // r5 has no createdAt so is excluded
      expect(result).toHaveLength(4);
      expect(result.map((e) => e.id)).not.toContain("r5");
    });

    it("returns empty when no entries fall in range", () => {
      const stored = store.create("ds", datedEntries);
      const result = store.filterByDateRange(
        stored.id,
        datedEntries,
        new Date("2025-01-01"),
        new Date("2025-12-31"),
      );
      expect(result).toHaveLength(0);
    });

    it("is inclusive of boundary dates", () => {
      const stored = store.create("ds", datedEntries);
      const result = store.filterByDateRange(
        stored.id,
        datedEntries,
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-03-01T00:00:00Z"),
      );
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id)).toEqual(["r1", "r2"]);
    });
  });

  describe("filterByInputType()", () => {
    const typedEntries: EvalEntry[] = [
      { id: "t1", input: "q1", metadata: { inputType: "text" } },
      { id: "t2", input: "q2", metadata: { inputType: "code" } },
      { id: "t3", input: "q3", metadata: { inputType: "text" } },
      { id: "t4", input: "q4", metadata: { inputType: "image" } },
      { id: "t5", input: "q5" }, // no inputType
    ];

    it("filters entries by inputType metadata", () => {
      const result = store.filterByInputType(typedEntries, "text");
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id)).toEqual(["t1", "t3"]);
    });

    it("returns empty when inputType has no matches", () => {
      const result = store.filterByInputType(typedEntries, "audio");
      expect(result).toHaveLength(0);
    });

    it("excludes entries without inputType metadata", () => {
      const result = store.filterByInputType(typedEntries, "text");
      expect(result.map((e) => e.id)).not.toContain("t5");
    });

    it("filters code type correctly", () => {
      const result = store.filterByInputType(typedEntries, "code");
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("t2");
    });
  });

  describe("combined filtering via EvalDataset.filter()", () => {
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

    it("filter preserves metadata version", () => {
      const ds = EvalDataset.from(MATH_ENTRIES, {
        name: "math-ds",
        version: "2",
      });
      const filtered = ds.filter({ tags: ["easy"] });
      expect(filtered.metadata.name).toBe("math-ds");
      expect(filtered.metadata.version).toBe("2");
    });
  });
});

// ---------------------------------------------------------------------------
// Import tests
// ---------------------------------------------------------------------------

describe("DatasetStore — Import", () => {
  let store: DatasetStore;

  beforeEach(() => {
    store = new DatasetStore();
  });

  describe("importJSON()", () => {
    it("imports a valid JSON array", () => {
      const json = JSON.stringify([
        { id: "i1", input: "What is 1+1?", expectedOutput: "2" },
        { id: "i2", input: "Capital of Germany?", expectedOutput: "Berlin" },
      ]);
      const { entries, errors } = store.importJSON(json);
      expect(entries).toHaveLength(2);
      expect(errors).toHaveLength(0);
    });

    it("imports entries with tags", () => {
      const json = JSON.stringify([
        { id: "i1", input: "q1", tags: ["math", "easy"] },
      ]);
      const { entries } = store.importJSON(json);
      expect(entries[0]!.tags).toEqual(["math", "easy"]);
    });

    it("imports entries with metadata", () => {
      const json = JSON.stringify([
        {
          id: "i1",
          input: "q1",
          metadata: { source: "benchmark-v2", difficulty: 3 },
        },
      ]);
      const { entries } = store.importJSON(json);
      expect(entries[0]!.metadata?.["source"]).toBe("benchmark-v2");
    });

    it("rejects malformed JSON (parse error)", () => {
      const { entries, errors } = store.importJSON("not valid json!!");
      expect(entries).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Invalid JSON");
    });

    it("rejects non-array JSON", () => {
      const { entries, errors } = store.importJSON('{"id":"1","input":"q"}');
      expect(entries).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("JSON array");
    });

    it("rejects entry with missing id", () => {
      const json = JSON.stringify([
        { input: "What is 1+1?" }, // missing id
      ]);
      const { entries, errors } = store.importJSON(json);
      expect(entries).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('missing or invalid "id"');
    });

    it("rejects entry with missing input", () => {
      const json = JSON.stringify([
        { id: "i1" }, // missing input
      ]);
      const { entries, errors } = store.importJSON(json);
      expect(entries).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('missing or invalid "input"');
    });

    it("rejects entry with numeric id", () => {
      const json = JSON.stringify([{ id: 42, input: "q" }]);
      const { entries, errors } = store.importJSON(json);
      expect(entries).toHaveLength(0);
      expect(errors[0]).toContain('"id"');
    });

    it("imports partial — valid entries accepted, invalid ones generate errors", () => {
      const json = JSON.stringify([
        { id: "good1", input: "valid entry" },
        { input: "missing id" },
        { id: "good2", input: "another valid" },
        { id: "bad3" }, // missing input
      ]);
      const { entries, errors } = store.importJSON(json);
      expect(entries).toHaveLength(2);
      expect(errors).toHaveLength(2);
      expect(entries[0]!.id).toBe("good1");
      expect(entries[1]!.id).toBe("good2");
    });

    it("reports correct index in error messages", () => {
      const json = JSON.stringify([
        { id: "ok", input: "fine" },
        { id: "bad" }, // index 1 missing input
      ]);
      const { errors } = store.importJSON(json);
      expect(errors[0]).toContain("Entry 1");
    });

    it("handles empty JSON array", () => {
      const { entries, errors } = store.importJSON("[]");
      expect(entries).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it("converts imported entries into EvalDataset via EvalDataset.fromJSON", () => {
      const json = JSON.stringify([
        { id: "j1", input: "hello", tags: ["greet"] },
      ]);
      const ds = EvalDataset.fromJSON(json);
      expect(ds.size).toBe(1);
      expect(ds.entries[0]!.id).toBe("j1");
    });

    it("rejects null entry in array", () => {
      const json = '[null, {"id":"ok","input":"fine"}]';
      const { entries, errors } = store.importJSON(json);
      expect(entries).toHaveLength(1);
      expect(errors).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Export tests
// ---------------------------------------------------------------------------

describe("DatasetStore — Export", () => {
  let store: DatasetStore;
  let dataset: EvalDataset;

  beforeEach(() => {
    store = new DatasetStore();
    dataset = EvalDataset.from([
      {
        id: "e1",
        input: "q1",
        expectedOutput: "a1",
        tags: ["math"],
        metadata: { src: "test" },
      },
      { id: "e2", input: "q2", expectedOutput: "a2", tags: ["lang"] },
      { id: "e3", input: "q3", tags: ["math", "hard"] },
    ]);
  });

  describe("exportJSON()", () => {
    it("exports all entries as JSON array", () => {
      const json = store.exportJSON(dataset);
      const parsed = JSON.parse(json) as EvalEntry[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(3);
    });

    it("exported JSON round-trips via EvalDataset.fromJSON", () => {
      const json = store.exportJSON(dataset);
      const restored = EvalDataset.fromJSON(json);
      expect(restored.size).toBe(dataset.size);
      expect(restored.entries.map((e) => e.id)).toEqual(
        dataset.entries.map((e) => e.id),
      );
    });

    it("exports only selected fields (selective export)", () => {
      const json = store.exportJSON(dataset, ["id", "input"]);
      const parsed = JSON.parse(json) as Array<Partial<EvalEntry>>;
      expect(parsed[0]).toHaveProperty("id");
      expect(parsed[0]).toHaveProperty("input");
      expect(parsed[0]).not.toHaveProperty("expectedOutput");
      expect(parsed[0]).not.toHaveProperty("tags");
    });

    it("selective export with id only", () => {
      const json = store.exportJSON(dataset, ["id"]);
      const parsed = JSON.parse(json) as Array<Partial<EvalEntry>>;
      for (const item of parsed) {
        expect(Object.keys(item)).toEqual(["id"]);
      }
    });

    it("exports valid JSON for empty dataset", () => {
      const emptyDs = EvalDataset.from([]);
      const json = store.exportJSON(emptyDs);
      const parsed = JSON.parse(json);
      expect(parsed).toEqual([]);
    });

    it("preserves all entry fields in full export", () => {
      const json = store.exportJSON(dataset);
      const parsed = JSON.parse(json) as EvalEntry[];
      const first = parsed[0]!;
      expect(first.id).toBe("e1");
      expect(first.input).toBe("q1");
      expect(first.expectedOutput).toBe("a1");
      expect(first.tags).toEqual(["math"]);
      expect(first.metadata).toEqual({ src: "test" });
    });
  });

  describe("exportJSONL()", () => {
    it("exports as JSONL (one JSON object per line)", () => {
      const jsonl = store.exportJSONL(dataset);
      const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(3);
    });

    it("each line is valid JSON", () => {
      const jsonl = store.exportJSONL(dataset);
      const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("exported JSONL round-trips via EvalDataset.fromJSONL", () => {
      const jsonl = store.exportJSONL(dataset);
      const restored = EvalDataset.fromJSONL(jsonl);
      expect(restored.size).toBe(dataset.size);
      expect(restored.entries.map((e) => e.id)).toEqual(
        dataset.entries.map((e) => e.id),
      );
    });

    it("exports only selected fields in JSONL", () => {
      const jsonl = store.exportJSONL(dataset, ["id", "input"]);
      const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        const obj = JSON.parse(line) as Partial<EvalEntry>;
        expect(obj).toHaveProperty("id");
        expect(obj).toHaveProperty("input");
        expect(obj).not.toHaveProperty("expectedOutput");
      }
    });

    it("exports empty dataset as empty string", () => {
      const emptyDs = EvalDataset.from([]);
      const jsonl = store.exportJSONL(emptyDs);
      expect(jsonl.trim()).toBe("");
    });

    it("preserves entry order in JSONL export", () => {
      const jsonl = store.exportJSONL(dataset);
      const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
      const ids = lines.map((l) => (JSON.parse(l) as EvalEntry).id);
      expect(ids).toEqual(["e1", "e2", "e3"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("DatasetStore — Edge Cases", () => {
  let store: DatasetStore;

  beforeEach(() => {
    store = new DatasetStore();
  });

  it("handles empty dataset creation", () => {
    const stored = store.create("empty", []);
    expect(stored.dataset.size).toBe(0);
    expect(store.listVersions(stored.id)).toHaveLength(1);
  });

  it("allows duplicate dataset names in the store", () => {
    store.create("dup", MATH_ENTRIES);
    store.create("dup", LANG_ENTRIES);
    expect(store.list()).toHaveLength(2);
  });

  it("handles very large dataset (1000 items)", () => {
    const entries: EvalEntry[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `large-${i}`,
      input: `question number ${i}`,
      expectedOutput: `answer ${i}`,
      tags: i % 2 === 0 ? ["even"] : ["odd"],
    }));
    const stored = store.create("large-ds", entries);
    expect(stored.dataset.size).toBe(1000);

    const filtered = store.filterByTags(stored.id, ["even"]);
    expect(filtered.size).toBe(500);

    const sampled = stored.dataset.sample(100, 7);
    expect(sampled.size).toBe(100);
  });

  it("handles unicode content in entries", () => {
    const unicodeEntries: EvalEntry[] = [
      {
        id: "u1",
        input: "日本語テスト",
        expectedOutput: "Japanese test",
        tags: ["unicode"],
      },
      {
        id: "u2",
        input: "مرحبا بالعالم",
        expectedOutput: "Hello world in Arabic",
        tags: ["unicode", "rtl"],
      },
      {
        id: "u3",
        input: "🚀🌍✨",
        expectedOutput: "emoji test",
        tags: ["emoji"],
      },
      {
        id: "u4",
        input: "Ångström Å",
        expectedOutput: "Nordic char",
        tags: ["special"],
      },
    ];
    const stored = store.create("unicode-ds", unicodeEntries);
    expect(stored.dataset.size).toBe(4);

    // Round-trip through JSON export/import
    const json = store.exportJSON(stored.dataset);
    const restored = EvalDataset.fromJSON(json);
    expect(restored.entries[0]!.input).toBe("日本語テスト");
    expect(restored.entries[1]!.input).toBe("مرحبا بالعالم");
    expect(restored.entries[2]!.input).toBe("🚀🌍✨");
  });

  it("handles entries with very long input strings", () => {
    const longInput = "A".repeat(10_000);
    const entries: EvalEntry[] = [{ id: "long1", input: longInput }];
    const stored = store.create("long-ds", entries);
    expect(stored.dataset.entries[0]!.input).toBe(longInput);

    const json = store.exportJSON(stored.dataset);
    const restored = EvalDataset.fromJSON(json);
    expect(restored.entries[0]!.input).toHaveLength(10_000);
  });

  it("dataset remains immutable after creation", () => {
    const stored = store.create("ds", MATH_ENTRIES);
    expect(Object.isFrozen(stored.dataset.entries)).toBe(true);
    expect(Object.isFrozen(stored.dataset)).toBe(true);
  });

  it("filter on empty dataset returns empty dataset", () => {
    const ds = EvalDataset.from([]);
    const filtered = ds.filter({ tags: ["any"] });
    expect(filtered.size).toBe(0);
  });

  it("sample from empty dataset returns empty dataset", () => {
    const ds = EvalDataset.from([]);
    const sampled = ds.sample(5);
    expect(sampled.size).toBe(0);
  });

  it("allTags deduplicated correctly across large entry set", () => {
    const entries: EvalEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: `t${i}`,
      input: `q${i}`,
      tags: [`tag-${i % 5}`, `shared`],
    }));
    const ds = EvalDataset.from(entries);
    const tags = ds.allTags();
    // 5 unique numbered tags + 1 shared = 6
    expect(tags).toHaveLength(6);
    expect(tags).toContain("shared");
    expect(tags).toEqual([...tags].sort());
  });

  it("import → create → export round-trip preserves all data", () => {
    const json = JSON.stringify([
      {
        id: "rt1",
        input: "test input 1",
        expectedOutput: "output 1",
        tags: ["a", "b"],
      },
      { id: "rt2", input: "test input 2", tags: ["c"] },
    ]);

    const { entries, errors } = store.importJSON(json);
    expect(errors).toHaveLength(0);

    const stored = store.create("round-trip", entries);
    const exported = store.exportJSON(stored.dataset);
    const parsed = JSON.parse(exported) as EvalEntry[];

    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.id).toBe("rt1");
    expect(parsed[0]!.expectedOutput).toBe("output 1");
    expect(parsed[0]!.tags).toEqual(["a", "b"]);
    expect(parsed[1]!.id).toBe("rt2");
  });

  it("JSONL import → create → JSONL export round-trip", () => {
    const jsonl = [
      '{"id":"jl1","input":"first question","tags":["greet"]}',
      '{"id":"jl2","input":"second question","expectedOutput":"answer 2"}',
    ].join("\n");

    const ds = EvalDataset.fromJSONL(jsonl);
    const stored = store.create("jsonl-rt", [...ds.entries]);
    const exported = store.exportJSONL(stored.dataset);
    const lines = exported.split("\n").filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(2);
    const obj0 = JSON.parse(lines[0]!) as EvalEntry;
    const obj1 = JSON.parse(lines[1]!) as EvalEntry;
    expect(obj0.id).toBe("jl1");
    expect(obj0.tags).toEqual(["greet"]);
    expect(obj1.expectedOutput).toBe("answer 2");
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
