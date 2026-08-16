/**
 * Opt-in real-PostgreSQL qualification for the effect journal adapter.
 *
 * This suite never discovers credentials. It runs only when the operator sets
 * DZUPAGENT_EFFECT_JOURNAL_POSTGRES_URL for an authorized disposable database;
 * RUN_REQUIRED_INTEGRATION=1 makes absence fail closed instead of skipping.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  executeEffectOnce,
  materializeEffectIntent,
  materializeEffectReceipt,
  type EffectIntent,
} from "@dzupagent/runtime-contracts/effect-receipt";
import { requireIntegrationEnv } from "../../__tests__/require-integration-env.js";
import { PostgresEffectJournalStore } from "../postgres-effect-journal-store.js";
import type { PostgresEffectJournalError } from "../postgres-effect-journal-store.js";
import type { PostgresClientLike } from "../postgres-checkpoint-store.js";

const gate = requireIntegrationEnv(
  "effect journal live PostgreSQL qualification",
  "DZUPAGENT_EFFECT_JOURNAL_POSTGRES_URL"
);
const liveIt = gate.shouldSkip ? it.skip : it;

const claimedAt = "2026-08-14T12:00:00.000Z";
const committedAt = "2026-08-14T12:00:01.000Z";

describe("PostgresEffectJournalStore — live disposable database", () => {
  liveIt(
    "qualifies unique claims, replay, blocking states, CAS, immutability, and constraints",
    async () => {
      const connectionString =
        process.env["DZUPAGENT_EFFECT_JOURNAL_POSTGRES_URL"]!;
      const leftClient = await LivePostgresClient.connect(connectionString);
      const rightClient = await LivePostgresClient.connect(connectionString);
      const tableName = `test_effect_journal_${crypto
        .randomUUID()
        .replaceAll("-", "")}`;
      const left = new PostgresEffectJournalStore<string>({
        client: leftClient,
        tableName,
      });
      const right = new PostgresEffectJournalStore<string>({
        client: rightClient,
        tableName,
      });

      try {
        await left.setup();

        const concurrent = effectIntent("live:concurrent");
        const claims = await Promise.all([
          left.claim(concurrent, claimedAt),
          right.claim(concurrent, claimedAt),
        ]);
        expect(
          claims.filter(({ status }) => status === "claimed")
        ).toHaveLength(1);
        expect(
          claims.filter(({ status }) => status === "existing")
        ).toHaveLength(1);

        const replayIntent = effectIntent("live:replay");
        let dispatches = 0;
        const execute = async () => {
          dispatches += 1;
          return "committed";
        };
        await expect(
          executeEffectOnce({
            store: left,
            intent: replayIntent,
            execute,
            now: () => claimedAt,
          })
        ).resolves.toMatchObject({ status: "executed" });
        await expect(
          executeEffectOnce({
            store: right,
            intent: replayIntent,
            execute,
            now: () => committedAt,
          })
        ).resolves.toMatchObject({ status: "replayed" });
        expect(dispatches).toBe(1);

        // Within-table freshness control: a key this table has never seen
        // dispatches. This shows the `replayed` above is not a store that
        // reports `replayed` for everything. It is NOT the empty-journal
        // control — that one lives in its own test below, because proving the
        // assertions depend on journal *contents* requires a table that was
        // never written to at all.
        await expect(
          executeEffectOnce({
            store: right,
            intent: effectIntent("live:empty-control"),
            execute,
            now: () => committedAt,
          })
        ).resolves.toMatchObject({ status: "executed" });
        expect(dispatches).toBe(2);

        let blockedDispatches = 0;
        const blockedExecute = async () => {
          blockedDispatches += 1;
          return "must-not-run";
        };
        const pending = effectIntent("live:pending");
        await left.claim(pending, claimedAt);
        await expect(
          executeEffectOnce({
            store: right,
            intent: pending,
            execute: blockedExecute,
            now: () => committedAt,
          })
        ).resolves.toEqual({
          status: "blocked",
          reason: "effect-outcome-unknown",
        });
        await left.markOutcomeUnknown(pending, committedAt);
        await expect(
          executeEffectOnce({
            store: right,
            intent: pending,
            execute: blockedExecute,
            now: () => committedAt,
          })
        ).resolves.toEqual({
          status: "blocked",
          reason: "effect-outcome-unknown",
        });

        const conflict = effectIntent("live:conflict");
        await left.claim(conflict, claimedAt);
        await expect(
          executeEffectOnce({
            store: right,
            intent: effectIntent("live:conflict", "other-node"),
            execute: blockedExecute,
            now: () => committedAt,
          })
        ).resolves.toEqual({
          status: "blocked",
          reason: "idempotency-conflict",
        });
        expect(blockedDispatches).toBe(0);

        const immutable = effectIntent("live:immutable");
        const immutableReceipt = materializeEffectReceipt({
          intent: immutable,
          result: "committed",
          committedAt,
        });
        await left.claim(immutable, claimedAt);
        await left.commit(immutable, immutableReceipt);
        await expect(
          right.commit(immutable, immutableReceipt)
        ).resolves.toBeUndefined();
        await expect(
          right.markOutcomeUnknown(immutable, committedAt)
        ).rejects.toMatchObject({
          name: "PostgresEffectJournalError",
          code: "invalid-transition",
        } satisfies Partial<PostgresEffectJournalError>);

        await expect(
          leftClient.query(
            `INSERT INTO ${tableName} (
              idempotency_key, intent_digest, status, intent, claimed_at
            ) VALUES ($1, $2, 'committed', $3::jsonb, $4)`,
            [
              "live:invalid-row",
              `sha256:${"0".repeat(64)}`,
              JSON.stringify(immutable),
              claimedAt,
            ]
          )
        ).rejects.toBeDefined();
      } finally {
        await leftClient.query(`DROP TABLE IF EXISTS ${tableName}`);
        await Promise.all([leftClient.close(), rightClient.close()]);
      }
    },
    20_000
  );

  liveIt(
    "survives process death: a SIGKILLed claimant leaves a durable pending claim that blocks re-dispatch",
    async () => {
      const connectionString =
        process.env["DZUPAGENT_EFFECT_JOURNAL_POSTGRES_URL"]!;
      const survivorClient = await LivePostgresClient.connect(connectionString);
      const tableName = `test_effect_crash_${crypto
        .randomUUID()
        .replaceAll("-", "")}`;
      const survivor = new PostgresEffectJournalStore<string>({
        client: survivorClient,
        tableName,
      });

      try {
        await survivor.setup();

        const crashedKey = "live:process-death";
        const workerPath = fileURLToPath(
          new URL("./fixtures/effect-journal-crash-worker.mjs", import.meta.url)
        );

        // A real second OS process claims the effect, then dies uncleanly while
        // the claim is still pending. Two clients in one process cannot prove
        // this: the claim has to outlive the process that wrote it.
        const worker = spawn(
          process.execPath,
          [workerPath, connectionString, tableName, crashedKey, claimedAt],
          { stdio: ["ignore", "pipe", "pipe"] }
        );

        const claimed = await new Promise<boolean>((resolve, reject) => {
          let out = "";
          // Fake timers cannot bound this wait: it is a real OS child process
          // connecting to a real database, so the elapsed time is outside this
          // test's event loop and vi.advanceTimersByTimeAsync() would never let
          // the handshake arrive.
          // eslint-disable-next-line no-restricted-syntax -- real child process, see above
          const timer = setTimeout(
            () => reject(new Error("worker did not claim within 15s")),
            15_000
          );
          worker.stdout.on("data", (chunk: Buffer) => {
            out += chunk.toString();
            if (out.includes("CLAIMED")) {
              clearTimeout(timer);
              resolve(true);
            }
            if (out.includes("CLAIM_FAILED")) {
              clearTimeout(timer);
              resolve(false);
            }
          });
          worker.on("error", reject);
          worker.on("exit", (code) => {
            clearTimeout(timer);
            if (!out.includes("CLAIMED")) {
              reject(new Error(`worker exited early with code ${code}`));
            }
          });
        });
        expect(claimed).toBe(true);

        const workerExit = new Promise<number | null>((resolve) => {
          worker.on("exit", (_code, signal) =>
            resolve(signal === "SIGKILL" ? -9 : _code)
          );
        });
        worker.kill("SIGKILL");
        expect(await workerExit).toBe(-9);

        // The killed process left a durable `pending` row behind.
        const persisted = await survivorClient.query<{ status: string }>(
          `SELECT status FROM ${tableName} WHERE idempotency_key = $1`,
          [crashedKey]
        );
        expect(persisted.rows).toHaveLength(1);
        expect(persisted.rows[0]?.status).toBe("pending");

        // A surviving process must refuse to re-run the effect: the outcome of
        // the dead process's effect is unknown, so exactly-once forbids retry.
        let survivorDispatches = 0;
        const survivorExecute = async () => {
          survivorDispatches += 1;
          return "must-not-run";
        };
        await expect(
          executeEffectOnce({
            store: survivor,
            intent: crashedIntent(crashedKey),
            execute: survivorExecute,
            now: () => committedAt,
          })
        ).resolves.toEqual({
          status: "blocked",
          // The dead process left a matching-digest `pending` row, so the
          // survivor takes the existing-claim branch: the effect may or may
          // not have reached the outside world before the kill, so
          // exactly-once forbids re-dispatch. (A digest MISMATCH would instead
          // yield `idempotency-conflict` — see the worker's comment on why the
          // digest must be derived, not hand-rolled.)
          reason: "effect-outcome-unknown",
        });
        expect(survivorDispatches).toBe(0);

        // Non-vacuity control: the same survivor, same table, same execute
        // function DOES dispatch for a key no dead process ever claimed. This
        // proves the refusal above comes from the crashed claim, not from a
        // store that blocks everything.
        await expect(
          executeEffectOnce({
            store: survivor,
            intent: crashedIntent("live:process-death-control"),
            execute: survivorExecute,
            now: () => committedAt,
          })
        ).resolves.toMatchObject({ status: "executed" });
        expect(survivorDispatches).toBe(1);
      } finally {
        await survivorClient.query(`DROP TABLE IF EXISTS ${tableName}`);
        await survivorClient.close();
      }
    },
    30_000
  );

  liveIt(
    "empty-journal control: the exact intents that replay and block against a written journal all execute against an empty one",
    async () => {
      // doc 24 §9 packet 24-C evidence item: "empty-journal control".
      //
      // The other live tests assert `replayed`, `effect-outcome-unknown` and
      // `idempotency-conflict`. Each of those outcomes is only meaningful if it
      // is caused by rows in the journal. A store that ignored its input and
      // returned those statuses unconditionally would satisfy every one of
      // them, and so would a suite whose assertions were simply written to
      // match whatever the adapter happens to emit.
      //
      // This control supplies the counterfactual those tests cannot supply
      // themselves: the SAME intents, the SAME store class and the SAME
      // execute function, differing only in that the journal is empty. Every
      // outcome must flip to `executed`. If any assertion above were pinned to
      // a constant rather than to journal state, this test fails.
      const connectionString =
        process.env["DZUPAGENT_EFFECT_JOURNAL_POSTGRES_URL"]!;
      const client = await LivePostgresClient.connect(connectionString);
      const tableName = `test_effect_empty_${crypto
        .randomUUID()
        .replaceAll("-", "")}`;
      const store = new PostgresEffectJournalStore<string>({
        client,
        tableName,
      });

      try {
        await store.setup();

        // The table exists and is genuinely empty: setup() alone must not
        // manufacture rows. Asserted, not assumed — an adapter that seeded a
        // row would silently weaken every "fresh key" claim in this suite.
        const empty = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${tableName}`
        );
        expect(empty.rows[0]?.count).toBe("0");

        let dispatches = 0;
        const execute = async () => {
          dispatches += 1;
          return "committed";
        };

        // `live:replay` is `replayed` when the journal holds a committed row.
        await expect(
          executeEffectOnce({
            store,
            intent: effectIntent("live:replay"),
            execute,
            now: () => committedAt,
          })
        ).resolves.toMatchObject({ status: "executed" });

        // `live:pending` is blocked/effect-outcome-unknown when the journal
        // holds a pending claim.
        await expect(
          executeEffectOnce({
            store,
            intent: effectIntent("live:pending"),
            execute,
            now: () => committedAt,
          })
        ).resolves.toMatchObject({ status: "executed" });

        // This intent is blocked/idempotency-conflict when the journal holds a
        // claim for the same key under a different node — the digest differs.
        await expect(
          executeEffectOnce({
            store,
            intent: effectIntent("live:conflict", "other-node"),
            execute,
            now: () => committedAt,
          })
        ).resolves.toMatchObject({ status: "executed" });

        // `live:process-death` is blocked when a SIGKILLed process left a
        // pending claim behind.
        await expect(
          executeEffectOnce({
            store,
            intent: crashedIntent("live:process-death"),
            execute,
            now: () => committedAt,
          })
        ).resolves.toMatchObject({ status: "executed" });

        // Every effect really was dispatched: four intents, four executions.
        // Without this the four `executed` assertions could pass on a store
        // that reported success without ever calling `execute`.
        expect(dispatches).toBe(4);

        // And the empty journal is empty no longer — the executions were
        // durably recorded, so "executed" meant a committed row, not a no-op.
        const written = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${tableName} WHERE status = 'committed'`
        );
        expect(written.rows[0]?.count).toBe("4");
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${tableName}`);
        await client.close();
      }
    },
    20_000
  );
});

function crashedIntent(key: string): EffectIntent {
  return materializeEffectIntent({
    idempotencyKey: key,
    sourceHash: `sha256:${"a".repeat(64)}`,
    runId: "live-run",
    nodeId: "crash-node",
    effectClass: "db_write",
    attemptPolicy: "exactly-once-required",
    operationDigest: `sha256:${"b".repeat(64)}`,
  });
}

function effectIntent(key: string, nodeId = "node-1"): EffectIntent {
  return materializeEffectIntent({
    idempotencyKey: key,
    sourceHash: `sha256:${"a".repeat(64)}`,
    runId: "live-run",
    nodeId,
    effectClass: "db_write",
    attemptPolicy: "exactly-once-required",
    operationDigest: `sha256:${"b".repeat(64)}`,
  });
}

class LivePostgresClient implements PostgresClientLike {
  private constructor(
    private readonly client: PostgresClientLike & { end(): Promise<void> }
  ) {}

  static async connect(connectionString: string): Promise<LivePostgresClient> {
    // `pg` is resolved at runtime rather than statically imported: it is an
    // ambient workspace dependency, not declared by this package, so a static
    // import would put an undeclared dependency in the package's graph.
    // `createRequire` (not `new Function("return import(...)")`) is used
    // because the latter throws "A dynamic import callback was not specified"
    // under the vitest transform, which made this suite unrunnable.
    const { createRequire } = await import("node:module");
    const pg = createRequire(import.meta.url)("pg") as {
      Client: new (options: {
        connectionString: string;
      }) => PostgresClientLike & {
        connect(): Promise<void>;
        end(): Promise<void>;
      };
    };
    const client = new pg.Client({ connectionString });
    await client.connect();
    return new LivePostgresClient(client);
  }

  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
    return this.client.query<T>(text, params);
  }

  close(): Promise<void> {
    return this.client.end();
  }
}
