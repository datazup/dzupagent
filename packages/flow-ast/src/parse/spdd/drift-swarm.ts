import type {
  SpddScanDriftNode,
  SpddCreateSyncProposalNode,
  SpddAgentSwarmNode,
} from "../../types.js";
import { type ParseContext, parseCommonNodeFields } from "../shared.js";
import { requireStringField, requireSubTasksField } from "./field-helpers.js";

export function parseSpddScanDrift(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddScanDriftNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.scan_drift",
    pointer,
    ctx
  );
  const promptAssetVersionId = requireStringField(
    obj,
    "promptAssetVersionId",
    "spdd.scan_drift",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.scan_drift",
    pointer,
    ctx
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  return {
    type: "spdd.scan_drift",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
}

export function parseSpddCreateSyncProposal(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddCreateSyncProposalNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.create_sync_proposal",
    pointer,
    ctx
  );
  const driftFindingIdsKey = requireStringField(
    obj,
    "driftFindingIdsKey",
    "spdd.create_sync_proposal",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.create_sync_proposal",
    pointer,
    ctx
  );
  if (spddRunId === null || driftFindingIdsKey === null || outputKey === null)
    return null;
  return {
    type: "spdd.create_sync_proposal",
    ...common,
    spddRunId,
    driftFindingIdsKey,
    outputKey,
  };
}

export function parseSpddAgentSwarm(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddAgentSwarmNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.agent_swarm",
    pointer,
    ctx
  );
  const subTasks = requireSubTasksField(obj, "spdd.agent_swarm", pointer, ctx);
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.agent_swarm",
    pointer,
    ctx
  );
  if (spddRunId === null || subTasks === null || outputKey === null)
    return null;
  return {
    type: "spdd.agent_swarm",
    ...common,
    spddRunId,
    subTasks,
    outputKey,
  };
}
