/**
 * ERR-H-12 regression: the write path must NOT silently swallow failures.
 *
 * Previously both the semantic index upsert catch and the outer primary
 * write catch were `.catch(()=>{})` / `catch {}` with no logging and no
 * failure event. That let a write "succeed" (or the index drift) with zero
 * observability. These tests pin the new behavior: on failure we emit a
 * canonical failure event AND log a structured error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryService } from "../memory-service.js";
import { embedConventions } from "../convention/convention-store.js";
import type { BaseStore } from "@langchain/langgraph";
import type { NamespaceConfig, SemanticStoreAdapter } from "../memory-types.js";
import type { DetectedConvention } from "../convention/types.js";

function makeOkStore(): { store: BaseStore; put: ReturnType<typeof vi.fn> } {
  const data = new Map<string, Record<string, unknown>>();
  const put = vi.fn(
    async (_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value);
    }
  );
  const store = {
    put,
    search: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    delete: vi.fn(async () => {}),
  } as unknown as BaseStore;
  return { store, put };
}

function makeFailingStore(): BaseStore {
  return {
    put: vi.fn().mockRejectedValue(new Error("primary boom")),
    search: vi.fn().mockRejectedValue(new Error("primary boom")),
    get: vi.fn().mockRejectedValue(new Error("primary boom")),
    delete: vi.fn().mockRejectedValue(new Error("primary boom")),
  } as unknown as BaseStore;
}

const nsConfigs: NamespaceConfig[] = [
  { name: "observations", scopeKeys: ["tenantId"], searchable: true },
];

describe("ERR-H-12 — write-path failure telemetry", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("emits memory:error and logs when the semantic index upsert rejects (primary write still ok)", async () => {
    const { store, put } = makeOkStore();
    const emit = vi.fn();
    const semanticStore: SemanticStoreAdapter = {
      upsert: vi.fn().mockRejectedValue(new Error("index boom")),
      search: vi.fn(async () => []),
    } as unknown as SemanticStoreAdapter;

    const svc = new MemoryService(store, nsConfigs, {
      eventBus: { emit },
      semanticStore,
    });
    await expect(
      svc.put("observations", { tenantId: "t1" }, "k1", { text: "hello" })
    ).resolves.toBeUndefined();

    // Primary write DID succeed...
    expect(put).toHaveBeenCalledTimes(1);
    // ...but the index failure is now observable, not swallowed.
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory:error",
        namespace: "observations",
        key: "k1",
        message: "index boom",
      })
    );
    expect(errSpy).toHaveBeenCalledWith(
      "[memory] semantic index upsert failed",
      expect.objectContaining({
        namespace: "observations",
        key: "k1",
        error: "index boom",
      })
    );
  });

  it("emits memory:put_failed and logs when the primary store write rejects", async () => {
    const store = makeFailingStore();
    const emit = vi.fn();

    const svc = new MemoryService(store, nsConfigs, { eventBus: { emit } });
    await expect(
      svc.put("observations", { tenantId: "t1" }, "k2", { text: "hello" })
    ).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory:put_failed",
        namespace: "observations",
        key: "k2",
        message: "primary boom",
      })
    );
    expect(errSpy).toHaveBeenCalledWith(
      "[memory] primary store write failed",
      expect.objectContaining({
        namespace: "observations",
        key: "k2",
        error: "primary boom",
      })
    );
  });

  it("logs when the convention semantic index upsert rejects", async () => {
    const semanticStore: SemanticStoreAdapter = {
      upsert: vi.fn().mockRejectedValue(new Error("conv boom")),
      search: vi.fn(async () => []),
    } as unknown as SemanticStoreAdapter;

    const conventions: DetectedConvention[] = [
      {
        id: "c1",
        name: "n",
        description: "d",
        category: "style",
        confidence: 0.9,
      } as unknown as DetectedConvention,
    ];

    await expect(
      embedConventions(semanticStore, conventions)
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith(
      "[memory] convention semantic index upsert failed",
      expect.objectContaining({ count: 1, error: "conv boom" })
    );
  });
});
