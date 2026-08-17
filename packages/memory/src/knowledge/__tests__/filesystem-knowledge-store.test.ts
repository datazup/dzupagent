import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FilesystemKnowledgeStore } from "../filesystem-knowledge-store.js";
import { knowledgeStoreContractCases } from "@dzupagent/agent-types/fleet-contract";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fkstest-"));
});

// The shared conformance contract ships as plain data through the package
// boundary; this file supplies the vitest bindings. It used to be reached by a
// relative path into agent-types' *source* test tree, which forced this
// package's flipcheck rootDir open to "..".
describe("KnowledgeStore contract: FilesystemKnowledgeStore", () => {
  for (const contractCase of knowledgeStoreContractCases) {
    it(contractCase.name, async () => {
      await contractCase.run(
        async () => new FilesystemKnowledgeStore({ rootDir: tmp })
      );
    });
  }
});

describe("FilesystemKnowledgeStore specifics", () => {
  it("append is retry-safe when snapshot write fails after NDJSON commit", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const entry = {
      id: "i-retry",
      runId: "r1",
      repo: null,
      kind: "finding" as const,
      key: "k-retry",
      version: 1,
      authorWorkerId: null,
      parentId: null,
      createdAt: new Date().toISOString(),
      supersededAt: null,
      payload: {
        category: "hotspot" as const,
        location: "a:1",
        summary: "",
        evidence: [],
        confidence: 1,
      },
      tags: [],
    };
    // First append succeeds
    await store.append("run:r1", entry);
    // Retrying the exact same (scope, kind, key, version) should NOT throw —
    // it must be idempotent (the entry is already durable)
    await expect(store.append("run:r1", entry)).resolves.toMatchObject({
      id: "i-retry",
      version: 1,
    });
  });

  it("writes entries.ndjson and a snapshot file", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    await store.append("run:r1", {
      id: "i1",
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
        location: "a:1",
        summary: "",
        evidence: [],
        confidence: 1,
      },
      tags: [],
    });
    const ndjson = await fs.readFile(
      path.join(tmp, "run-r1", "knowledge", "entries.ndjson"),
      "utf8"
    );
    expect(ndjson.trim().split("\n")).toHaveLength(1);
    const snap = await fs.readFile(
      path.join(tmp, "run-r1", "knowledge", "snapshots", "finding", "k.json"),
      "utf8"
    );
    expect(JSON.parse(snap).key).toBe("k");
  });
});
