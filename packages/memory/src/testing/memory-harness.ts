/**
 * Stateful test harness for `MemoryService`.
 *
 * ## Why this exists
 *
 * A survey of this repo found ~69 test files building memory doubles out of
 * bare spies:
 *
 * ```ts
 * const memory = { put: vi.fn(), get: vi.fn().mockResolvedValue([]) }
 * ```
 *
 * A spy holds no state. It can observe *that* `put` was called, never *what
 * the namespace now contains*. That blind spot hid an entire class of defects
 * in which an operation reported success while the store was untouched — for
 * example a retention pass that reported `{ pruned: 2 }` while every original
 * record survived and the namespace grew on each sweep.
 *
 * The fix is not a hand-written fake: a second implementation of the
 * `MemoryService` contract would drift from the real one, and any defect
 * living in the real read path would be invisible in the fake. Instead this
 * builds the **real** `MemoryService` over LangGraph's in-process
 * `InMemoryStore`, so reads, writes, deletes, and key handling all execute
 * production code paths.
 *
 * ## What it gives you over `new MemoryService(new InMemoryStore(), ...)`
 *
 * Namespace boilerplate collapses to a name, and — the part that matters —
 * you get {@link MemoryHarness.snapshot}, a direct keyed view of the store
 * that is independent of the code under test. Assert against the snapshot,
 * not against a spy's call log, and a lying return value cannot pass.
 *
 * @example Catching a report that does not match reality
 * ```ts
 * const h = createMemoryHarness({ namespace: 'space:s1', scope: { spaceId: 's1' } })
 * await h.seed({ a: { text: 'a' }, b: { text: 'b' } })
 *
 * const result = await enforceRetentionForSpace(h.memory, space)
 *
 * // A spy-based double stops at this line. It is the weaker assertion:
 * expect(result.pruned).toBe(2)
 * // This is the one that catches the defect:
 * expect(await h.liveKeys()).toEqual([])
 * ```
 */

import { InMemoryStore } from "@langchain/langgraph";
import type { BaseStore } from "@langchain/langgraph";
import { MemoryService } from "../memory-service.js";
import type { KeyedMemoryRecord } from "../memory-service-store.js";
import type { NamespaceConfig } from "../memory-types.js";
import type { MemoryServiceOptions } from "../memory-service-types.js";
import {
  attachMemoryStoreCapabilities,
  type MemoryStoreCapabilities,
} from "../store-capabilities.js";

/** Options for {@link createMemoryHarness}. */
export interface MemoryHarnessOptions {
  /**
   * Primary namespace name. Defaults to `'facts'`.
   *
   * A namespace is registered for every key of {@link scope} so the default
   * scope validates without extra configuration.
   */
  namespace?: string;
  /** Scope for the primary namespace. Defaults to `{ tenantId: 't1' }`. */
  scope?: Record<string, string>;
  /**
   * Additional namespaces to register, for tests that move records between
   * namespaces. Each entry may be a bare name or a full config.
   */
  extraNamespaces?: Array<string | NamespaceConfig>;
  /** Marks the primary namespace searchable. Defaults to `false`. */
  searchable?: boolean;
  /**
   * Options forwarded to the `MemoryService` constructor.
   *
   * `rejectUnsafe` defaults to `false` here — the sanitizer silently drops
   * values it considers unsafe, which in a test reads as a mysteriously empty
   * namespace. Pass `{ rejectUnsafe: true }` when sanitizing is under test.
   */
  serviceOptions?: MemoryServiceOptions;
  /**
   * Backing store. Defaults to a fresh `InMemoryStore`. Supply a real store
   * to run the same assertions against production persistence.
   */
  store?: BaseStore;
  /**
   * Capabilities to advertise on the store, e.g. `{ supportsDelete: false }`
   * to exercise the tombstone fallback that delete-incapable backends take.
   *
   * Capabilities are read from a `capabilities` property, not inferred from
   * which methods exist, and `MemoryService` snapshots them in its
   * constructor — so deleting `store.delete` after the fact has no effect.
   * This is the supported way to get a delete-incapable store.
   */
  capabilities?: Partial<MemoryStoreCapabilities>;
}

/** A stateful memory fixture wrapping a real `MemoryService`. */
export interface MemoryHarness {
  /** The real service under test. Pass this wherever a `MemoryService` is expected. */
  memory: MemoryService;
  /** The backing store, for assertions that need to bypass the service. */
  store: BaseStore;
  /** Primary namespace name. */
  namespace: string;
  /** Primary scope. */
  scope: Record<string, string>;

