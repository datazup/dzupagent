/**
 * Real coverage for the AgentFile export/import round-trip.
 *
 * Replaces a ~65-row tautological suite (removed 2026-07-27) that imported
 * nothing but vitest and asserted on values it had itself constructed. Every
 * test here drives the production `AgentFileExporter` / `AgentFileImporter`
 * through a `MemoryService` backed by a namespace-aware fake store, so a
 * behavioral change in either class fails a test.
 *
 * The fake store keys on the full namespace tuple (not the bare key) so
 * cross-namespace bleed is a detectable failure rather than a silent pass.
 */
import { describe, it, expect, vi } from "vitest";
import type { BaseStore } from "@langchain/langgraph";
import { MemoryService } from "../memory-service.js";
import type { NamespaceConfig } from "../memory-types.js";
import { AgentFileExporter } from "../agent-file/exporter.js";
import { AgentFileImporter } from "../agent-file/importer.js";
import type { AgentFile } from "../agent-file/types.js";
import { AGENT_FILE_SCHEMA, AGENT_FILE_VERSION } from "../agent-file/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Namespace-aware in-memory store. Unlike the flat fixture used elsewhere in
 * this package, entries are keyed by `tuple.join('/') + '::' + key`, so a
 * record written to one namespace can never be read back from another.
 */
function makeStore(): { store: BaseStore; size: () => number } {
  const data = new Map<string, Record<string, unknown>>();
  const id = (ns: string[], key: string): string => `${ns.join("/")}::${key}`;

  const store = {
    put: vi.fn(
      async (ns: string[], key: string, value: Record<string, unknown>) => {
        data.set(id(ns, key), value);
      }
    ),
    get: vi.fn(async (ns: string[], key: string) => {
      const value = data.get(id(ns, key));
      return value ? { key, value } : undefined;
    }),
    search: vi.fn(async (ns: string[], opts?: { limit?: number }) => {
      const prefix = `${ns.join("/")}::`;
      const items = [...data.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, value]) => ({ key: k.slice(prefix.length), value }));
      return opts?.limit !== undefined ? items.slice(0, opts.limit) : items;
    }),
    delete: vi.fn(async (ns: string[], key: string) => {
      data.delete(id(ns, key));
    }),
  } as unknown as BaseStore;

  return { store, size: () => data.size };
}

/**
 * `buildNamespaceTuple` maps `scopeKeys` through the scope object and returns
 * only the resolved VALUES — the namespace `name` is never part of the tuple.
 * Namespaces must therefore be separated by a discriminator scope key, or they
 * collapse onto the same store bucket and read each other's records back.
 */
const NS_CONFIGS: NamespaceConfig[] = [
  { name: "lessons", scopeKeys: ["tenantId", "lessons"], searchable: false },
  {
    name: "decisions",
    scopeKeys: ["tenantId", "decisions"],
    searchable: false,
  },
  {
    name: "__internal",
    scopeKeys: ["tenantId", "__internal"],
    searchable: false,
  },
];

const SCOPE = {
  tenantId: "t1",
  lessons: "lessons",
  decisions: "decisions",
  __internal: "__internal",
};

function makeService(): { svc: MemoryService; size: () => number } {
  const { store, size } = makeStore();
  // rejectUnsafe:false — these fixtures are benign, and the safety filter is
  // covered by memory-service.test.ts. Leaving it on would silently drop puts.
  return {
    svc: new MemoryService(store, NS_CONFIGS, { rejectUnsafe: false }),
    size,
  };
}

