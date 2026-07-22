import type {
  FlowNode,
  SpddScanDriftNode,
  SpddCreateSyncProposalNode,
  SpddAgentSwarmNode,
} from "../../types.js";
import { validateCommonNodeFields } from "../shared.js";
import type { SchemaIssue } from "../shared.js";
import { requireString, requireSubTasks } from "./helpers.js";

export function validateSpddScanDrift(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.scan_drift",
    issues
  );
  const promptAssetVersionId = requireString(
    obj,
    path,
    "promptAssetVersionId",
    "spdd.scan_drift",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.scan_drift",
    issues
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  const node: SpddScanDriftNode = {
    type: "spdd.scan_drift",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
  return node;
}

export function validateSpddCreateSyncProposal(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.create_sync_proposal",
    issues
  );
  const driftFindingIdsKey = requireString(
    obj,
    path,
    "driftFindingIdsKey",
    "spdd.create_sync_proposal",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.create_sync_proposal",
    issues
  );
  if (spddRunId === null || driftFindingIdsKey === null || outputKey === null)
    return null;
  const node: SpddCreateSyncProposalNode = {
    type: "spdd.create_sync_proposal",
    ...common,
    spddRunId,
    driftFindingIdsKey,
    outputKey,
  };
  return node;
}

export function validateSpddAgentSwarm(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.agent_swarm",
    issues
  );
  const subTasks = requireSubTasks(obj, path, "spdd.agent_swarm", issues);
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.agent_swarm",
    issues
  );
  if (spddRunId === null || subTasks === null || outputKey === null)
    return null;
  const node: SpddAgentSwarmNode = {
    type: "spdd.agent_swarm",
    ...common,
    spddRunId,
    subTasks,
    outputKey,
  };
  return node;
}
