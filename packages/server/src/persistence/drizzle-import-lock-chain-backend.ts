/**
 * ADR-0001 C2 — a SQL {@link V2ImportLockChainBackend}.
 *
 * `@dzupagent/flow-dsl` defines the storage contract for import-lock revision
 * chains but deliberately implements none of it: a package that reads files
 * cannot run everywhere the DSL is lowered. The filesystem backend in
 * `@dzupagent/flow-compiler` was the first implementation of that contract.
 * This is the second, and it exists as much to *test the abstraction* as to
 * store rows — an interface with a single implementation has not yet been shown
 * to be an abstraction at all, only a file API with extra steps.
 *
 * It earns that by differing from the filesystem backend on every axis the
 * contract leaves free:
 *
 *  - **Atomicity comes from the engine, not a dance.** The file backend needs
 *    write-temp → fsync → rename to avoid a torn document. Here a single
 *    `INSERT ... ON CONFLICT DO UPDATE` is atomic by definition, so the
 *    durability concern the file backend spends most of its code on simply does
 *    not appear.
 *  - **The flow id is used verbatim.** The file backend must hash the id to
 *    stop `../../etc/whatever` escaping its root. A bound SQL parameter has no
 *    traversal semantics, so the natural key is both safe and readable — the
 *    hashing there is a property of paths, not of the contract.
 *  - **Storage is shared, not process-local.** Multiple processes can back
 *    their chains onto one database, which is the case the durable store's
 *    "re-read the head per call" rule was written for.
 *
 * What it does *not* do is just as deliberate: it validates nothing about the
 * payload. All integrity rules live in `DurableV2ImportLockChainStore`, which
 * refuses bad data on the way in and re-verifies it on the way out. The backend
 * owes the store exactly last-write-wins semantics per flow id, and treats the
 * document as opaque bytes.
 */
import { eq } from "drizzle-orm";
import type { V2ImportLockChainBackend } from "@dzupagent/flow-dsl";
import { flowImportLockChains } from "./drizzle-schema.js";
import type { DrizzleStoreDatabase } from "./drizzle-store-types.js";

export interface DrizzleV2ImportLockChainBackendOptions {
  /**
   * Epoch-millisecond clock for the row's audit timestamps.
   *
   * Injected rather than read from `Date.now()` so tests can assert on written
   * values. These columns are observability metadata only — no part of the
   * chain contract depends on them, so a wrong clock cannot corrupt lineage.
   */
  readonly now?: () => number;
}

/** Row shape matching {@link flowImportLockChains}. */
interface ImportLockChainRow {
  flowId: string;
  document: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Drizzle/Postgres {@link V2ImportLockChainBackend} over
 * `flow_import_lock_chains`.
 *
 * Pair with `DurableV2ImportLockChainStore` from `@dzupagent/flow-dsl`:
 *
 * ```ts
 * const store = new DurableV2ImportLockChainStore(
 *   new DrizzleV2ImportLockChainBackend(db)
 * );
 * ```
 */
export class DrizzleV2ImportLockChainBackend
  implements V2ImportLockChainBackend
{
  private readonly now: () => number;

  constructor(
    private readonly db: DrizzleStoreDatabase,
    options: DrizzleV2ImportLockChainBackendOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  async read(flowId: string): Promise<string | undefined> {
    const rows = (await this.db
      .select()
      .from(flowImportLockChains)
      .where(eq(flowImportLockChains.flowId, flowId))) as ImportLockChainRow[];

    // A flow with no chain yet is the ordinary first-run case, not a fault.
    // `undefined` is what the contract specifies for it, and the store reads
    // that as "root a new chain".
    return rows[0]?.document;
  }

  async write(flowId: string, serialized: string): Promise<void> {
    const now = this.now();

    // Upsert rather than delete+insert: the contract is last-write-wins per
    // flow id, and a single statement cannot leave the row missing the way a
    // two-statement replace could if the process died between them.
    await (
      this.db.insert(flowImportLockChains).values({
        flowId,
        document: serialized,
        createdAt: now,
        updatedAt: now,
      }) as unknown as {
        onConflictDoUpdate(config: {
          target: unknown;
          set: unknown;
        }): PromiseLike<unknown>;
      }
    ).onConflictDoUpdate({
      target: flowImportLockChains.flowId,
      // `createdAt` is intentionally absent: it records when the chain was
      // first written, so an update must not reset it.
      set: { document: serialized, updatedAt: now },
    });
  }
}
