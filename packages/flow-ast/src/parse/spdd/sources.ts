import type {
  SpddImportSourcesNode,
  SpddBuildSourcePackNode,
  SpddRunAnalysisNode,
} from "../../types.js";
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from "../shared.js";
import { requireStringField, requireArrayField } from "./field-helpers.js";

export function parseSpddImportSources(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddImportSourcesNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.import_sources",
    pointer,
    ctx
  );
  const sourceRefs = requireArrayField(
    obj,
    "sourceRefs",
    "spdd.import_sources",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.import_sources",
    pointer,
    ctx
  );
  if (spddRunId === null || sourceRefs === null || outputKey === null)
    return null;
  for (let i = 0; i < sourceRefs.length; i++) {
    const item = sourceRefs[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: `spdd.import_sources.sourceRefs items must be objects, received ${describeJsType(
          item
        )}`,
        pointer: joinPointer(joinPointer(pointer, "sourceRefs"), String(i)),
      });
      return null;
    }
  }
  return {
    type: "spdd.import_sources",
    ...common,
    spddRunId,
    sourceRefs,
    outputKey,
  };
}

export function parseSpddBuildSourcePack(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddBuildSourcePackNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.build_source_pack",
    pointer,
    ctx
  );
  const sourceRefsKey = requireStringField(
    obj,
    "sourceRefsKey",
    "spdd.build_source_pack",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.build_source_pack",
    pointer,
    ctx
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
  if (typeof obj.featureId === "string") node.featureId = obj.featureId;
  return node;
}

export function parseSpddRunAnalysis(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddRunAnalysisNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.run_analysis",
    pointer,
    ctx
  );
  const planArtifactId = requireStringField(
    obj,
    "planArtifactId",
    "spdd.run_analysis",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.run_analysis",
    pointer,
    ctx
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
  if (Array.isArray(obj.sourceArtifactIds)) {
    node.sourceArtifactIds = obj.sourceArtifactIds as string[];
  }
  return node;
}
