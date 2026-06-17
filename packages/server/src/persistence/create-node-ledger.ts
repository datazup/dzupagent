/**
 * Production factory for `DurableNodeLedger`.
 *
 * Allows deployers to construct a {@link PostgresDurableNodeLedger} from their
 * Drizzle db instance without importing the internal class directly.
 *
 * @example
 * ```ts
 * import { createPostgresNodeLedger } from "@dzupagent/server";
 * const nodeLedger = createPostgresNodeLedger(db);
 * createForgeApp({ ..., nodeLedger });
 * ```
 */
import type { DurableNodeLedger } from "@dzupagent/core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PostgresDurableNodeLedger } from "./postgres-durable-node-ledger.js";

type DB = PostgresJsDatabase<Record<string, never>>;

/**
 * Create a Postgres-backed {@link DurableNodeLedger} from a Drizzle db instance.
 *
 * This is a thin factory — no logic beyond `new PostgresDurableNodeLedger(db)`.
 * Returns the `DurableNodeLedger` interface to avoid leaking the concrete class.
 */
export function createPostgresNodeLedger(db: DB): DurableNodeLedger {
  return new PostgresDurableNodeLedger(db);
}
