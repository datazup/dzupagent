import {
  constants as fsConstants,
  mkdir,
  open,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const TARGET = "dzupagent.local-v2-multi-step-host@1";
const CAPABILITY = "flow.runtime.durable-checkpoint-store@1";
const RECORD_SCHEMA = "dzupagent.v2InactiveLocalDurableStoreRecord/v1";
const EVIDENCE_SCHEMA = "dzupagent.v2InactiveLocalDurableStoreEvidence/v1";

export function createFileV2InactiveLocalHostStoreCore(input) {
  const options = validateOptions(input);
  const evidenceCore = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    adapterId: options.adapterId,
    capability: CAPABILITY,
    target: TARGET,
    persistence: "atomic-filesystem-json",
    processScope: "multi-process",
    claim: "exclusive-lease-with-expiry",
    compareAndSwap: "checkpoint-digest-and-revision",
    fencing: "monotonic-token-before-every-cas",
    release: "idempotent-for-latest-lease",
    crashRecovery: "atomic-rename-and-stale-lock-reclamation",
    providerDispatch: false,
    workflowExternalMutation: false,
    deployment: false,
    activation: false,
  });
  const evidence = Object.freeze({
    ...evidenceCore,
    evidenceSha256: digest(stableStringify(evidenceCore)),
  });

  return Object.freeze({
    adapterId: options.adapterId,
    rootDirectory: options.rootDirectory,
    evidence,
    async claim({ runId, ownerId }) {
      validateIdentity("runId", runId);
      validateIdentity("ownerId", ownerId);
      return withRunLock(options, runId, async (paths) => {
        const current = await readRecord(paths.record, runId);
        const nowMs = leaseNow(options);
        if (
          current.activeLease !== null &&
          current.activeLease.expiresAtMs > nowMs
        ) {
          return {
            ok: false,
            reason: "already-claimed",
            leaseExpiresAtMs: current.activeLease.expiresAtMs,
          };
        }
        const fencingToken = current.fencingToken + 1;
        const leaseToken = digest(
          stableStringify({
            adapterId: options.adapterId,
            target: TARGET,
            runId,
            ownerId,
            fencingToken,
            nonce: options.randomId(),
          })
        );
        const leaseExpiresAtMs = nowMs + options.leaseDurationMs;
        const next = {
          ...current,
          fencingToken,
          activeLease: {
            ownerId,
            leaseToken,
            fencingToken,
            expiresAtMs: leaseExpiresAtMs,
          },
        };
        await writeRecord(options, paths.record, next);
        return {
          ok: true,
          leaseToken,
          fencingToken,
          leaseExpiresAtMs,
          checkpoint: clone(current.checkpoint),
        };
      });
    },
    async commit({
      runId,
      leaseToken,
      fencingToken,
      expectedPreviousSha256,
      checkpoint,
    }) {
      validateIdentity("runId", runId);
      return withRunLock(options, runId, async (paths) => {
        const current = await readRecord(paths.record, runId);
        const lease = current.activeLease;
        const nowMs = leaseNow(options);
        if (
          lease === null ||
          lease.leaseToken !== leaseToken ||
          lease.fencingToken !== fencingToken ||
          current.fencingToken !== fencingToken ||
          lease.expiresAtMs <= nowMs ||
          (current.checkpoint?.checkpointSha256 ?? null) !==
            expectedPreviousSha256 ||
          checkpoint?.runId !== runId ||
          checkpoint?.previousCheckpointSha256 !== expectedPreviousSha256 ||
          checkpoint?.revision !== (current.checkpoint?.revision ?? 0) + 1
        ) {
          return false;
        }
        const next = {
          ...current,
          checkpoint: clone(checkpoint),
          activeLease: {
            ...lease,
            expiresAtMs: nowMs + options.leaseDurationMs,
          },
        };
        await writeRecord(options, paths.record, next);
        return true;
      });
    },
    async release({ runId, leaseToken, fencingToken }) {
      validateIdentity("runId", runId);
      return withRunLock(options, runId, async (paths) => {
        const current = await readRecord(paths.record, runId);
        if (
          current.activeLease === null &&
          current.lastReleasedLease?.leaseToken === leaseToken &&
          current.lastReleasedLease.fencingToken === fencingToken &&
          current.fencingToken === fencingToken
        ) {
          return true;
        }
        if (
          current.activeLease?.leaseToken !== leaseToken ||
          current.activeLease.fencingToken !== fencingToken ||
          current.fencingToken !== fencingToken
        ) {
          return false;
        }
        await writeRecord(options, paths.record, {
          ...current,
          activeLease: null,
          lastReleasedLease: { leaseToken, fencingToken },
        });
        return true;
      });
    },
  });
}

export function durableHostStoreRunKey(runId) {
  validateIdentity("runId", runId);
  return createHash("sha256").update(runId).digest("hex");
}