  /**
   * Write records in one call, keyed by store key.
   *
   * @returns the keys written, in insertion order.
   */
  seed(
    records: Record<string, Record<string, unknown>>,
    opts?: { namespace?: string; scope?: Record<string, string> }
  ): Promise<string[]>;

  /**
   * Every record in the namespace paired with its real store key.
   *
   * This is the assertion surface a spy cannot provide: it reflects what the
   * store actually holds, not what the code under test claims it did.
   */
  snapshot(opts?: {
    namespace?: string;
    scope?: Record<string, string>;
  }): Promise<KeyedMemoryRecord[]>;

  /** Store keys currently present, sorted for stable comparison. */
  keys(opts?: {
    namespace?: string;
    scope?: Record<string, string>;
  }): Promise<string[]>;

  /**
   * Keys of non-tombstone records, sorted.
   *
   * Retention marks records by overwriting them with a tombstone rather than
   * deleting, so `keys()` alone cannot distinguish "pruned" from "present".
   */
  liveKeys(opts?: {
    namespace?: string;
    scope?: Record<string, string>;
  }): Promise<string[]>;

  /** Keys of tombstone records, sorted. */
  tombstoneKeys(opts?: {
    namespace?: string;
    scope?: Record<string, string>;
  }): Promise<string[]>;

  /** Total record count, tombstones included. */
  size(opts?: {
    namespace?: string;
    scope?: Record<string, string>;
  }): Promise<number>;
}

/** Records written by retention carry this marker. */
function isTombstone(value: Record<string, unknown>): boolean {
  return value["_tombstone"] === true;
}

/** Build a `NamespaceConfig` from a bare name, scoping it to `scopeKeys`. */
function toNamespaceConfig(
  entry: string | NamespaceConfig,
  scopeKeys: string[],
  searchable: boolean
): NamespaceConfig {
  if (typeof entry !== "string") return entry;
  return { name: entry, scopeKeys, searchable };
}

/**
 * Create a stateful memory fixture backed by a real `MemoryService`.
 *
 * Every operation runs production code, so defects in the service's own read
 * or write path surface here instead of being masked by a stand-in.
 */
export function createMemoryHarness(
  options: MemoryHarnessOptions = {}
): MemoryHarness {
  const namespace = options.namespace ?? "facts";
  const scope = options.scope ?? { tenantId: "t1" };
  const searchable = options.searchable ?? false;
  const scopeKeys = Object.keys(scope);

  const namespaces: NamespaceConfig[] = [
    { name: namespace, scopeKeys, searchable },
    ...(options.extraNamespaces ?? []).map((e) =>
      toNamespaceConfig(e, scopeKeys, false)
    ),
  ];

  const baseStore = options.store ?? new InMemoryStore();
  const store = options.capabilities
    ? attachMemoryStoreCapabilities(baseStore, options.capabilities)
    : baseStore;
  const memory = new MemoryService(store, namespaces, {
    // Default off: the sanitizer drops unsafe values silently, which in a test
    // is indistinguishable from a write that never happened.
    rejectUnsafe: false,
    ...options.serviceOptions,
  });

  const ns = (o?: { namespace?: string }) => o?.namespace ?? namespace;
  const sc = (o?: { scope?: Record<string, string> }) => o?.scope ?? scope;

  const snapshot: MemoryHarness["snapshot"] = async (o) =>
    memory.getKeyed(ns(o), sc(o));

  return {
    memory,
    store,
    namespace,
    scope,

    async seed(records, o) {
      const written: string[] = [];
      for (const [key, value] of Object.entries(records)) {
        await memory.put(ns(o), sc(o), key, value);
        written.push(key);
      }
      return written;
    },

    snapshot,

    async keys(o) {
      return (await snapshot(o)).map((r) => r.key).sort();
    },

    async liveKeys(o) {
      return (await snapshot(o))
        .filter((r) => !isTombstone(r.value))
        .map((r) => r.key)
        .sort();
    },

    async tombstoneKeys(o) {
      return (await snapshot(o))
        .filter((r) => isTombstone(r.value))
        .map((r) => r.key)
        .sort();
    },

    async size(o) {
      return (await snapshot(o)).length;
    },
  };
}
