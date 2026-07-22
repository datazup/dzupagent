/**
 * Checkpoint-store resolution for the pipeline runtime.
 *
 * Extracted from `pipeline-runtime.ts` (DZUPAGENT-ARCH-M-06). Owns the pure
 * mapping from a `PipelineRuntimeConfig` to the effective
 * `PipelineCheckpointStore` — explicit store, named store map, or a
 * `scheme://` URI ref — plus the event-capture predicate. Behaviour is
 * identical to the original inline implementation; no runtime state lives here.
 *
 * @module pipeline/pipeline-runtime-lifecycle/checkpoint-store-resolution
 */

import type { PipelineCheckpointStore } from "@dzupagent/core/pipeline";
import { PostgresPipelineCheckpointStore } from "../postgres-checkpoint-store.js";
import { RedisPipelineCheckpointStore } from "../redis-checkpoint-store.js";
import type { PipelineRuntimeConfig } from "../pipeline-runtime-types.js";

/**
 * Resolve the checkpoint store the runtime should use, honouring (in order):
 * a named store from `checkpointStores`, a `scheme://` URI `storeRef`, then
 * the explicitly provided `checkpointStore`. Returns `undefined` when none
 * apply, leaving the caller to auto-wire a default.
 */
export function resolveCheckpointStore(
  config: PipelineRuntimeConfig
): PipelineCheckpointStore | undefined {
  const storeRef = config.definition.checkpoint?.storeRef;
  if (storeRef && config.checkpointStores?.[storeRef]) {
    return config.checkpointStores[storeRef];
  }
  if (storeRef && isCheckpointStoreUriRef(storeRef)) {
    return resolveCheckpointStoreUri(storeRef, config);
  }
  return config.checkpointStore;
}

function isCheckpointStoreUriRef(storeRef: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(storeRef);
}

function resolveCheckpointStoreUri(
  storeRef: string,
  config: PipelineRuntimeConfig
): PipelineCheckpointStore {
  if (!storeRef.includes("://")) {
    throw new Error(
      `Malformed checkpoint.storeRef URI "${storeRef}": expected "scheme://...".`
    );
  }

  let uri: URL;
  try {
    uri = new URL(storeRef);
  } catch {
    throw new Error(`Malformed checkpoint.storeRef URI "${storeRef}".`);
  }

  const scheme = uri.protocol.slice(0, -1).toLowerCase();
  switch (scheme) {
    case "pg":
    case "postgres":
    case "postgresql":
      if (!config.pgClient) {
        throw new Error(
          `checkpoint.storeRef URI "${storeRef}" requires PipelineRuntimeConfig.pgClient.`
        );
      }
      return new PostgresPipelineCheckpointStore({
        client: config.pgClient,
      });
    case "redis":
    case "rediss":
      if (!config.redisClient) {
        throw new Error(
          `checkpoint.storeRef URI "${storeRef}" requires PipelineRuntimeConfig.redisClient.`
        );
      }
      return new RedisPipelineCheckpointStore({
        client: config.redisClient,
      });
    default:
      throw new Error(
        `Unsupported checkpoint.storeRef URI scheme "${scheme}" in "${storeRef}".`
      );
  }
}

/**
 * Whether the runtime should capture a structured-cloned copy of every event
 * into its in-memory event log. True when the definition opts into checkpoint
 * event inclusion or a non-`none` execution-log event history.
 */
export function shouldCaptureRuntimeEvents(
  definition: PipelineRuntimeConfig["definition"]
): boolean {
  return (
    definition.checkpoint?.includeEvents === true ||
    (definition.executionLog?.eventHistory !== undefined &&
      definition.executionLog.eventHistory !== "none")
  );
}
