import { createFileV2InactiveLocalHostStoreCore } from "../../v2-inactive-local-target/durable-host-store-core.mjs";

const [rootDirectory, runId, ownerId, startAtRaw] = process.argv.slice(2);

if (!rootDirectory || !runId || !ownerId) {
  throw new Error("rootDirectory, runId, and ownerId are required");
}

const startAt = Number(startAtRaw ?? 0);
const store = createFileV2InactiveLocalHostStoreCore({
  rootDirectory,
  leaseDurationMs: 60_000,
  lockTimeoutMs: 5_000,
  lockStaleMs: 5_000,
});

if (Number.isFinite(startAt) && startAt > Date.now()) {
  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, startAt - Date.now())
  );
}

const claim = await store.claim({ runId, ownerId });

process.stdout.write(
  `${JSON.stringify({
    ownerId,
    claim: claim.ok
      ? {
          ok: true,
          leaseToken: claim.leaseToken,
          fencingToken: claim.fencingToken,
          checkpointRevision: claim.checkpoint?.revision ?? null,
        }
      : claim,
  })}\n`
);
