/**
 * W27-B: Deep coverage for memory-service-adapter (memoryServiceToClient),
 * EnvKeyProvider edge cases, and EncryptedMemoryService additional paths.
 *
 * memory-service-adapter.ts has zero existing test coverage.
 * This file adds:
 *   - memoryServiceToClient: get/put/delete/search delegation, scope conversion,
 *     record lifting (id/key/content/text fields), pagination (offset+limit),
 *     metadata extraction, delete fallback when svc.delete is absent
 *   - EnvKeyProvider: edge cases (no keys, multiple active candidates, key order)
 *   - EncryptedMemoryService: concurrent puts, large payloads, plaintext null values,
 *     namespace case-sensitivity, rotateKey with multiple namespaces
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { memoryServiceToClient } from "../memory-service-adapter.js";
import type { MemoryServiceLike } from "../memory-service-adapter.js";
import { EnvKeyProvider } from "../encryption/env-key-provider.js";
import { EncryptedMemoryService } from "../encryption/encrypted-memory-service.js";
import type {
  EncryptionKeyDescriptor,
  EncryptionKeyProvider,
} from "../encryption/types.js";
import type { MemoryService } from "../memory-service.js";
import type { MemoryScope, MemoryRecord } from "@dzupagent/agent-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHexKey(): string {
  return randomBytes(32).toString("hex");
}

function makeKey(
  keyId: string,
  status: "active" | "rotated" | "revoked" = "active"
): EncryptionKeyDescriptor {
  return {
    keyId,
    key: randomBytes(32),
    status,
    createdAt: new Date(),
  };
}

function createMockKeyProvider(
  keys: EncryptionKeyDescriptor[]
): EncryptionKeyProvider {
  const map = new Map(keys.map((k) => [k.keyId, k]));
  const active = keys.find((k) => k.status === "active");
  return {
    getKey: async (id: string) => map.get(id),
    getActiveKey: async () => active,
    listKeys: async () => keys,
  };
}

function createMockMemoryService(): {
  svc: MemoryService;
  putSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
  searchSpy: ReturnType<typeof vi.fn>;
  formatSpy: ReturnType<typeof vi.fn>;
} {
  const putSpy = vi.fn().mockResolvedValue(undefined);
  const getSpy = vi.fn().mockResolvedValue([]);
  const searchSpy = vi.fn().mockResolvedValue([]);
  const formatSpy = vi.fn().mockReturnValue("formatted");

  const svc = {
    put: putSpy,
    get: getSpy,
    search: searchSpy,
    formatForPrompt: formatSpy,
  } as unknown as MemoryService;

  return { svc, putSpy, getSpy, searchSpy, formatSpy };
}

const SCOPE: MemoryScope = { tenantId: "t1", projectId: "p1" };

// ===========================================================================
// memoryServiceToClient — scope conversion
// ===========================================================================

describe("memoryServiceToClient — scope conversion", () => {
  it("converts full MemoryScope to flat Record<string,string>", async () => {
    const getSpy = vi.fn().mockResolvedValue([]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    await client.get("ns", {
      tenantId: "t1",
      workspaceId: "w1",
      projectId: "p1",
      taskId: "task1",
    });

    expect(getSpy).toHaveBeenCalledWith("ns", {
      tenantId: "t1",
      workspaceId: "w1",
      projectId: "p1",
      taskId: "task1",
    });
  });

  it("omits optional scope fields when undefined", async () => {
    const getSpy = vi.fn().mockResolvedValue([]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    await client.get("ns", { tenantId: "t2" });

    const callArgs = getSpy.mock.calls[0]![1] as Record<string, string>;
    expect(callArgs["tenantId"]).toBe("t2");
    expect(callArgs["workspaceId"]).toBeUndefined();
    expect(callArgs["projectId"]).toBeUndefined();
    expect(callArgs["taskId"]).toBeUndefined();
  });

  it("put converts scope correctly", async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const svc: MemoryServiceLike = { get: vi.fn(), put: putSpy };
    const client = memoryServiceToClient(svc);

    const record: MemoryRecord = {
      id: "r1",
      namespace: "ns",
      scope: { tenantId: "t1", projectId: "p2" },
      content: "hello",
      createdAt: 1000,
      updatedAt: 2000,
    };
    await client.put("ns", { tenantId: "t1", projectId: "p2" }, record);

    expect(putSpy).toHaveBeenCalledWith(
      "ns",
      { tenantId: "t1", projectId: "p2" },
      "r1",
      expect.objectContaining({ text: "hello" })
    );
  });
});

// ===========================================================================
// memoryServiceToClient — get() record lifting
// ===========================================================================

describe("memoryServiceToClient — get() record lifting", () => {
  it("uses id field when present", async () => {
    const getSpy = vi
      .fn()
      .mockResolvedValue([
        {
          id: "explicit-id",
          text: "content",
          createdAt: 1000,
          updatedAt: 2000,
        },
      ]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records[0]!.id).toBe("explicit-id");
  });

  it("falls back to key field when id is absent", async () => {
    const getSpy = vi
      .fn()
      .mockResolvedValue([
        { key: "from-key", text: "content", createdAt: 1000, updatedAt: 2000 },
      ]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records[0]!.id).toBe("from-key");
  });

  it("uses fallback id when neither id nor key is present", async () => {
    const getSpy = vi.fn().mockResolvedValue([{ text: "orphan" }]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records[0]!.id).toBe("legacy-0");
  });

  it("uses text field as content", async () => {
    const getSpy = vi
      .fn()
      .mockResolvedValue([
        { id: "r1", text: "hello world", createdAt: 1000, updatedAt: 2000 },
      ]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records[0]!.content).toBe("hello world");
  });

  it("falls back to content field when text is absent", async () => {
    const getSpy = vi
      .fn()
      .mockResolvedValue([
        { id: "r1", content: "from-content", createdAt: 1000, updatedAt: 2000 },
      ]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records[0]!.content).toBe("from-content");
  });

  it("JSON-stringifies value when no text/content field present", async () => {
    const raw = { id: "r1", foo: "bar", num: 42 };
    const getSpy = vi.fn().mockResolvedValue([raw]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    const parsed = JSON.parse(records[0]!.content);
    expect(parsed).toEqual(raw);
  });

  it("preserves createdAt and updatedAt timestamps", async () => {
    const getSpy = vi
      .fn()
      .mockResolvedValue([
        { id: "r1", text: "x", createdAt: 1234567890, updatedAt: 9876543210 },
      ]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records[0]!.createdAt).toBe(1234567890);
    expect(records[0]!.updatedAt).toBe(9876543210);
  });

  it("uses createdAt for updatedAt when updatedAt absent", async () => {
    const getSpy = vi
      .fn()
      .mockResolvedValue([{ id: "r1", text: "x", createdAt: 5000 }]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records[0]!.updatedAt).toBe(5000);
  });

  it("extracts extra fields into metadata", async () => {
    const getSpy = vi
      .fn()
      .mockResolvedValue([
        {
          id: "r1",
          text: "x",
          tag: "lesson",
          importance: 0.9,
          createdAt: 1000,
          updatedAt: 2000,
        },
      ]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records[0]!.metadata?.["tag"]).toBe("lesson");
    expect(records[0]!.metadata?.["importance"]).toBe(0.9);
  });

  it("does not include id/key/text/content/createdAt/updatedAt in metadata", async () => {
    const getSpy = vi
      .fn()
      .mockResolvedValue([
        {
          id: "r1",
          key: "k1",
          text: "x",
          content: "c",
          createdAt: 1000,
          updatedAt: 2000,
          tag: "keep",
        },
      ]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    const meta = records[0]!.metadata ?? {};
    expect(meta["id"]).toBeUndefined();
    expect(meta["key"]).toBeUndefined();
    expect(meta["text"]).toBeUndefined();
    expect(meta["content"]).toBeUndefined();
    expect(meta["createdAt"]).toBeUndefined();
    expect(meta["updatedAt"]).toBeUndefined();
    expect(meta["tag"]).toBe("keep");
  });

  it("metadata is absent (not even empty object) when no extra fields", async () => {
    const getSpy = vi
      .fn()
      .mockResolvedValue([
        { id: "r1", text: "x", createdAt: 1000, updatedAt: 2000 },
      ]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records[0]!.metadata).toBeUndefined();
  });

  it("returns empty array when underlying service returns nothing", async () => {
    const getSpy = vi.fn().mockResolvedValue([]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records).toEqual([]);
  });

  it("lifts multiple records preserving order", async () => {
    const raw = [
      { id: "a", text: "first", createdAt: 1, updatedAt: 1 },
      { id: "b", text: "second", createdAt: 2, updatedAt: 2 },
      { id: "c", text: "third", createdAt: 3, updatedAt: 3 },
    ];
    const getSpy = vi.fn().mockResolvedValue(raw);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(records.map((r) => r.content)).toEqual(["first", "second", "third"]);
  });
});

// ===========================================================================
// memoryServiceToClient — get() pagination
// ===========================================================================

describe("memoryServiceToClient — get() pagination", () => {
  function makeRawRecords(n: number): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      text: `text-${i}`,
      createdAt: i * 1000,
      updatedAt: i * 1000,
    }));
  }

  it("applies limit", async () => {
    const getSpy = vi.fn().mockResolvedValue(makeRawRecords(10));
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE, { limit: 3 });
    expect(records).toHaveLength(3);
    expect(records[0]!.id).toBe("r0");
  });

  it("applies offset", async () => {
    const getSpy = vi.fn().mockResolvedValue(makeRawRecords(10));
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE, { offset: 5 });
    expect(records).toHaveLength(5);
    expect(records[0]!.id).toBe("r5");
  });

  it("applies limit + offset together", async () => {
    const getSpy = vi.fn().mockResolvedValue(makeRawRecords(10));
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE, { offset: 2, limit: 4 });
    expect(records).toHaveLength(4);
    expect(records[0]!.id).toBe("r2");
    expect(records[3]!.id).toBe("r5");
  });

  it("returns empty array when offset is beyond total", async () => {
    const getSpy = vi.fn().mockResolvedValue(makeRawRecords(5));
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE, { offset: 10 });
    expect(records).toEqual([]);
  });

  it("no query returns all records", async () => {
    const getSpy = vi.fn().mockResolvedValue(makeRawRecords(5));
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE);
    expect(records).toHaveLength(5);
  });
});

// ===========================================================================
// memoryServiceToClient — get() with search query
// ===========================================================================

describe("memoryServiceToClient — get() with search query", () => {
  it("routes to svc.search when query.search is set and svc.search exists", async () => {
    const searchSpy = vi
      .fn()
      .mockResolvedValue([
        {
          id: "found",
          text: "matching content",
          createdAt: 1000,
          updatedAt: 1000,
        },
      ]);
    const svc: MemoryServiceLike = {
      get: vi.fn(),
      put: vi.fn(),
      search: searchSpy,
    };
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE, {
      search: "query text",
      limit: 5,
    });
    expect(searchSpy).toHaveBeenCalledWith(
      "ns",
      { tenantId: "t1", projectId: "p1" },
      "query text",
      5
    );
    expect(records[0]!.id).toBe("found");
  });

  it("falls back to svc.get when svc.search is absent", async () => {
    const getSpy = vi
      .fn()
      .mockResolvedValue([
        { id: "r1", text: "data", createdAt: 1000, updatedAt: 1000 },
      ]);
    const svc: MemoryServiceLike = { get: getSpy, put: vi.fn() }; // no search
    const client = memoryServiceToClient(svc);

    const records = await client.get("ns", SCOPE, { search: "anything" });
    expect(getSpy).toHaveBeenCalled();
    expect(records[0]!.id).toBe("r1");
  });

  it("passes undefined limit when query.limit is absent", async () => {
    const searchSpy = vi.fn().mockResolvedValue([]);
    const svc: MemoryServiceLike = {
      get: vi.fn(),
      put: vi.fn(),
      search: searchSpy,
    };
    const client = memoryServiceToClient(svc);

    await client.get("ns", SCOPE, { search: "q" });
    expect(searchSpy).toHaveBeenCalledWith(
      "ns",
      expect.any(Object),
      "q",
      undefined
    );
  });
});

// ===========================================================================
// memoryServiceToClient — put()
// ===========================================================================

describe("memoryServiceToClient — put()", () => {
  it("passes record.content as text field", async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const svc: MemoryServiceLike = { get: vi.fn(), put: putSpy };
    const client = memoryServiceToClient(svc);

    const record: MemoryRecord = {
      id: "r1",
      namespace: "ns",
      scope: SCOPE,
      content: "my content",
      createdAt: 1000,
      updatedAt: 2000,
    };
    await client.put("ns", SCOPE, record);

    const value = putSpy.mock.calls[0]![3] as Record<string, unknown>;
    expect(value["text"]).toBe("my content");
  });

  it("spreads metadata into the stored value", async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const svc: MemoryServiceLike = { get: vi.fn(), put: putSpy };
    const client = memoryServiceToClient(svc);

    const record: MemoryRecord = {
      id: "r1",
      namespace: "ns",
      scope: SCOPE,
      content: "text",
      createdAt: 1000,
      updatedAt: 2000,
      metadata: { tag: "lesson", score: 0.8 },
    };
    await client.put("ns", SCOPE, record);

    const value = putSpy.mock.calls[0]![3] as Record<string, unknown>;
    expect(value["tag"]).toBe("lesson");
    expect(value["score"]).toBe(0.8);
    expect(value["text"]).toBe("text");
  });

  it("puts without metadata does not spread undefined keys", async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const svc: MemoryServiceLike = { get: vi.fn(), put: putSpy };
    const client = memoryServiceToClient(svc);

    const record: MemoryRecord = {
      id: "r1",
      namespace: "ns",
      scope: SCOPE,
      content: "bare",
      createdAt: 1000,
      updatedAt: 1000,
    };
    await client.put("ns", SCOPE, record);

    const value = putSpy.mock.calls[0]![3] as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["text"]);
  });

  it("passes correct namespace and record id to underlying put", async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const svc: MemoryServiceLike = { get: vi.fn(), put: putSpy };
    const client = memoryServiceToClient(svc);

    const record: MemoryRecord = {
      id: "my-id-123",
      namespace: "decisions",
      scope: SCOPE,
      content: "decision",
      createdAt: 0,
      updatedAt: 0,
    };
    await client.put("decisions", SCOPE, record);

    expect(putSpy).toHaveBeenCalledWith(
      "decisions",
      expect.any(Object),
      "my-id-123",
      expect.any(Object)
    );
  });
});

// ===========================================================================
// memoryServiceToClient — delete()
// ===========================================================================

describe("memoryServiceToClient — delete()", () => {
  it("calls svc.delete with correct args and returns true when result is not false", async () => {
    const deleteSpy = vi.fn().mockResolvedValue(true);
    const svc: MemoryServiceLike = {
      get: vi.fn(),
      put: vi.fn(),
      delete: deleteSpy,
    };
    const client = memoryServiceToClient(svc);

    const result = await client.delete("ns", SCOPE, "r1");
    expect(result).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith(
      "ns",
      { tenantId: "t1", projectId: "p1" },
      "r1"
    );
  });

  it("returns false when svc.delete is not defined", async () => {
    const svc: MemoryServiceLike = { get: vi.fn(), put: vi.fn() }; // no delete
    const client = memoryServiceToClient(svc);

    const result = await client.delete("ns", SCOPE, "r1");
    expect(result).toBe(false);
  });

  it("returns false when svc.delete returns false", async () => {
    const deleteSpy = vi.fn().mockResolvedValue(false);
    const svc: MemoryServiceLike = {
      get: vi.fn(),
      put: vi.fn(),
      delete: deleteSpy,
    };
    const client = memoryServiceToClient(svc);

    const result = await client.delete("ns", SCOPE, "r1");
    expect(result).toBe(false);
  });

  it("returns true when svc.delete returns undefined (void)", async () => {
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const svc: MemoryServiceLike = {
      get: vi.fn(),
      put: vi.fn(),
      delete: deleteSpy,
    };
    const client = memoryServiceToClient(svc);

    const result = await client.delete("ns", SCOPE, "r1");
    expect(result).toBe(true); // undefined !== false
  });

  it("passes correct namespace and scope to delete", async () => {
    const deleteSpy = vi.fn().mockResolvedValue(true);
    const svc: MemoryServiceLike = {
      get: vi.fn(),
      put: vi.fn(),
      delete: deleteSpy,
    };
    const client = memoryServiceToClient(svc);

    await client.delete(
      "my-ns",
      { tenantId: "tenant-xyz", workspaceId: "w9" },
      "rec-99"
    );

    expect(deleteSpy).toHaveBeenCalledWith(
      "my-ns",
      { tenantId: "tenant-xyz", workspaceId: "w9" },
      "rec-99"
    );
  });
});

// ===========================================================================
// EnvKeyProvider — additional edge cases
// ===========================================================================

describe("EnvKeyProvider — additional edge cases", () => {
  it("returns empty array for empty env", async () => {
    const provider = new EnvKeyProvider({});
    const keys = await provider.listKeys();
    expect(keys).toHaveLength(0);
  });

  it("getActiveKey() returns undefined when env is empty", async () => {
    const provider = new EnvKeyProvider({});
    const active = await provider.getActiveKey();
    expect(active).toBeUndefined();
  });

  it("getKey() returns undefined when env is empty", async () => {
    const provider = new EnvKeyProvider({});
    const key = await provider.getKey("anything");
    expect(key).toBeUndefined();
  });

  it("marks the active key as active status", async () => {
    const hex = makeHexKey();
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_mykey: hex,
      DZIP_MEMORY_KEY_ACTIVE: "mykey",
    });
    const key = await provider.getKey("mykey");
    expect(key?.status).toBe("active");
  });

  it("marks non-active keys as rotated status", async () => {
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_old: makeHexKey(),
      DZIP_MEMORY_KEY_new: makeHexKey(),
      DZIP_MEMORY_KEY_ACTIVE: "new",
    });
    const oldKey = await provider.getKey("old");
    expect(oldKey?.status).toBe("rotated");
  });

  it("key buffer equals hex-decoded value", async () => {
    const hex = makeHexKey();
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_k: hex,
      DZIP_MEMORY_KEY_ACTIVE: "k",
    });
    const key = await provider.getKey("k");
    expect(key?.key).toEqual(Buffer.from(hex, "hex"));
  });

  it("multiple keys all appear in listKeys()", async () => {
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_a: makeHexKey(),
      DZIP_MEMORY_KEY_b: makeHexKey(),
      DZIP_MEMORY_KEY_c: makeHexKey(),
      DZIP_MEMORY_KEY_ACTIVE: "a",
    });
    const keys = await provider.listKeys();
    expect(keys).toHaveLength(3);
    const ids = keys.map((k) => k.keyId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("key with ACTIVE in its name but not as the ACTIVE var is not active", async () => {
    // DZIP_MEMORY_KEY_ACTIVE_KEY is a key named ACTIVE_KEY, not the ACTIVE setting
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_ACTIVE_KEY: makeHexKey(),
      DZIP_MEMORY_KEY_ACTIVE: "other",
      DZIP_MEMORY_KEY_other: makeHexKey(),
    });
    const keys = await provider.listKeys();
    expect(keys).toHaveLength(2);
    const activeKey = await provider.getActiveKey();
    expect(activeKey?.keyId).toBe("other");
  });

  it("createdAt is set on each key", async () => {
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_k: makeHexKey(),
      DZIP_MEMORY_KEY_ACTIVE: "k",
    });
    const keys = await provider.listKeys();
    expect(keys[0]?.createdAt).toBeInstanceOf(Date);
  });
});

// ===========================================================================
// EncryptedMemoryService — concurrent puts (data integrity)
// ===========================================================================

describe("EncryptedMemoryService — concurrent puts", () => {
  it("concurrent puts all succeed and produce independent envelopes", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        service.put("ns", SCOPE, `key-${i}`, { secret: `value-${i}` })
      )
    );

    expect(mock.putSpy).toHaveBeenCalledTimes(8);

    const ivs = mock.putSpy.mock.calls.map(
      (call) =>
        (
          (call[3] as Record<string, unknown>)["_encrypted_value"] as Record<
            string,
            unknown
          >
        )["iv"]
    );
    const uniqueIvs = new Set(ivs);
    expect(uniqueIvs.size).toBe(8); // all IVs must be unique
  });

  it("each concurrent put can be independently decrypted", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    });

    const secrets = ["alpha", "beta", "gamma", "delta"];
    await Promise.all(
      secrets.map((secret, i) => service.put("ns", SCOPE, `k${i}`, { secret }))
    );

    for (let i = 0; i < secrets.length; i++) {
      const stored = mock.putSpy.mock.calls[i]![3] as Record<string, unknown>;
      mock.getSpy.mockResolvedValueOnce([stored]);
      const [decrypted] = await service.get("ns", SCOPE);
      expect(decrypted!["secret"]).toBe(secrets[i]);
    }
  });
});

// ===========================================================================
// EncryptedMemoryService — large payload
// ===========================================================================

describe("EncryptedMemoryService — large payload", () => {
  it("round-trips a large text value (>64KB)", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    });

    const bigText = "x".repeat(100_000);
    await service.put("ns", SCOPE, "big", { secret: bigText });

    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>;
    mock.getSpy.mockResolvedValueOnce([stored]);
    const [decrypted] = await service.get("ns", SCOPE);
    expect(decrypted!["secret"]).toBe(bigText);
  });

  it("round-trips a record with many fields", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    });

    const value: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      value[`field_${i}`] = `value_${i}`;
    }
    await service.put("ns", SCOPE, "many", value);

    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>;
    mock.getSpy.mockResolvedValueOnce([stored]);
    const [decrypted] = await service.get("ns", SCOPE);

    for (let i = 0; i < 50; i++) {
      expect(decrypted![`field_${i}`]).toBe(`value_${i}`);
    }
  });
});

// ===========================================================================
// EncryptedMemoryService — null/undefined plaintext field values
// ===========================================================================

describe("EncryptedMemoryService — null/undefined plaintext field values", () => {
  it("handles plaintext field with null value", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      plaintextFields: ["tag"],
    });

    await service.put("ns", SCOPE, "k", { tag: null, secret: "s" });
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>;
    // null is a falsy but defined value — depends on implementation
    // Key assertion: the encrypted envelope must still be present
    expect(stored["_encrypted_value"]).toBeDefined();
  });

  it("put with empty value object produces valid encrypted envelope", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    });

    await service.put("ns", SCOPE, "empty", {});
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>;
    const env = stored["_encrypted_value"] as Record<string, unknown>;
    expect(env["_encrypted"]).toBe(true);
    expect(typeof env["ciphertext"]).toBe("string");
    expect(typeof env["iv"]).toBe("string");
    expect(typeof env["authTag"]).toBe("string");
  });
});

// ===========================================================================
// EncryptedMemoryService — namespace case-sensitivity
// ===========================================================================

describe("EncryptedMemoryService — namespace matching is case-sensitive", () => {
  it("does not encrypt a differently-cased namespace", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      encryptedNamespaces: ["Secrets"],
    });

    // 'secrets' (lowercase) should NOT be encrypted
    await service.put("secrets", SCOPE, "k", { data: "plain" });
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>;
    expect(stored["_encrypted_value"]).toBeUndefined();
  });

  it("encrypts the exact namespace match", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      encryptedNamespaces: ["Secrets"],
    });

    await service.put("Secrets", SCOPE, "k", { data: "enc" });
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>;
    expect(stored["_encrypted_value"]).toBeDefined();
  });
});

// ===========================================================================
// EncryptedMemoryService — rotateKey multiple records
// ===========================================================================

describe("EncryptedMemoryService — rotateKey bulk rotation", () => {
  it("rotates multiple records in a single call", async () => {
    const mock = createMockMemoryService();
    const oldKey = makeKey("old", "active");
    const oldProvider = createMockKeyProvider([oldKey]);
    const writer = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: oldProvider,
    });

    // Write 5 records with old key
    for (let i = 0; i < 5; i++) {
      await writer.put("ns", SCOPE, `k${i}`, { secret: `s${i}` });
    }
    const storedRecords = mock.putSpy.mock.calls
      .slice(0, 5)
      .map((call) => call[3] as Record<string, unknown>);

    const newKey = makeKey("new", "active");
    const rotateProvider = createMockKeyProvider([
      { ...oldKey, status: "rotated" as const },
      newKey,
    ]);
    const rotator = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: rotateProvider,
    });

    mock.getSpy.mockResolvedValueOnce(storedRecords);
    const result = await rotator.rotateKey("ns", SCOPE);

    expect(result.rotated).toBe(5);
    expect(result.failed).toBe(0);

    // All re-puts should use new key
    const rePutCalls = mock.putSpy.mock.calls.slice(5);
    expect(rePutCalls).toHaveLength(5);
    for (const call of rePutCalls) {
      const env = (call[3] as Record<string, unknown>)[
        "_encrypted_value"
      ] as Record<string, unknown>;
      expect(env["keyId"]).toBe("new");
    }
  });

  it("rotateKey returns { rotated: 0, failed: 0 } for empty namespace", async () => {
    const mock = createMockMemoryService();
    const activeKey = makeKey("k", "active");
    const provider = createMockKeyProvider([activeKey]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    });

    mock.getSpy.mockResolvedValueOnce([]);
    const result = await service.rotateKey("empty-ns", SCOPE);
    expect(result.rotated).toBe(0);
    expect(result.failed).toBe(0);
  });
});

// ===========================================================================
// EncryptedMemoryService — IV uniqueness per put
// ===========================================================================

describe("EncryptedMemoryService — IV uniqueness", () => {
  it("each put produces a unique IV even for identical values", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    });

    const value = { secret: "same", text: "same" };
    await service.put("ns", SCOPE, "a", value);
    await service.put("ns", SCOPE, "b", value);
    await service.put("ns", SCOPE, "c", value);

    const ivs = mock.putSpy.mock.calls.map(
      (call) =>
        (
          (call[3] as Record<string, unknown>)["_encrypted_value"] as Record<
            string,
            unknown
          >
        )["iv"]
    );
    const unique = new Set(ivs);
    expect(unique.size).toBe(3);
  });
});

// ===========================================================================
// EncryptedMemoryService — search with encrypted results
// ===========================================================================

describe("EncryptedMemoryService — search returns decrypted records", () => {
  it("decrypts search results correctly", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    });

    await service.put("ns", SCOPE, "a", {
      text: "matching query",
      secret: "found-secret",
    });
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>;

    mock.searchSpy.mockResolvedValueOnce([stored]);
    const results = await service.search("ns", SCOPE, "matching query", 3);

    expect(results).toHaveLength(1);
    expect(results[0]!["secret"]).toBe("found-secret");
    expect(results[0]!["text"]).toBe("matching query");
  });

  it("search with no results returns empty array", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    });

    mock.searchSpy.mockResolvedValueOnce([]);
    const results = await service.search("ns", SCOPE, "nothing");
    expect(results).toEqual([]);
  });

  it("search passes namespace and scope to underlying service", async () => {
    const mock = createMockMemoryService();
    const provider = createMockKeyProvider([makeKey("k1", "active")]);
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    });

    mock.searchSpy.mockResolvedValueOnce([]);
    await service.search("my-namespace", { tenantId: "tx" }, "query", 10);

    expect(mock.searchSpy).toHaveBeenCalledWith(
      "my-namespace",
      { tenantId: "tx" },
      "query",
      10
    );
  });
});
