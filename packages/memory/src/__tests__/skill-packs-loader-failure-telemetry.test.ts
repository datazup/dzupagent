/**
 * ERR-L-04 regression: SkillPackLoader must NOT silently swallow store errors.
 *
 * Previously every catch in loadPack/isPackLoaded/getLoadedPacks collapsed a
 * store failure into a benign value (dropped entry / false / []) with zero
 * observability, so a pack could under-load with no signal. These tests pin
 * the new behavior: on a store failure we log a structured warning AND the
 * returned loaded count reflects the dropped entry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SkillPackLoader } from "../skill-packs.js";
import type { SkillPack } from "../skill-packs.js";
import type { BaseStore } from "@langchain/langgraph";

function makePack(): SkillPack {
  return {
    id: "test-pack",
    name: "Test Pack",
    version: "1.0.0",
    description: "a pack",
    featureCategory: "general",
    entries: [
      { type: "skill", name: "s0", content: "c0" },
      { type: "skill", name: "s1", content: "c1" },
    ],
  } as unknown as SkillPack;
}

describe("ERR-L-04 — skill-pack loader failure telemetry", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs and under-counts loaded when one entry write rejects", async () => {
    let call = 0;
    const store = {
      // meta get (isPackLoaded) -> not loaded, entry puts, meta put
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockImplementation((ns: string[], key: string) => {
        // fail the first ENTRY write (skill namespace), succeed the rest incl. meta
        call++;
        if (call === 1) return Promise.reject(new Error("entry boom"));
        return Promise.resolve();
      }),
      search: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as BaseStore;

    const loader = new SkillPackLoader(store);
    const result = await loader.loadPack(makePack());

    // 2 entries, 1 failed -> only 1 loaded
    expect(result.loaded).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[memory] skill-pack entry write failed",
      expect.objectContaining({
        operation: "skillPacks.loadPack.entry",
        packId: "test-pack",
        error: "entry boom",
      }),
    );
  });

  it("logs when the metadata write rejects", async () => {
    const store = {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockImplementation((ns: string[]) => {
        // fail only the meta write (namespace ends with packs-meta marker) — detect by 3rd call
        return Promise.resolve();
      }),
      search: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as BaseStore;
    // Rewire: reject the LAST put (meta)
    let calls = 0;
    (store.put as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls++;
      if (calls === 3) return Promise.reject(new Error("meta boom"));
      return Promise.resolve();
    });

    const loader = new SkillPackLoader(store);
    await loader.loadPack(makePack());

    expect(warnSpy).toHaveBeenCalledWith(
      "[memory] skill-pack metadata write failed",
      expect.objectContaining({
        operation: "skillPacks.loadPack.meta",
        packId: "test-pack",
        error: "meta boom",
      }),
    );
  });

  it("logs when isPackLoaded store.get rejects and returns false", async () => {
    const store = {
      get: vi.fn().mockRejectedValue(new Error("get boom")),
      put: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as BaseStore;

    const loader = new SkillPackLoader(store);
    await expect(loader.isPackLoaded("test-pack")).resolves.toBe(false);

    expect(warnSpy).toHaveBeenCalledWith(
      "[memory] skill-pack isPackLoaded check failed",
      expect.objectContaining({
        operation: "skillPacks.isPackLoaded",
        packId: "test-pack",
        error: "get boom",
      }),
    );
  });

  it("logs when getLoadedPacks store.search rejects and returns []", async () => {
    const store = {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockRejectedValue(new Error("search boom")),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as BaseStore;

    const loader = new SkillPackLoader(store);
    await expect(loader.getLoadedPacks()).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(
      "[memory] skill-pack getLoadedPacks search failed",
      expect.objectContaining({
        operation: "skillPacks.getLoadedPacks",
        error: "search boom",
      }),
    );
  });
});
