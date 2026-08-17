/**
 * `kind` is what discriminates `KnowledgePayload`, so an envelope whose kind is
 * outside the union carries a payload no consumer can interpret. The shared
 * `isKnowledgeEnvelope` guard only asserts `typeof kind === "string"`, which
 * admits a misspelling — and nothing on this store's read path called it
 * anyway, so a hand-edited or half-written file was loaded and handed back as
 * trusted knowledge.
 *
 * Fixture discipline: every negative case corrupts a file the store itself
 * wrote, and first asserts the *uncorrupted* read succeeds and carries its
 * payload. A validation test that passes because the read path was never
 * reached proves nothing about the validation.
 *
 * Real tmpdir + real store, matching the sibling specs — no fs mocks.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FilesystemKnowledgeStore } from "../filesystem-knowledge-store.js";
import { entriesPath, snapshotPath } from "../knowledge-paths.js";
import type { KnowledgeEnvelope } from "@dzupagent/agent-types/fleet";

/**
 * Distinctive payload text. Asserting on it is how each case proves the store
 * actually parsed the bytes under test rather than short-circuiting earlier.
 */
const SUMMARY = "payload-proving-the-store-parsed-this-file";

const SCOPE = "run:r1";
const SCOPE_KEY = "run-r1";

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
      summary: SUMMARY,
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

/** Rewrites the on-disk snapshot the store just wrote, returning its path. */
async function corruptSnapshot(
  key: string,
  mutate: (raw: Record<string, unknown>) => void
): Promise<string> {
  const file = snapshotPath(tmp, SCOPE_KEY, "finding", key);
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(raw);
  await fs.writeFile(file, JSON.stringify(raw, null, 2));
  return file;
}

/** Rewrites one NDJSON line in place, returning the log path. */
async function corruptLogLine(
  index: number,
  mutate: (raw: Record<string, unknown>) => void
): Promise<string> {
  const file = entriesPath(tmp, SCOPE_KEY);
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
  const target = lines[index];
  if (target === undefined) {
    throw new Error(`no NDJSON line at index ${index} (have ${lines.length})`);
  }
  const raw = JSON.parse(target) as Record<string, unknown>;
  mutate(raw);
  lines[index] = JSON.stringify(raw);
  await fs.writeFile(file, lines.join("\n") + "\n");
  return file;
}

/** Appends a healthy entry and proves it reads back with its payload. */
async function seedAndProveReadable(key: string): Promise<void> {
  await store.append(SCOPE, env({ key, version: 1 }));
  const before = await store.read(SCOPE, "finding", key);
  expect(before).toMatchObject({
    key,
    kind: "finding",
    payload: { summary: SUMMARY },
  });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fks-kind-"));
  store = new FilesystemKnowledgeStore({ rootDir: tmp });
});

