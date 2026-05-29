import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FilesystemKnowledgeStore } from "../filesystem-knowledge-store.js";
import { rebuildSnapshots } from "../knowledge-snapshot-rebuilder.js";
import { scopeKeyForRun } from "../knowledge-paths.js";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rebuild-"));
});

describe("rebuildSnapshots", () => {
  it("succeeds on a fresh run that has never had any knowledge appended", async () => {
    await expect(
      rebuildSnapshots({ rootDir: tmp, runId: "never-written" })
    ).resolves.toBeUndefined();
  });

  it("uses scopeKeyForRun() from knowledge-paths consistently with the store", async () => {
    // scopeKeyForRun must produce the same directory name the store uses for
    // "run:r1" — if it diverges, rebuilder writes snapshots to the wrong path
    expect(scopeKeyForRun("r1")).toBe("run-r1");
  });

  it("rebuilds snapshots from NDJSON after they are deleted", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    await store.append("run:r1", mkFinding("k1", 1));
    await store.append("run:r1", mkFinding("k1", 2));
    await fs.rm(
      path.join(tmp, scopeKeyForRun("r1"), "knowledge", "snapshots"),
      {
        recursive: true,
      }
    );
    await rebuildSnapshots({ rootDir: tmp, runId: "r1" });
    const snap = JSON.parse(
      await fs.readFile(
        path.join(
          tmp,
          "run-r1",
          "knowledge",
          "snapshots",
          "finding",
          "k1.json"
        ),
        "utf8"
      )
    );
    expect(snap.version).toBe(2);
  });
});

function mkFinding(key: string, version: number) {
  return {
    id: `${key}-${version}`,
    runId: "r1",
    repo: null,
    kind: "finding" as const,
    key,
    version,
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
}
