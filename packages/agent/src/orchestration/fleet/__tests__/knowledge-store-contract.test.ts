import { describe, it, expect } from "vitest";
import type { KnowledgeStore } from "../knowledge-store.js";
import type { KnowledgeEnvelope } from "../fleet-types.js";

export function runKnowledgeStoreContract(
  label: string,
  factory: () => Promise<KnowledgeStore>
) {
  describe(`KnowledgeStore contract: ${label}`, () => {
    const envelope = (
      overrides: Partial<KnowledgeEnvelope> = {}
    ): KnowledgeEnvelope => ({
      id: overrides.id ?? `id-${Math.random().toString(36).slice(2)}`,
      runId: "run1",
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
        location: "a:1",
        summary: "",
        evidence: [],
        confidence: 1,
      },
      tags: [],
      ...overrides,
    });

    it("append returns a ref with id and version", async () => {
      const s = await factory();
      const ref = await s.append(
        "run:run1",
        envelope({ kind: "finding", key: "k1", version: 1 })
      );
      expect(ref.id).toBeTruthy();
      expect(ref.version).toBe(1);
    });

    it("read returns the latest non-superseded entry for (kind,key)", async () => {
      const s = await factory();
      await s.append(
        "run:run1",
        envelope({ kind: "finding", key: "k2", version: 1 })
      );
      await s.append(
        "run:run1",
        envelope({ kind: "finding", key: "k2", version: 2 })
      );
      const got = await s.read("run:run1", "finding", "k2");
      expect(got?.version).toBe(2);
    });

    it("append rejects on (scope, kind, key, version) collision", async () => {
      const s = await factory();
      await s.append(
        "run:run1",
        envelope({ kind: "finding", key: "k3", version: 1 })
      );
      await expect(
        s.append(
          "run:run1",
          envelope({ kind: "finding", key: "k3", version: 1 })
        )
      ).rejects.toThrow(/collision|exists|conflict/i);
    });

    it("query yields entries matching kind filter", async () => {
      const s = await factory();
      await s.append(
        "run:run1",
        envelope({ kind: "finding", key: "q1", version: 1 })
      );
      await s.append(
        "run:run1",
        envelope({
          kind: "lesson",
          key: "q2",
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
      const results: KnowledgeEnvelope[] = [];
      for await (const e of s.query({ scope: "run:run1", kind: "finding" })) {
        results.push(e);
      }
      expect(results.map((r) => r.key)).toContain("q1");
      expect(results.map((r) => r.key)).not.toContain("q2");
    });

    it("subscribe invokes handler for new matching entries", async () => {
      const s = await factory();
      const seen: string[] = [];
      const unsub = s.subscribe({ scope: "run:run1", kind: "finding" }, (e) => {
        seen.push(e.key);
      });
      await s.append(
        "run:run1",
        envelope({ kind: "finding", key: "sub1", version: 1 })
      );
      await new Promise((r) => setTimeout(r, 50));
      unsub();
      expect(seen).toContain("sub1");
    });
  });
}

describe("placeholder so vitest discovers this file", () => {
  it("is loaded", () => {
    expect(true).toBe(true);
  });
});
