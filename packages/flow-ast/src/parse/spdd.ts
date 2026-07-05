import type {
  FlowNode,
  SpddSourceRef,
} from "../types.js";
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";

type SpddNodeType = Extract<FlowNode["type"], `spdd.${string}`>;
type SpddNode = Extract<FlowNode, { type: SpddNodeType }>;

function requiredString(
  obj: Record<string, unknown>,
  key: string,
  kind: string,
  pointer: string,
  ctx: ParseContext
): string | undefined {
  const value = obj[key];
  if (typeof value === "string" && value.length > 0) return value;
  ctx.errors.push({
    code: "WRONG_FIELD_TYPE",
    message: `${kind}.${key} must be a non-empty string, received ${describeJsType(
      value
    )}`,
    pointer: joinPointer(pointer, key),
  });
  return undefined;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  kind: string,
  pointer: string,
  ctx: ParseContext
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  ctx.errors.push({
    code: "WRONG_FIELD_TYPE",
    message: `${kind}.${key} must be a string when present, received ${describeJsType(
      value
    )}`,
    pointer: joinPointer(pointer, key),
  });
  return undefined;
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  kind: string,
  pointer: string,
  ctx: ParseContext
): string[] | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  ctx.errors.push({
    code: "WRONG_FIELD_TYPE",
    message: `${kind}.${key} must be a string array when present, received ${describeJsType(
      value
    )}`,
    pointer: joinPointer(pointer, key),
  });
  return undefined;
}

function requiredSourceRefs(
  obj: Record<string, unknown>,
  kind: string,
  pointer: string,
  ctx: ParseContext
): SpddSourceRef[] | undefined {
  const value = obj.sourceRefs;
  if (Array.isArray(value)) {
    const sourceRefs: SpddSourceRef[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        sourceRefs.push(item as SpddSourceRef);
        continue;
      }
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: `${kind}.sourceRefs items must be objects, received ${describeJsType(
          item
        )}`,
        pointer: joinPointer(joinPointer(pointer, "sourceRefs"), String(i)),
      });
      return undefined;
    }
    return sourceRefs;
  }
  ctx.errors.push({
    code: "EXPECTED_ARRAY",
    message: `${kind}.sourceRefs must be an array, received ${describeJsType(
      value
    )}`,
    pointer: joinPointer(pointer, "sourceRefs"),
  });
  return undefined;
}

export function parseSpddNode(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddNode | null {
  const kind = obj.type as SpddNodeType;
  const spddRunId = requiredString(obj, "spddRunId", kind, pointer, ctx);
  const outputKey = requiredString(obj, "outputKey", kind, pointer, ctx);
  if (!spddRunId || !outputKey) return null;
  const common = parseCommonNodeFields(obj, pointer, ctx);

  switch (kind) {
    case "spdd.import_sources": {
      const sourceRefs = requiredSourceRefs(obj, kind, pointer, ctx);
      if (!sourceRefs) return null;
      return {
        type: "spdd.import_sources",
        ...common,
        spddRunId,
        sourceRefs,
        outputKey,
      };
    }
    case "spdd.build_source_pack": {
      const sourceRefsKey = requiredString(
        obj,
        "sourceRefsKey",
        kind,
        pointer,
        ctx
      );
      if (!sourceRefsKey) return null;
      const featureId = optionalString(obj, "featureId", kind, pointer, ctx);
      return featureId === undefined
        ? {
            type: "spdd.build_source_pack",
            ...common,
            spddRunId,
            sourceRefsKey,
            outputKey,
          }
        : {
            type: "spdd.build_source_pack",
            ...common,
            spddRunId,
            sourceRefsKey,
            outputKey,
            featureId,
          };
    }
    case "spdd.generate_canvas":
    case "spdd.project_plan":
    case "spdd.review_canvas":
    case "spdd.scan_drift":
    case "spdd.validate_canvas": {
      const promptAssetVersionId = requiredString(
        obj,
        "promptAssetVersionId",
        kind,
        pointer,
        ctx
      );
      if (!promptAssetVersionId) return null;
      if (kind === "spdd.generate_canvas") {
        const title = optionalString(obj, "title", kind, pointer, ctx);
        const objective = optionalString(obj, "objective", kind, pointer, ctx);
        return {
          type: "spdd.generate_canvas",
          ...common,
          spddRunId,
          promptAssetVersionId,
          outputKey,
          ...(title === undefined ? {} : { title }),
          ...(objective === undefined ? {} : { objective }),
        };
      }
      return {
        type: kind,
        ...common,
        spddRunId,
        promptAssetVersionId,
        outputKey,
      };
    }
    case "spdd.run_analysis": {
      const planArtifactId = requiredString(
        obj,
        "planArtifactId",
        kind,
        pointer,
        ctx
      );
      if (!planArtifactId) return null;
      const sourceArtifactIds = optionalStringArray(
        obj,
        "sourceArtifactIds",
        kind,
        pointer,
        ctx
      );
      return sourceArtifactIds === undefined
        ? {
            type: "spdd.run_analysis",
            ...common,
            spddRunId,
            planArtifactId,
            outputKey,
          }
        : {
            type: "spdd.run_analysis",
            ...common,
            spddRunId,
            planArtifactId,
            outputKey,
            sourceArtifactIds,
          };
    }
    case "spdd.arm_dispatch": {
      const planRunId = requiredString(obj, "planRunId", kind, pointer, ctx);
      if (!planRunId) return null;
      return {
        type: "spdd.arm_dispatch",
        ...common,
        spddRunId,
        planRunId,
        outputKey,
      };
    }
    case "spdd.run_validation": {
      const planRunId = requiredString(obj, "planRunId", kind, pointer, ctx);
      const executionRunId = requiredString(
        obj,
        "executionRunId",
        kind,
        pointer,
        ctx
      );
      if (!planRunId || !executionRunId) return null;
      return {
        type: "spdd.run_validation",
        ...common,
        spddRunId,
        planRunId,
        executionRunId,
        outputKey,
      };
    }
    case "spdd.collect_proof": {
      const planRunId = requiredString(obj, "planRunId", kind, pointer, ctx);
      if (!planRunId) return null;
      const taskId = optionalString(obj, "taskId", kind, pointer, ctx);
      return taskId === undefined
        ? {
            type: "spdd.collect_proof",
            ...common,
            spddRunId,
            planRunId,
            outputKey,
          }
        : {
            type: "spdd.collect_proof",
            ...common,
            spddRunId,
            planRunId,
            outputKey,
            taskId,
          };
    }
    case "spdd.create_sync_proposal": {
      const driftFindingIdsKey = requiredString(
        obj,
        "driftFindingIdsKey",
        kind,
        pointer,
        ctx
      );
      if (!driftFindingIdsKey) return null;
      return {
        type: "spdd.create_sync_proposal",
        ...common,
        spddRunId,
        driftFindingIdsKey,
        outputKey,
      };
    }
    default:
      return null;
  }
}
