/**
 * Opt-in real-PostgreSQL qualification for the effect journal adapter.
 *
 * This suite never discovers credentials. It runs only when the operator sets
 * DZUPAGENT_EFFECT_JOURNAL_POSTGRES_URL for an authorized disposable database;
 * RUN_REQUIRED_INTEGRATION=1 makes absence fail closed instead of skipping.
 */
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
});

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
    const importModule = new Function(
      "specifier",
      "return import(specifier)"
    ) as (specifier: string) => Promise<unknown>;
    const pg = (await importModule("pg")) as {
      Client: new (options: { connectionString: string }) => PostgresClientLike &
        { connect(): Promise<void>; end(): Promise<void> };
    };
    const client = new pg.Client({ connectionString });
    await client.connect();
    return new LivePostgresClient(client);
  }

  query<T = unknown>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }> {
    return this.client.query<T>(text, params);
  }

  close(): Promise<void> {
    return this.client.end();
  }
}
