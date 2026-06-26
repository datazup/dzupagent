/**
 * Gap-filling tests for FilesystemKnowledgeStore.
 * Uses real tmpdir (same approach as the existing spec) — no mocks needed.
 * Covers: key/repo/combined filters on query(), ENOENT empty result,
 * subscribe unsub, non-matching subscribe filtering, invalid scope, read null.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FilesystemKnowledgeStore } from "../filesystem-knowledge-store.js";
import type { KnowledgeEnvelope } from "@dzupagent/agent-types/fleet";

let tmp: string;
let store: FilesystemKnowledgeStore;

function env(overrides: Partial<KnowledgeEnvelope> = {}): KnowledgeEnvelope {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    runId: "r1",
    repo: null,
    kind: "finding",
    key: "k",
    version: 1,
    authorWorkerId: null,
    parentId: null,
    createdAt: new Date().toISOString(),
    supersededAt: null,
    payload: {
      category: "hotspot",
      location: "f:1",
      summary: "",
      evidence: [],
      confidence: 1,
    },
    tags: [],
    ...overrides,
  };
}

async function collect(
  iter: AsyncIterable<KnowledgeEnvelope>
): Promise<KnowledgeEnvelope[]> {
  const out: KnowledgeEnvelope[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fks-gaps-"));
  store = new FilesystemKnowledgeStore({ rootDir: tmp });
});

describe("FilesystemKnowledgeStore — gap coverage", () => {
  describe("query() filter variants", () => {
    it("key filter returns only entries with the matching key", async () => {
      await store.append("run:r1", env({ key: "alpha", version: 1 }));
      await store.append("run:r1", env({ key: "beta", version: 1 }));
      await store.append("run:r1", env({ key: "alpha", version: 2 }));

      const results = await collect(
        store.query({ scope: "run:r1", key: "alpha" })
      );
      expect(results.every((e) => e.key === "alpha")).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(2); // both versions
      expect(results.some((e) => e.key === "beta")).toBe(false);
    });

    it("repo filter returns only entries with the matching repo", async () => {
      await store.append(
        "run:r1",
        env({ key: "k1", repo: "repo-a", version: 1 })
      );
      await store.append(
        "run:r1",
        env({ key: "k2", repo: "repo-b", version: 1 })
      );
      await store.append("run:r1", env({ key: "k3", repo: null, version: 1 }));

      const results = await collect(
        store.query({ scope: "run:r1", repo: "repo-a" })
      );
      expect(results.every((e) => e.repo === "repo-a")).toBe(true);
      expect(results.some((e) => e.repo === "repo-b")).toBe(false);
      expect(results.some((e) => e.repo === null)).toBe(false);
    });

    it("repo: null filter returns only entries with null repo", async () => {
      await store.append(
        "run:r1",
        env({ key: "has-repo", repo: "some-repo", version: 1 })
      );
      await store.append(
        "run:r1",
        env({ key: "no-repo", repo: null, version: 1 })
      );

      const results = await collect(
        store.query({ scope: "run:r1", repo: null })
      );
      expect(results.every((e) => e.repo === null)).toBe(true);
      expect(results.some((e) => e.key === "has-repo")).toBe(false);
    });

    it("kind + key combined filter returns only entries matching both", async () => {
      await store.append(
        "run:r1",
        env({ kind: "finding", key: "target", version: 1 })
      );
      await store.append(
        "run:r1",
        env({
          kind: "lesson",
          key: "target",
          version: 1,
          payload: {
            scope: "this-run",
            rule: "r",
            why: "w",
            howToApply: "h",
            evidenceLinks: [],
          },
        })
      );
      await store.append(
        "run:r1",
        env({ kind: "finding", key: "other", version: 1 })
      );

      const results = await collect(
        store.query({ scope: "run:r1", kind: "finding", key: "target" })
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.kind).toBe("finding");
      expect(results[0]!.key).toBe("target");
    });

    it("query with no filter (scope only) returns all entries in that scope", async () => {
      await store.append("run:r1", env({ key: "x", version: 1 }));
      await store.append("run:r1", env({ key: "y", version: 1 }));
      await store.append("run:r1", env({ key: "z", version: 1 }));

      const results = await collect(store.query({ scope: "run:r1" }));
      expect(results.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("query() ENOENT path", () => {
    it("returns empty iterable when scope has no entries file (ENOENT)", async () => {
      // No appends — the entries.ndjson file doesn't exist yet.
      const results = await collect(store.query({ scope: "run:r1" }));
      expect(results).toEqual([]);
    });

    it("does not throw when queried scope directory does not exist", async () => {
      await expect(
        collect(store.query({ scope: "run:nonexistent" }))
      ).resolves.toEqual([]);
    });
  });

  describe("scope isolation", () => {
    it("entries in one scope are not visible when querying a different scope", async () => {
      await store.append("run:r1", env({ key: "scope-a-entry", version: 1 }));
      const results = await collect(store.query({ scope: "run:r2" }));
      expect(results.some((e) => e.key === "scope-a-entry")).toBe(false);
    });

    it("global scope is stored separately from run scopes", async () => {
      await store.append("global", env({ key: "global-key", version: 1 }));
      const runResults = await collect(store.query({ scope: "run:r1" }));
      expect(runResults.some((e) => e.key === "global-key")).toBe(false);

      const globalResults = await collect(store.query({ scope: "global" }));
      expect(globalResults.some((e) => e.key === "global-key")).toBe(true);
    });
  });

  describe("read() null path", () => {
    it("returns null when no entry exists for (kind, key)", async () => {
      const result = await store.read("run:r1", "finding", "does-not-exist");
      expect(result).toBeNull();
    });

    it("returns null for a key that exists under a different kind", async () => {
      await store.append(
        "run:r1",
        env({ kind: "finding", key: "shared-key", version: 1 })
      );
      const result = await store.read("run:r1", "lesson", "shared-key");
      expect(result).toBeNull();
    });
  });

  describe("subscribe()", () => {
    it("unsubscribe stops delivery of subsequent entries", async () => {
      const received: string[] = [];
      const unsub = store.subscribe({ scope: "run:r1", kind: "finding" }, (e) =>
        received.push(e.key)
      );
      await store.append("run:r1", env({ key: "before-unsub", version: 1 }));
      await new Promise((r) => setTimeout(r, 20));
      unsub();
      await store.append("run:r1", env({ key: "after-unsub", version: 1 }));
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toContain("before-unsub");
      expect(received).not.toContain("after-unsub");
    });

    it("does not deliver entries that do not match the kind filter", async () => {
      const received: string[] = [];
      const unsub = store.subscribe({ scope: "run:r1", kind: "finding" }, (e) =>
        received.push(e.key)
      );
      await store.append(
        "run:r1",
        env({
          kind: "lesson",
          key: "lesson-key",
          version: 1,
          payload: {
            scope: "this-run",
            rule: "r",
            why: "w",
            howToApply: "h",
            evidenceLinks: [],
          },
        })
      );
      await new Promise((r) => setTimeout(r, 20));
      unsub();
      expect(received).not.toContain("lesson-key");
    });

    it("does not deliver entries from a different scope", async () => {
      const received: string[] = [];
      const unsub = store.subscribe({ scope: "run:r1" }, (e) =>
        received.push(e.key)
      );
      await store.append("run:r2", env({ key: "other-scope", version: 1 }));
      await new Promise((r) => setTimeout(r, 20));
      unsub();
      expect(received).not.toContain("other-scope");
    });
  });

  describe("invalid scope", () => {
    it("throws for an unrecognised scope format", async () => {
      await expect(
        collect(store.query({ scope: "invalid-scope-string" }))
      ).rejects.toThrow(/Invalid scope/);
    });

    it("throws for a run scope without an id", async () => {
      await expect(collect(store.query({ scope: "run:" }))).rejects.toThrow(
        /Invalid scope/
      );
    });
  });
});