describe("FilesystemKnowledgeStore — kind validation on the read path", () => {
  describe("read()", () => {
    it("returns the stored envelope when kind is a member of the union", async () => {
      await store.append(SCOPE, env({ key: "valid", version: 1 }));

      const got = await store.read(SCOPE, "finding", "valid");

      // Not just "non-null": the payload proves the store parsed the file this
      // suite is about to corrupt in every case below.
      expect(got).toMatchObject({
        key: "valid",
        kind: "finding",
        payload: { summary: SUMMARY },
      });
    });

    it("rejects a snapshot whose kind is absent", async () => {
      await seedAndProveReadable("absent");
      await corruptSnapshot("absent", (raw) => {
        delete raw.kind;
      });

      await expect(store.read(SCOPE, "finding", "absent")).rejects.toThrow(
        /kind must be one of/
      );
    });

    it("rejects a snapshot whose kind is a misspelling of a real kind", async () => {
      // The load-bearing case. "fnding" is a non-empty string, so a truthiness
      // or `typeof === "string"` check waves it through; only membership in the
      // union catches it.
      await seedAndProveReadable("misspelled");
      await corruptSnapshot("misspelled", (raw) => {
        raw.kind = "fnding";
      });

      await expect(store.read(SCOPE, "finding", "misspelled")).rejects.toThrow(
        /got "fnding"/
      );
    });

    it("rejects a snapshot whose kind is an unknown but plausible value", async () => {
      await seedAndProveReadable("unknown-kind");
      await corruptSnapshot("unknown-kind", (raw) => {
        raw.kind = "observation";
      });

      await expect(store.read(SCOPE, "finding", "unknown-kind")).rejects.toThrow(
        /kind must be one of/
      );
    });

    it("rejects a snapshot whose kind is a number", async () => {
      await seedAndProveReadable("numeric");
      await corruptSnapshot("numeric", (raw) => {
        raw.kind = 42;
      });

      await expect(store.read(SCOPE, "finding", "numeric")).rejects.toThrow(
        /got 42/
      );
    });

    it("rejects a snapshot whose kind is null", async () => {
      await seedAndProveReadable("nulled");
      await corruptSnapshot("nulled", (raw) => {
        raw.kind = null;
      });

      await expect(store.read(SCOPE, "finding", "nulled")).rejects.toThrow(
        /got null/
      );
    });

    it("names the offending file so an operator can find it", async () => {
      await seedAndProveReadable("named");
      const file = await corruptSnapshot("named", (raw) => {
        raw.kind = "fnding";
      });

      await expect(store.read(SCOPE, "finding", "named")).rejects.toThrow(file);
    });

    it("still reads a healthy entry when a different key is corrupt", async () => {
      await seedAndProveReadable("healthy");
      await seedAndProveReadable("rotten");
      await corruptSnapshot("rotten", (raw) => {
        raw.kind = "fnding";
      });

      // The failure must be scoped to the corrupt file, not a blanket refusal.
      await expect(store.read(SCOPE, "finding", "healthy")).resolves.toMatchObject(
        { key: "healthy", payload: { summary: SUMMARY } }
      );
    });

    it("CONTROL: malformed JSON fails through JSON.parse, not the kind check", async () => {
      await seedAndProveReadable("garbage");
      await fs.writeFile(
        snapshotPath(tmp, SCOPE_KEY, "finding", "garbage"),
        "{ this is not json"
      );

      // Pins the pre-existing convention this fix was matched to, and proves
      // the new check is a distinct failure mode rather than the thing that
      // happens to catch every bad file.
      await expect(store.read(SCOPE, "finding", "garbage")).rejects.toThrow(
        SyntaxError
      );
      await expect(store.read(SCOPE, "finding", "garbage")).rejects.not.toThrow(
        /kind must be one of/
      );
    });
  });

  describe("query()", () => {
    it("yields stored envelopes with their payloads", async () => {
      await store.append(SCOPE, env({ key: "q1", version: 1 }));
      await store.append(SCOPE, env({ key: "q2", version: 1 }));

      const results = await collect(store.query({ scope: SCOPE }));

      expect(results).toHaveLength(2);
      expect(results.map((e) => e.key).sort()).toEqual(["q1", "q2"]);
      expect(results[0]).toMatchObject({ payload: { summary: SUMMARY } });
    });

    it("rejects when any line in the log has an unknown kind", async () => {
      await store.append(SCOPE, env({ key: "q1", version: 1 }));
      await store.append(SCOPE, env({ key: "q2", version: 1 }));
      const file = await corruptLogLine(1, (raw) => {
        raw.kind = "fnding";
      });

      await expect(collect(store.query({ scope: SCOPE }))).rejects.toThrow(file);
    });

    it("fails the load rather than silently returning the surviving entries", async () => {
      await store.append(SCOPE, env({ key: "survivor", version: 1 }));
      await store.append(SCOPE, env({ key: "corrupt", version: 1 }));
      await corruptLogLine(1, (raw) => {
        raw.kind = "fnding";
      });

      // This is the skip-vs-fail decision, asserted directly: a skipping
      // implementation resolves with the one healthy entry and no signal.
      let resolved: KnowledgeEnvelope[] | undefined;
      let thrown: unknown;
      try {
        resolved = await collect(store.query({ scope: SCOPE }));
      } catch (err) {
        thrown = err;
      }

      expect(resolved).toBeUndefined();
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/kind must be one of/);
    });

    it("rejects even when the corrupt entry does not match the caller's filter", async () => {
      await store.append(SCOPE, env({ key: "q1", version: 1 }));
      await store.append(SCOPE, env({ key: "q2", version: 1 }));
      await corruptLogLine(1, (raw) => {
        raw.kind = "fnding";
      });

      // Validation runs before filtering, so whether corruption is detected
      // does not depend on what the caller happened to ask for. A skipping
      // implementation would resolve to [] here and look perfectly healthy.
      await expect(
        collect(store.query({ scope: SCOPE, kind: "lesson" }))
      ).rejects.toThrow(/kind must be one of/);
    });

    it("rejects a log line whose kind is absent", async () => {
      await store.append(SCOPE, env({ key: "q1", version: 1 }));
      await corruptLogLine(0, (raw) => {
        delete raw.kind;
      });

      await expect(collect(store.query({ scope: SCOPE }))).rejects.toThrow(
        /kind must be one of/
      );
    });

    it("leaves an uncorrupted log fully readable", async () => {
      await store.append(SCOPE, env({ key: "q1", version: 1 }));
      await store.append(SCOPE, env({ key: "q2", version: 1 }));

      // Guards against an over-broad check that rejects healthy logs too.
      await expect(
        collect(store.query({ scope: SCOPE, kind: "finding" }))
      ).resolves.toHaveLength(2);
    });
  });
});
