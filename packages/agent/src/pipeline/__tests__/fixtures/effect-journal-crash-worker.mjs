/**
 * Separate-process claimant for the Packet 24-C process-death qualification.
 *
 * Claims a single effect intent against a live disposable PostgreSQL journal,
 * announces the durable claim on stdout, and then blocks forever so the parent
 * can SIGKILL it while the claim is still `pending`. It must never commit and
 * must never clean up: the whole point is to leave a durable row behind that
 * outlives a process that died mid-effect.
 *
 * Invoked as: node effect-journal-crash-worker.mjs <connectionString> <tableName> <idempotencyKey> <claimedAt>
 */
import { createRequire } from "node:module";
import { materializeEffectIntent } from "@dzupagent/runtime-contracts/effect-receipt";

const [connectionString, tableName, idempotencyKey, claimedAt] =
  process.argv.slice(2);

// The digest MUST be derived by the real materializer, not hand-rolled: the
// parent builds its intent the same way, and a mismatch would make the parent
// take the `idempotency-conflict` branch instead of the crash branch — the
// test would then pass without ever proving anything about process death.
const intent = materializeEffectIntent({
  idempotencyKey,
  sourceHash: `sha256:${"a".repeat(64)}`,
  runId: "live-run",
  nodeId: "crash-node",
  effectClass: "db_write",
  attemptPolicy: "exactly-once-required",
  operationDigest: `sha256:${"b".repeat(64)}`,
});
const intentDigest = intent.intentDigest;

const pg = createRequire(import.meta.url)("pg");
const client = new pg.Client({ connectionString });
await client.connect();

const inserted = await client.query(
  `INSERT INTO ${tableName} (
     idempotency_key, intent_digest, status, intent, claimed_at
   ) VALUES ($1, $2, 'pending', $3::jsonb, $4)
   ON CONFLICT (idempotency_key) DO NOTHING
   RETURNING idempotency_key`,
  [idempotencyKey, intentDigest, JSON.stringify(intent), claimedAt],
);

if (inserted.rows.length !== 1) {
  console.log("CLAIM_FAILED");
  process.exit(1);
}

// Signal the parent that the claim is durably committed to the journal, then
// hang. The parent kills -9 from here; nothing below this line should run.
console.log("CLAIMED");

await new Promise(() => {});
