/**
 * Checkpoint serialization helpers — pure functions that convert runtime
 * events and node results into the serializable shapes persisted in a
 * {@link PipelineCheckpoint}, plus the execution-log snapshot and retention
 * side-effects that run alongside a checkpoint save.
 *
 * Extracted from `pipeline-executor.ts` so the executor stays focused on the
 * graph-walk dispatch flow. These are file-private helpers of the executor's
 * checkpoint-writing routines; nothing outside the pipeline runtime should
 * depend on them.
 *
 * @module pipeline/pipeline-runtime/checkpoint-serialization
 */

import type {
  PipelineCheckpoint,
  PipelineCheckpointEventRecord,
  PipelineCheckpointExecutionLog,
  PipelineCheckpointProviderSessionRef,
  PipelineCheckpointRetentionPolicy,
  PipelineCheckpointStore,
} from "@dzupagent/core/pipeline";
import type {
  NodeResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from "../pipeline-runtime-types.js";

export function checkpointEvents(
  config: PipelineRuntimeConfig,
  eventLog: PipelineRuntimeEvent[],
  savedEvent: PipelineRuntimeEvent
): PipelineCheckpointEventRecord[] | undefined {
  if (config.definition.checkpoint?.includeEvents !== true) return undefined;
  return [...eventLog, savedEvent].map(toCheckpointEventRecord);
}

export function checkpointExecutionLog(
  config: PipelineRuntimeConfig,
  eventLog: PipelineRuntimeEvent[],
  savedEvent: PipelineRuntimeEvent
): PipelineCheckpointExecutionLog | undefined {
  const policy = config.definition.executionLog;
  if (!policy?.eventHistory || policy.eventHistory === "none") return undefined;

  const checkpointLog = [...eventLog, savedEvent];
  const events =
    policy.eventHistory === "compact"
      ? checkpointLog.filter(isCompactExecutionLogEvent)
      : checkpointLog;

  return {
    ...(policy.storeRef !== undefined ? { storeRef: policy.storeRef } : {}),
    eventHistory: policy.eventHistory,
    events: events.map(toCheckpointEventRecord),
  };
}

export function checkpointProviderSessionRefs(
  config: PipelineRuntimeConfig,
  nodeResults: Map<string, NodeResult>
): PipelineCheckpointProviderSessionRef[] | undefined {
  if (config.definition.checkpoint?.includeProviderSessionRefs !== true) {
    return undefined;
  }

  const refs: PipelineCheckpointProviderSessionRef[] = [];
  for (const result of nodeResults.values()) {
    for (const ref of result.providerSessionRefs ?? []) {
      refs.push({
        nodeId: result.nodeId,
        provider: ref.provider,
        sessionId: ref.sessionId,
        ...(ref.label !== undefined ? { label: ref.label } : {}),
        ...(ref.metadata !== undefined
          ? { metadata: structuredClone(ref.metadata) }
          : {}),
      });
    }
  }

  return refs.length > 0 ? refs : undefined;
}

export function toCheckpointEventRecord(
  event: PipelineRuntimeEvent
): PipelineCheckpointEventRecord {
  return structuredClone(event) as PipelineCheckpointEventRecord;
}

export function isCompactExecutionLogEvent(
  event: PipelineRuntimeEvent
): boolean {
  return (
    event.type === "pipeline:started" ||
    event.type === "pipeline:suspended" ||
    event.type === "pipeline:completed" ||
    event.type === "pipeline:failed" ||
    event.type === "pipeline:node_completed" ||
    event.type === "pipeline:checkpoint_saved"
  );
}

export async function appendExecutionLogSnapshot(
  config: PipelineRuntimeConfig,
  checkpoint: PipelineCheckpoint
): Promise<void> {
  const executionLog = checkpoint.executionLog;
  if (!executionLog?.storeRef) return;
  const store = config.executionLogStores?.[executionLog.storeRef];
  if (!store) return;
  await store.append({
    pipelineRunId: checkpoint.pipelineRunId,
    pipelineId: checkpoint.pipelineId,
    checkpointVersion: checkpoint.version,
    ...executionLog,
    ...(checkpoint.providerSessionRefs !== undefined
      ? { providerSessionRefs: checkpoint.providerSessionRefs }
      : {}),
  });
}

export async function applyCheckpointRetention(
  store: PipelineCheckpointStore,
  runId: string,
  retention: PipelineCheckpointRetentionPolicy | undefined
): Promise<void> {
  if (!retention) return;
  if (retention.ttlMs !== undefined) {
    await store.prune(retention.ttlMs);
  }
  if (retention.maxVersions !== undefined) {
    await store.pruneVersions?.(runId, retention.maxVersions);
  }
}
