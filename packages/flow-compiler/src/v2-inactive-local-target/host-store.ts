import { deepFreeze, digest, stableStringify } from "./evidence.js";
import {
  V2_INACTIVE_LOCAL_HOST_ID,
  type V2InactiveLocalHostCheckpoint,
  type V2InactiveLocalHostCheckpointStore,
  type V2InactiveLocalHostClaimResult,
} from "./host-contracts.js";

interface StoredRun {
  checkpoint: V2InactiveLocalHostCheckpoint | null;
  leaseToken: string | null;
  leaseSequence: number;
  lastReleasedLeaseToken: string | null;
}

/**
 * Process-local reference store for tests and inactive qualification. The
 * interface is intentionally CAS-shaped so a durable host store can implement
 * the same claim/commit/release contract without changing execution logic.
 */
export function createInMemoryV2InactiveLocalHostStore(): V2InactiveLocalHostCheckpointStore {
  const runs = new Map<string, StoredRun>();
  return Object.freeze({
    async claim(input: {
      readonly runId: string;
      readonly ownerId: string;
    }): Promise<V2InactiveLocalHostClaimResult> {
      const current = runs.get(input.runId) ?? {
        checkpoint: null,
        leaseToken: null,
        leaseSequence: 0,
        lastReleasedLeaseToken: null,
      };
      if (current.leaseToken !== null) {
        return { ok: false, reason: "already-claimed" };
      }
      const leaseSequence = current.leaseSequence + 1;
      const leaseToken = digest(
        stableStringify({
          target: V2_INACTIVE_LOCAL_HOST_ID,
          runId: input.runId,
          ownerId: input.ownerId,
          leaseSequence,
          previous: current.checkpoint?.checkpointSha256 ?? null,
        })
      );
      runs.set(input.runId, { ...current, leaseSequence, leaseToken });
      return {
        ok: true,
        leaseToken,
        fencingToken: leaseSequence,
        checkpoint: current.checkpoint,
      };
    },
    async commit(input: {
      readonly runId: string;
      readonly leaseToken: string;
      readonly fencingToken?: number;
      readonly expectedPreviousSha256: `sha256:${string}` | null;
      readonly checkpoint: V2InactiveLocalHostCheckpoint;
    }): Promise<boolean> {
      const current = runs.get(input.runId);
      if (
        current === undefined ||
        current.leaseToken !== input.leaseToken ||
        input.fencingToken !== current.leaseSequence ||
        (current.checkpoint?.checkpointSha256 ?? null) !==
          input.expectedPreviousSha256 ||
        input.checkpoint.previousCheckpointSha256 !==
          input.expectedPreviousSha256 ||
        input.checkpoint.revision !== (current.checkpoint?.revision ?? 0) + 1
      ) {
        return false;
      }
      runs.set(input.runId, {
        ...current,
        checkpoint: deepFreeze(structuredClone(input.checkpoint)),
      });
      return true;
    },
    async release(input: {
      readonly runId: string;
      readonly leaseToken: string;
      readonly fencingToken?: number;
    }): Promise<boolean> {
      const current = runs.get(input.runId);
      if (
        current?.leaseToken === null &&
        current.lastReleasedLeaseToken === input.leaseToken &&
        current.leaseSequence === input.fencingToken
      ) {
        return true;
      }
      if (
        current?.leaseToken !== input.leaseToken ||
        current.leaseSequence !== input.fencingToken
      )
        return false;
      runs.set(input.runId, {
        checkpoint: current.checkpoint,
        leaseSequence: current.leaseSequence,
        leaseToken: null,
        lastReleasedLeaseToken: input.leaseToken,
      });
      return true;
    },
  });
}