function makeExporter(svc: MemoryService): AgentFileExporter {
  return new AgentFileExporter({
    memoryService: svc,
    agentName: "planner",
    agentUri: "forge://acme/planner",
    scope: SCOPE,
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("AgentFileExporter", () => {
  it("exports records that were actually written to the service", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { text: "always vendor dist" });
    await svc.put("decisions", SCOPE, "d1", { text: "use postgres" });

    const file = await makeExporter(svc).export();

    expect(Object.keys(file.memory.namespaces).sort()).toEqual([
      "decisions",
      "lessons",
    ]);
    expect(file.memory.namespaces["lessons"]).toHaveLength(1);
    expect(file.memory.namespaces["lessons"]?.[0]?.value).toMatchObject({
      text: "always vendor dist",
    });
    expect(file.exportedBy).toBe("forge://acme/planner");
    expect(file.agent.name).toBe("planner");
    expect(file.$schema).toBe(AGENT_FILE_SCHEMA);
    expect(file.version).toBe(AGENT_FILE_VERSION);
  });

  it("omits namespaces prefixed with __ unless explicitly requested", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { text: "keep" });
    await svc.put("__internal", SCOPE, "i1", { text: "hide" });

    const auto = await makeExporter(svc).export();
    expect(auto.memory.namespaces["__internal"]).toBeUndefined();
    expect(auto.memory.namespaces["lessons"]).toBeDefined();

    // Explicit request overrides the default filter.
    const explicit = await makeExporter(svc).export({
      namespaces: ["__internal"],
    });
    expect(explicit.memory.namespaces["__internal"]).toHaveLength(1);
    expect(explicit.memory.namespaces["lessons"]).toBeUndefined();
  });

  it("drops empty namespaces from the export entirely", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { text: "only lessons" });

    const file = await makeExporter(svc).export();

    // 'decisions' is configured but has no records — it must not appear as an
    // empty array, which would make importers iterate a phantom namespace.
    expect(file.memory.namespaces).not.toHaveProperty("decisions");
  });

  it("signs by default and omits the signature when sign:false", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { text: "x" });

    const signed = await makeExporter(svc).export();
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);

    const unsigned = await makeExporter(svc).export({ sign: false });
    expect(unsigned.signature).toBeUndefined();
  });

  it("produces a key-order-independent signature", async () => {
    // Two services holding the same logical record, written with object keys
    // in opposite orders. The canonical (sorted-key) hash must agree.
    const a = makeService();
    await a.svc.put("lessons", SCOPE, "l1", { alpha: 1, beta: 2 });
    const b = makeService();
    await b.svc.put("lessons", SCOPE, "l1", { beta: 2, alpha: 1 });

    const fileA = await makeExporter(a.svc).export();
    const fileB = await makeExporter(b.svc).export();

    expect(fileA.signature).toBe(fileB.signature);
  });

  it("changes the signature when exported content changes", async () => {
    const a = makeService();
    await a.svc.put("lessons", SCOPE, "l1", { text: "original" });
    const b = makeService();
    await b.svc.put("lessons", SCOPE, "l1", { text: "tampered" });

    const fileA = await makeExporter(a.svc).export();
    const fileB = await makeExporter(b.svc).export();

    expect(fileA.signature).not.toBe(fileB.signature);
  });
});

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

