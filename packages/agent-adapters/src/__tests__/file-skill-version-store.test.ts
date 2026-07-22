import { describe, expect, it, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { FileAdapterSkillVersionStore } from "../skills/adapter-skill-version-store.js";
import type { VersionedProjection } from "../skills/adapter-skill-version-store.js";
import type { CompiledAdapterSkill } from "../skills/adapter-skill-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateFile(): string {
  return join(
    tmpdir(),
    `dzup-state-${randomBytes(6).toString("hex")}`,
    "state.json"
  );
}

function makeCompiled(): CompiledAdapterSkill {
  return {
    providerId: "claude",
    projectionVersion: "1.0.0",
    runtimeConfig: { systemPrompt: "test prompt" },
    hash: "abc123",
  };
}

function makeProjection(
  bundleId: string,
  version: number,
  overrides: Partial<VersionedProjection> = {}
): VersionedProjection {
  return {
    projectionId: `${bundleId}-claude-v${version}`,
    bundleId,
    providerId: "claude",
    version,
    compiled: makeCompiled(),
    hash: `hash-${version}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileAdapterSkillVersionStore", () => {
  const statePaths: string[] = [];

  afterEach(async () => {
    for (const p of statePaths) {
      await rm(join(p, ".."), { recursive: true, force: true });
    }
    statePaths.length = 0;
  });

  function makeStore(debounceMs = 0): {
    store: FileAdapterSkillVersionStore;
    stateFile: string;
  } {
    const stateFile = makeStateFile();
    statePaths.push(stateFile);
    const store = new FileAdapterSkillVersionStore({
      stateFilePath: stateFile,
      writeDebounceMs: debounceMs,
    });
    return { store, stateFile };
  }

  it("save + getLatest round-trip (writes to file)", async () => {
    const { store } = makeStore();
    const projection = makeProjection("bundle-a", 1);

    store.save(projection);
    await store.flush();

    const latest = store.getLatest("bundle-a", "claude");
    expect(latest).toBeDefined();
    expect(latest!.version).toBe(1);
    expect(latest!.bundleId).toBe("bundle-a");
  });

  it("getLatest returns undefined when bundle has no versions", () => {
    const { store } = makeStore();
    expect(store.getLatest("nonexistent", "claude")).toBeUndefined();
  });

  it("listVersions returns all saved versions in order", async () => {
    const { store } = makeStore();

    store.save(makeProjection("bundle-b", 1));
    store.save(makeProjection("bundle-b", 2));
    store.save(makeProjection("bundle-b", 3));
    await store.flush();

    const versions = store.listVersions("bundle-b", "claude");
    expect(versions).toHaveLength(3);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it("rollback creates a new version with target compiled output", async () => {
    const { store } = makeStore();

    const v1 = makeProjection("bundle-c", 1);
    store.save(v1);

    const v2 = makeProjection("bundle-c", 2, { hash: "newer-hash" });
    store.save(v2);
    await store.flush();

    const rolled = store.rollback("bundle-c", "claude", 1);
    await store.flush();
    expect(rolled.version).toBe(3);
    expect(rolled.hash).toBe("hash-1"); // rolled back to v1's hash
    expect(rolled.compiled).toEqual(v1.compiled);
  });

  it("rollback throws for unknown version", () => {
    const { store } = makeStore();
    store.save(makeProjection("bundle-d", 1));
    expect(() => store.rollback("bundle-d", "claude", 99)).toThrow(
      "Version 99 not found"
    );
  });

  it("persists state to file and reloads correctly", async () => {
    const { stateFile } = makeStore();

    // Write with first store instance
    const store1 = new FileAdapterSkillVersionStore({
      stateFilePath: stateFile,
      writeDebounceMs: 0,
    });
    const dir = join(stateFile, "..");
    await mkdir(dir, { recursive: true });

    store1.save(makeProjection("bundle-e", 1));
    await store1.flush();

    // Read with fresh instance (no in-memory state)
    const store2 = new FileAdapterSkillVersionStore({
      stateFilePath: stateFile,
      writeDebounceMs: 0,
    });
    const latest = store2.getLatest("bundle-e", "claude");
    expect(latest).toBeDefined();
    expect(latest!.version).toBe(1);
  });

  it("missing state file is created on first write", async () => {
    const { store } = makeStore();
    store.save(makeProjection("bundle-f", 1));
    await store.flush();

    // If we get here without throwing, the file was created
    const latest = store.getLatest("bundle-f", "claude");
    expect(latest).toBeDefined();
  });

  // ERR-M-10: a failing debounced persist() must be observable via the logger
  // and must NOT surface as a process-level unhandledRejection.
  describe("debounced persist() failure handling (ERR-M-10)", () => {
    /**
     * Produce a state.json path guaranteed to make persist()'s mkdir/writeFile
     * reject, without mocking node:fs. We create a *regular file* and point the
     * store at a path underneath it — mkdir/writeFile on a child of a
     * non-directory yields a real ENOTDIR rejection.
     */
    async function makeFailingStatePath(): Promise<string> {
      const base = makeStateFile(); // <tmpdir>/dzup-state-XXXX/state.json
      statePaths.push(base);
      const blocker = join(base, ".."); // .../dzup-state-XXXX — create as a FILE
      await mkdir(join(base, "..", ".."), { recursive: true }).catch(() => {});
      await writeFile(blocker, "not a directory", "utf-8");
      return join(blocker, "state.json"); // resolves under a regular file
    }

    it("logs via injected logger and does not emit unhandledRejection", async () => {
      const failingPath = await makeFailingStatePath();

      const errors: Record<string, unknown>[] = [];
      const logger = {
        error: (payload: Record<string, unknown>) => errors.push(payload),
      };

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);

      try {
        const store = new FileAdapterSkillVersionStore({
          stateFilePath: failingPath,
          writeDebounceMs: 1,
          logger,
        });

        // save() schedules the debounced persist via setTimeout (the unguarded
        // path in the finding). We deliberately do NOT call flush() — flush()
        // awaits persist() directly and would surface the rejection to the
        // caller rather than through the timer's catch handler.
        store.save(makeProjection("bundle-fail", 1));

        // Wait past the debounce, then let the IO/microtask queue drain so the
        // rejected persist() promise settles and its .catch runs.
        await new Promise((r) => setTimeout(r, 30));
        await new Promise((r) => setImmediate(r));

        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
          operation: "skill.version.persist",
        });
        expect(String(errors[0]!.error)).toMatch(
          /ENOTDIR|ENOENT|EEXIST|not a directory/i
        );
        expect(unhandled).toHaveLength(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("falls back to structured console.error when no logger is injected", async () => {
      const failingPath = await makeFailingStatePath();

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);

      try {
        const store = new FileAdapterSkillVersionStore({
          stateFilePath: failingPath,
          writeDebounceMs: 1,
        });

        store.save(makeProjection("bundle-fail-2", 1));

        await new Promise((r) => setTimeout(r, 30));
        await new Promise((r) => setImmediate(r));

        expect(consoleSpy).toHaveBeenCalledTimes(1);
        const line = String(consoleSpy.mock.calls[0]?.[0]);
        const parsed = JSON.parse(line);
        expect(parsed.operation).toBe("skill.version.persist");
        expect(String(parsed.error)).toMatch(
          /ENOTDIR|ENOENT|EEXIST|not a directory/i
        );
        expect(unhandled).toHaveLength(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        consoleSpy.mockRestore();
      }
    });
  });
});
