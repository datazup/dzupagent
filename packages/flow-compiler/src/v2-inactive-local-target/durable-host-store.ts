import { createFileV2InactiveLocalHostStoreCore } from "./durable-host-store-core.mjs";
import type { V2InactiveLocalHostCheckpointStore } from "./host-contracts.js";

export const V2_INACTIVE_LOCAL_DURABLE_STORE_CAPABILITY =
  "flow.runtime.durable-checkpoint-store@1" as const;

export interface V2InactiveLocalDurableStoreEvidence {
  readonly schema: "dzupagent.v2InactiveLocalDurableStoreEvidence/v1";
  readonly adapterId: string;
  readonly capability: typeof V2_INACTIVE_LOCAL_DURABLE_STORE_CAPABILITY;
  readonly target: "dzupagent.local-v2-multi-step-host@1";
  readonly persistence: "atomic-filesystem-json";
  readonly processScope: "multi-process";
  readonly claim: "exclusive-lease-with-expiry";
  readonly compareAndSwap: "checkpoint-digest-and-revision";
  readonly fencing: "monotonic-token-before-every-cas";
  readonly release: "idempotent-for-latest-lease";
  readonly crashRecovery: "atomic-rename-and-stale-lock-reclamation";
  readonly providerDispatch: false;
  readonly workflowExternalMutation: false;
  readonly deployment: false;
  readonly activation: false;
  readonly evidenceSha256: `sha256:${string}`;
}

export interface FileV2InactiveLocalHostStoreOptions {
  readonly rootDirectory: string;
  readonly adapterId?: string;
  readonly leaseDurationMs?: number;
  readonly lockTimeoutMs?: number;
  readonly lockStaleMs?: number;
  readonly lockRetryMs?: number;
  /** Deterministic lease clock for qualification. Lock deadlines stay real. */
  readonly clock?: () => number;
  /** Deterministic nonce source for qualification fixtures. */
  readonly randomId?: () => string;
}

export interface FileV2InactiveLocalHostStore
  extends V2InactiveLocalHostCheckpointStore {
  readonly adapterId: string;
  readonly rootDirectory: string;
  readonly evidence: V2InactiveLocalDurableStoreEvidence;
}

/**
 * Create the inactive host's provider-free filesystem reference store.
 * Records are private, digest-bound, atomically renamed, and serialized by a
 * crash-reclaimable per-run lock. Every durable CAS requires the exact current
 * monotonic fencing token and an unexpired lease.
 */
export function createFileV2InactiveLocalHostStore(
  options: FileV2InactiveLocalHostStoreOptions
): FileV2InactiveLocalHostStore {
  return createFileV2InactiveLocalHostStoreCore(
    options
  ) as FileV2InactiveLocalHostStore;
}