describe("AgentFileImporter.validate", () => {
  function importerFor(svc: MemoryService): AgentFileImporter {
    return new AgentFileImporter(svc, SCOPE);
  }

  it("accepts a file produced by the exporter", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { text: "round trip" });
    const file = await makeExporter(svc).export();

    // Through JSON, as a real consumer would receive it.
    const parsed: unknown = JSON.parse(JSON.stringify(file));
    const { valid, errors } = importerFor(svc).validate(parsed);

    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "not-a-file"],
    ["a number", 42],
  ])("rejects %s as a non-object", (_label, input) => {
    const { svc } = makeService();
    const { valid, errors } = importerFor(svc).validate(input);
    expect(valid).toBe(false);
    expect(errors).toContain("AgentFile must be a non-null object");
  });

  it("reports every missing required field at once", () => {
    const { svc } = makeService();
    const { valid, errors } = importerFor(svc).validate({});

    expect(valid).toBe(false);
    // Callers rely on seeing all problems in one pass, not just the first.
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.some((e) => e.includes("$schema"))).toBe(true);
    expect(errors.some((e) => e.includes("version"))).toBe(true);
    expect(errors.some((e) => e.includes("exportedAt"))).toBe(true);
    expect(errors.some((e) => e.includes("exportedBy"))).toBe(true);
    expect(errors.some((e) => e.includes("agent"))).toBe(true);
    expect(errors.some((e) => e.includes("memory"))).toBe(true);
  });

  it("rejects an unsupported version", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { text: "x" });
    const file = await makeExporter(svc).export();

    const bumped = { ...file, version: "2.0.0" };
    const { valid, errors } = importerFor(svc).validate(bumped);

    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("Unsupported version"))).toBe(true);
  });

  it("detects tampering with signed content", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { text: "original" });
    const file = await makeExporter(svc).export();

    const tampered: AgentFile = JSON.parse(JSON.stringify(file)) as AgentFile;
    tampered.memory.namespaces["lessons"]![0]!.value = { text: "tampered" };

    const { valid, errors } = importerFor(svc).validate(tampered);

    expect(valid).toBe(false);
    expect(
      errors.some((e) => e.includes("Signature verification failed"))
    ).toBe(true);
  });

  it("does not attempt signature checks on an unsigned file", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { text: "original" });
    const file = await makeExporter(svc).export({ sign: false });

    // Mutating an unsigned file is not tampering — there is nothing to verify.
    const mutated: AgentFile = JSON.parse(JSON.stringify(file)) as AgentFile;
    mutated.memory.namespaces["lessons"]![0]!.value = { text: "changed" };

    expect(importerFor(svc).validate(mutated).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

describe("AgentFileImporter.import", () => {
  /**
   * Export from a source service, then import into a fresh target service.
   *
   * Seeds carry an explicit `_key` because `MemoryService.put()` does NOT
   * persist the store key into the record value — see the
   * "key preservation" suite below for the defect this works around.
   */
  async function transfer(
    seed: (svc: MemoryService) => Promise<void>
  ): Promise<{ file: AgentFile; target: MemoryService }> {
    const source = makeService();
    await seed(source.svc);
    const file = await makeExporter(source.svc).export();
    const target = makeService();
    return { file, target: target.svc };
  }

  it("round-trips records into an empty target", async () => {
    const { file, target } = await transfer(async (svc) => {
      await svc.put("lessons", SCOPE, "l1", {
        _key: "l1",
        text: "always vendor dist",
      });
      await svc.put("decisions", SCOPE, "d1", {
        _key: "d1",
        text: "use postgres",
      });
    });

    const result = await new AgentFileImporter(target, SCOPE).import(file, {
      conflictStrategy: "skip",
    });

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const lessons = await target.get("lessons", SCOPE, "l1");
    expect(lessons[0]).toMatchObject({ text: "always vendor dist" });
  });

  it("stamps imported records with imported provenance", async () => {
    const { file, target } = await transfer(async (svc) => {
      await svc.put("lessons", SCOPE, "l1", { _key: "l1", text: "x" });
    });

    await new AgentFileImporter(target, SCOPE).import(file, {
      conflictStrategy: "overwrite",
    });

    const [record] = await target.get("lessons", SCOPE, "l1");
    expect(record?.["_provenance"]).toMatchObject({ source: "imported" });
  });

  it("skip leaves an existing record untouched", async () => {
    const { file, target } = await transfer(async (svc) => {
      await svc.put("lessons", SCOPE, "l1", { _key: "l1", text: "incoming" });
    });
    await target.put("lessons", SCOPE, "l1", { _key: "l1", text: "local" });

    const result = await new AgentFileImporter(target, SCOPE).import(file, {
      conflictStrategy: "skip",
    });

    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
    const [record] = await target.get("lessons", SCOPE, "l1");
    expect(record).toMatchObject({ text: "local" });
  });

  it("overwrite replaces the existing record and drops local-only keys", async () => {
    const { file, target } = await transfer(async (svc) => {
      await svc.put("lessons", SCOPE, "l1", { _key: "l1", text: "incoming" });
    });
    await target.put("lessons", SCOPE, "l1", {
      _key: "l1",
      text: "local",
      localOnly: true,
    });

    const result = await new AgentFileImporter(target, SCOPE).import(file, {
      conflictStrategy: "overwrite",
    });

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    const [record] = await target.get("lessons", SCOPE, "l1");
    expect(record).toMatchObject({ text: "incoming" });
    expect(record).not.toHaveProperty("localOnly");
  });

  it("merge keeps local-only keys and lets incoming values win", async () => {
    const { file, target } = await transfer(async (svc) => {
      await svc.put("lessons", SCOPE, "l1", {
        _key: "l1",
        text: "incoming",
        nested: { b: 2 },
      });
    });
    await target.put("lessons", SCOPE, "l1", {
      _key: "l1",
      text: "local",
      localOnly: true,
      nested: { a: 1 },
    });

    const result = await new AgentFileImporter(target, SCOPE).import(file, {
      conflictStrategy: "merge",
    });

    expect(result.imported).toBe(1);
    const [record] = await target.get("lessons", SCOPE, "l1");
    expect(record).toMatchObject({
      text: "incoming", // incoming wins on conflict
      localOnly: true, // local-only survives
      nested: { a: 1, b: 2 }, // objects merge recursively
    });
  });

  it("defaults to the skip strategy when none is supplied", async () => {
    const { file, target } = await transfer(async (svc) => {
      await svc.put("lessons", SCOPE, "l1", { _key: "l1", text: "incoming" });
    });
    await target.put("lessons", SCOPE, "l1", { _key: "l1", text: "local" });

    const result = await new AgentFileImporter(target, SCOPE).import(file);

    expect(result.skipped).toBe(1);
    const [record] = await target.get("lessons", SCOPE, "l1");
    expect(record).toMatchObject({ text: "local" });
  });

  it("honours the namespace filter", async () => {
    const { file, target } = await transfer(async (svc) => {
      await svc.put("lessons", SCOPE, "l1", { text: "lesson" });
      await svc.put("decisions", SCOPE, "d1", { text: "decision" });
    });

    const result = await new AgentFileImporter(target, SCOPE).import(file, {
      conflictStrategy: "overwrite",
      namespaces: ["lessons"],
    });

    expect(result.imported).toBe(1);
    expect(await target.get("decisions", SCOPE, "d1")).toEqual([]);
  });

  it("aborts without writing when signature verification fails", async () => {
    const { file, target } = await transfer(async (svc) => {
      await svc.put("lessons", SCOPE, "l1", { text: "original" });
    });

    const tampered: AgentFile = JSON.parse(JSON.stringify(file)) as AgentFile;
    tampered.memory.namespaces["lessons"]![0]!.value = { text: "malicious" };

    const result = await new AgentFileImporter(target, SCOPE).import(tampered, {
      conflictStrategy: "overwrite",
      verifySignature: true,
    });

    expect(result.imported).toBe(0);
    expect(result.warnings.some((w) => w.includes("import aborted"))).toBe(
      true
    );
    // Nothing reached the store.
    expect(await target.get("lessons", SCOPE, "l1")).toEqual([]);
  });

  it("imports tampered content when verification is not requested", async () => {
    const { file, target } = await transfer(async (svc) => {
      await svc.put("lessons", SCOPE, "l1", { text: "original" });
    });

    const tampered: AgentFile = JSON.parse(JSON.stringify(file)) as AgentFile;
    tampered.memory.namespaces["lessons"]![0]!.value = { text: "malicious" };

    // verifySignature defaults to false — the caller is expected to have run
    // validate() first. This documents that import() is not fail-safe alone.
    const result = await new AgentFileImporter(target, SCOPE).import(tampered, {
      conflictStrategy: "overwrite",
    });

    expect(result.imported).toBe(1);
  });

  it("counts a failed record without aborting the rest of the batch", async () => {
    const { file, target } = await transfer(async (svc) => {
      await svc.put("lessons", SCOPE, "l1", { text: "first" });
      await svc.put("decisions", SCOPE, "d1", { text: "second" });
    });

    // Make writes to 'lessons' throw, leaving 'decisions' healthy.
    const realPut = target.put.bind(target);
    vi.spyOn(target, "put").mockImplementation(
      async (ns, scope, key, value) => {
        if (ns === "lessons") throw new Error("store offline");
        return realPut(ns, scope, key, value);
      }
    );

    const result = await new AgentFileImporter(target, SCOPE).import(file, {
      conflictStrategy: "overwrite",
    });

    expect(result.failed).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.warnings.some((w) => w.includes("lessons"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Key preservation
  // -------------------------------------------------------------------------
  //
  // `MemoryService.put(ns, scope, key, value)` passes `key` to the backing
  // store but never writes it into the value, and `MemoryService.get()`
  // returns bare values without their keys. The exporter therefore used to
  // fall back to a positional `record-<n>`, which renamed every record on
  // export: conflict detection ('skip'/'merge') could never match an existing
  // record, so a re-import duplicated instead of merging.
  //
  // The exporter now reads through `MemoryService.getKeyed()`, which pairs
  // each record with the store key it was written under. Values are returned
  // verbatim — no `_key` is injected — so export signatures still hash exactly
  // the bytes the caller stored.

  it("exports the store key for records written without _key", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { text: "no _key written" });

    const file = await makeExporter(svc).export();
    const record = file.memory.namespaces["lessons"]?.[0];

    expect(record?.key).toBe("l1");
  });

  it("does not inject _key into the exported value", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { text: "no _key written" });

    const file = await makeExporter(svc).export();

    // The key travels in the envelope, not the payload — injecting it would
    // change what the signature is computed over.
    expect(file.memory.namespaces["lessons"]?.[0]?.value).not.toHaveProperty(
      "_key"
    );
  });

  it("re-importing a keyless export matches instead of duplicating", async () => {
    const source = makeService();
    await source.svc.put("lessons", SCOPE, "l1", { text: "original" });
    const file = await makeExporter(source.svc).export();

    // Import back into the SAME service under 'skip'. The key-preserving
    // export lets the importer recognise the record that is already there.
    const result = await new AgentFileImporter(source.svc, SCOPE).import(file, {
      conflictStrategy: "skip",
    });

    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
    // No positional alias was ever created.
    expect(await source.svc.get("lessons", SCOPE, "record-0")).toHaveLength(0);
    expect(await source.svc.get("lessons", SCOPE, "l1")).toHaveLength(1);
  });

  it("preserves the caller key when the record carries _key", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "l1", { _key: "l1", text: "explicit" });

    const file = await makeExporter(svc).export();

    expect(file.memory.namespaces["lessons"]?.[0]?.key).toBe("l1");
  });

  it("an explicit _key still wins over the store key", async () => {
    const { svc } = makeService();
    // Stored under "s1" but carrying its own identity "canonical" — e.g. a
    // record that arrived through a previous import.
    await svc.put("lessons", SCOPE, "s1", {
      _key: "canonical",
      text: "explicit",
    });

    const file = await makeExporter(svc).export();

    expect(file.memory.namespaces["lessons"]?.[0]?.key).toBe("canonical");
  });

  it("keeps distinct keys for multiple records in one namespace", async () => {
    const { svc } = makeService();
    await svc.put("lessons", SCOPE, "alpha", { text: "a" });
    await svc.put("lessons", SCOPE, "beta", { text: "b" });

    const file = await makeExporter(svc).export();
    const keys = (file.memory.namespaces["lessons"] ?? [])
      .map((r) => r.key)
      .sort();

    expect(keys).toEqual(["alpha", "beta"]);
  });

  it("reports zero counts for a file with no namespaces", async () => {
    const { target } = await transfer(async () => {});
    const empty: AgentFile = {
      $schema: AGENT_FILE_SCHEMA,
      version: AGENT_FILE_VERSION,
      exportedAt: "2026-07-27T00:00:00.000Z",
      exportedBy: "forge://acme/planner",
      agent: { name: "planner" },
      memory: { namespaces: {} },
    };

    const result = await new AgentFileImporter(target, SCOPE).import(empty, {
      conflictStrategy: "skip",
    });

    expect(result).toMatchObject({ imported: 0, skipped: 0, failed: 0 });
  });
});