async function withRunLock(options, runId, operation) {
  await mkdir(options.rootDirectory, { recursive: true, mode: 0o700 });
  const runKey = durableHostStoreRunKey(runId);
  const paths = {
    record: resolve(options.rootDirectory, `${runKey}.json`),
    lock: resolve(options.rootDirectory, `${runKey}.lock`),
  };
  await acquireLock(options, paths.lock);
  try {
    return await operation(paths);
  } finally {
    await rmdir(paths.lock).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function acquireLock(options, lockPath) {
  const deadlineMs = Date.now() + options.lockTimeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const lockStat = await stat(lockPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (lockStat !== null && !lockStat.isDirectory()) {
      throw new Error("durable host store lock path is not a directory");
    }
    if (
      lockStat !== null &&
      Date.now() - lockStat.mtimeMs >= options.lockStaleMs
    ) {
      const quarantine = `${lockPath}.stale-${
        process.pid
      }-${options.randomId()}`;
      try {
        await rename(lockPath, quarantine);
        await rmdir(quarantine);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      continue;
    }
    if (Date.now() >= deadlineMs) {
      throw new Error("durable host store lock acquisition timed out");
    }
    await delay(options.lockRetryMs);
  }
}

async function readRecord(recordPath, runId) {
  let handle;
  try {
    handle = await open(
      recordPath,
      fsConstants.O_RDONLY | noFollowFlag(),
      0o600
    );
  } catch (error) {
    if (error?.code === "ENOENT") return emptyRecord(runId);
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.nlink !== 1) {
      throw new Error("durable host store record must be one regular file");
    }
    const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    validateRecordEnvelope(parsed, runId);
    return clone(parsed.record);
  } finally {
    await handle.close();
  }
}

async function writeRecord(options, recordPath, record) {
  const envelope = {
    record,
    recordSha256: digest(stableStringify(record)),
  };
  const temporary = `${recordPath}.tmp-${process.pid}-${options.randomId()}`;
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        noFollowFlag(),
      0o600
    );
    await handle.writeFile(stableStringify(envelope), { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, recordPath);
    await syncDirectory(options.rootDirectory);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateRecordEnvelope(value, runId) {
  if (
    !isRecord(value) ||
    !isRecord(value.record) ||
    value.recordSha256 !== digest(stableStringify(value.record)) ||
    value.record.schema !== RECORD_SCHEMA ||
    value.record.target !== TARGET ||
    value.record.runId !== runId ||
    !Number.isSafeInteger(value.record.fencingToken) ||
    value.record.fencingToken < 0 ||
    !validLease(value.record.activeLease) ||
    !validReleasedLease(value.record.lastReleasedLease)
  ) {
    throw new Error(
      "durable host store record failed identity or digest validation"
    );
  }
}

function validLease(value) {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.ownerId === "string" &&
      typeof value.leaseToken === "string" &&
      Number.isSafeInteger(value.fencingToken) &&
      Number.isSafeInteger(value.expiresAtMs))
  );
}

function validReleasedLease(value) {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.leaseToken === "string" &&
      Number.isSafeInteger(value.fencingToken))
  );
}

function emptyRecord(runId) {
  return {
    schema: RECORD_SCHEMA,
    target: TARGET,
    runId,
    fencingToken: 0,
    checkpoint: null,
    activeLease: null,
    lastReleasedLease: null,
  };
}

function validateOptions(input) {
  if (!isRecord(input) || typeof input.rootDirectory !== "string") {
    throw new TypeError("rootDirectory is required");
  }
  const rootDirectory = resolve(input.rootDirectory);
  if (!isAbsolute(rootDirectory)) throw new TypeError("rootDirectory invalid");
  return Object.freeze({
    rootDirectory,
    adapterId: boundedString(input.adapterId, "adapterId", "file-v1"),
    leaseDurationMs: positiveInteger(
      input.leaseDurationMs,
      "leaseDurationMs",
      30_000
    ),
    lockTimeoutMs: positiveInteger(input.lockTimeoutMs, "lockTimeoutMs", 5_000),
    lockStaleMs: positiveInteger(input.lockStaleMs, "lockStaleMs", 10_000),
    lockRetryMs: positiveInteger(input.lockRetryMs, "lockRetryMs", 10),
    clock: typeof input.clock === "function" ? input.clock : Date.now,
    randomId:
      typeof input.randomId === "function"
        ? input.randomId
        : () => randomBytes(16).toString("hex"),
  });
}

function validateIdentity(name, value) {
  boundedString(value, name);
}

function boundedString(value, name, fallback) {
  const selected = value ?? fallback;
  if (
    typeof selected !== "string" ||
    selected.length === 0 ||
    selected.length > 256
  ) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return selected;
}

function positiveInteger(value, name, fallback) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return selected;
}

function leaseNow(options) {
  const value = options.clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("durable host store clock returned an invalid timestamp");
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noFollowFlag() {
  return fsConstants.O_NOFOLLOW ?? 0;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
