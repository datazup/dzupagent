import type {
  FlowNode,
  SpddImportSourcesNode,
  SpddBuildSourcePackNode,
  SpddRunAnalysisNode,
} from "../../types.js";
import { validateCommonNodeFields } from "../shared.js";
import type { SchemaIssue } from "../shared.js";
import { requireArray, requireString } from "./helpers.js";

export function validateSpddImportSources(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.import_sources",
    issues
  );
  const sourceRefs = requireArray(
    obj,
    path,
    "sourceRefs",
    "spdd.import_sources",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.import_sources",
    issues
  );
  if (spddRunId === null || sourceRefs === null || outputKey === null)
    return null;
  const node: SpddImportSourcesNode = {
    type: "spdd.import_sources",
    ...common,
    spddRunId,
    sourceRefs,
    outputKey,
  };
  return node;
}

export function validateSpddBuildSourcePack(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.build_source_pack",
    issues
  );
  const sourceRefsKey = requireString(
    obj,
    path,
    "sourceRefsKey",
    "spdd.build_source_pack",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.build_source_pack",
    issues
  );
  if (spddRunId === null || sourceRefsKey === null || outputKey === null)
    return null;
  const node: SpddBuildSourcePackNode = {
    type: "spdd.build_source_pack",
    ...common,
    spddRunId,
    sourceRefsKey,
    outputKey,
  };
  if (typeof obj["featureId"] === "string") node.featureId = obj["featureId"];
  return node;
}

export function validateSpddRunAnalysis(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.run_analysis",
    issues
  );
  const planArtifactId = requireString(
    obj,
    path,
    "planArtifactId",
    "spdd.run_analysis",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.run_analysis",
    issues
  );
  if (spddRunId === null || planArtifactId === null || outputKey === null)
    return null;
  const node: SpddRunAnalysisNode = {
    type: "spdd.run_analysis",
    ...common,
    spddRunId,
    planArtifactId,
    outputKey,
  };
  if (Array.isArray(obj["sourceArtifactIds"])) {
    node.sourceArtifactIds = obj["sourceArtifactIds"] as string[];
  }
  return node;
}
