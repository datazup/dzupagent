import {
  isNonEmptyString,
  isPlainObject,
  missing,
  type ShapeRulePartial,
} from "./shape-validate-shared.js";

/**
 * Structural rules for distributed / multi-agent / adapter / SPDD execution
 * node kinds. Split out of `shape-validate-rules.ts` for the RF-9 500-LOC
 * ceiling. These nodes are all leaves for traversal purposes (no child
 * slices), so their rules only emit MISSING_REQUIRED_FIELD defects.
 *
 * Pure refactor: behaviour (defect codes, messages) is unchanged.
 */
type DistributedKind =
  | "fleet.dispatch"
  | "fleet.gather"
  | "fleet.contract-net"
  | "knowledge.write"
  | "knowledge.query"
  | "worker.dispatch"
  | "adapter.run"
  | "adapter.race"
  | "adapter.parallel"
  | "adapter.supervisor"
  | "spdd.import_sources"
  | "spdd.build_source_pack"
  | "spdd.project_plan"
  | "spdd.scan_drift"
  | "spdd.run_analysis"
  | "spdd.generate_canvas"
  | "spdd.validate_canvas"
  | "spdd.review_canvas"
  | "spdd.arm_dispatch"
  | "spdd.run_validation"
  | "spdd.collect_proof"
  | "spdd.create_sync_proposal";

function requireString(
  node: { type: DistributedKind },
  path: string,
  errors: Parameters<NonNullable<ShapeRulePartial<DistributedKind>[DistributedKind]>>[1]["errors"],
  field: string
): void {
  if (!isNonEmptyString((node as Record<string, unknown>)[field])) {
    errors.push(
      missing(
        node.type,
        path,
        `${node.type}.${field} is required (non-empty string)`
      )
    );
  }
}

function requireSpddRunAndOutput(
  node: { type: DistributedKind; spddRunId?: unknown; outputKey?: unknown },
  path: string,
  errors: Parameters<NonNullable<ShapeRulePartial<DistributedKind>[DistributedKind]>>[1]["errors"]
): void {
  requireString(node, path, errors, "spddRunId");
  requireString(node, path, errors, "outputKey");
}

export const distributedValidators: ShapeRulePartial<DistributedKind> = {
  "fleet.dispatch": (node, { path, errors }) => {
    if (!isNonEmptyString(node.mode)) {
      errors.push(
        missing(
          node.type,
          path,
          "fleet.dispatch.mode is required (non-empty string)"
        )
      );
    }
    if (!isNonEmptyString(node.repos) && !Array.isArray(node.repos)) {
      errors.push(
        missing(
          node.type,
          path,
          "fleet.dispatch.repos is required (string or array)"
        )
      );
    }
    if (node.task === undefined) {
      errors.push(missing(node.type, path, "fleet.dispatch.task is required"));
    }
  },
  "fleet.gather": (node, { path, errors }) => {
    if (!isNonEmptyString(node.source)) {
      errors.push(
        missing(
          node.type,
          path,
          "fleet.gather.source is required (non-empty string)"
        )
      );
    }
  },
  "fleet.contract-net": (node, { path, errors }) => {
    if (!isNonEmptyString(node.repos) && !Array.isArray(node.repos)) {
      errors.push(
        missing(
          node.type,
          path,
          "fleet.contract-net.repos is required (string or array)"
        )
      );
    }
    if (node.task === undefined) {
      errors.push(
        missing(node.type, path, "fleet.contract-net.task is required")
      );
    }
  },
  "knowledge.write": (node, { path, errors }) => {
    if (!isNonEmptyString(node.scope)) {
      errors.push(
        missing(
          node.type,
          path,
          "knowledge.write.scope is required (non-empty string)"
        )
      );
    }
    if (node.entry === undefined) {
      errors.push(
        missing(node.type, path, "knowledge.write.entry is required")
      );
    }
  },
  "knowledge.query": (node, { path, errors }) => {
    if (!isPlainObject(node.filter)) {
      errors.push(
        missing(node.type, path, "knowledge.query.filter is required (object)")
      );
    }
    if (!isNonEmptyString(node.output)) {
      errors.push(
        missing(
          node.type,
          path,
          "knowledge.query.output is required (non-empty string)"
        )
      );
    }
  },
  "worker.dispatch": (node, { path, errors }) => {
    if (!isNonEmptyString(node.dispatchId)) {
      errors.push(
        missing(
          node.type,
          path,
          "worker.dispatch.dispatchId is required (non-empty string)"
        )
      );
    }
    if (!isNonEmptyString(node.instructions)) {
      errors.push(
        missing(
          node.type,
          path,
          "worker.dispatch.instructions is required (non-empty string)"
        )
      );
    }
    if (!isNonEmptyString(node.outputKey)) {
      errors.push(
        missing(
          node.type,
          path,
          "worker.dispatch.outputKey is required (non-empty string)"
        )
      );
    }
  },
  "adapter.run": (node, { path, errors }) => {
    const hasProvider = isNonEmptyString(node.provider);
    const hasTags = Array.isArray(node.tags) && node.tags.length > 0;
    if (!hasProvider && !hasTags) {
      errors.push(
        missing(node.type, path, "adapter.run requires one of provider or tags")
      );
    }
    if (!isNonEmptyString(node.instructions)) {
      errors.push(
        missing(
          node.type,
          path,
          "adapter.run.instructions is required (non-empty string)"
        )
      );
    }
    if (!isNonEmptyString(node.output)) {
      errors.push(
        missing(
          node.type,
          path,
          "adapter.run.output is required (non-empty string)"
        )
      );
    }
  },
  "adapter.race": (node, { path, errors }) => {
    if (!Array.isArray(node.providers) || node.providers.length < 2) {
      errors.push(
        missing(
          node.type,
          path,
          "adapter.race.providers requires at least 2 providers"
        )
      );
    }
    if (!isNonEmptyString(node.instructions)) {
      errors.push(
        missing(
          node.type,
          path,
          "adapter.race.instructions is required (non-empty string)"
        )
      );
    }
    if (!isNonEmptyString(node.output)) {
      errors.push(
        missing(
          node.type,
          path,
          "adapter.race.output is required (non-empty string)"
        )
      );
    }
  },
  "adapter.parallel": (node, { path, errors }) => {
    if (!Array.isArray(node.providers) || node.providers.length < 2) {
      errors.push(
        missing(
          node.type,
          path,
          "adapter.parallel.providers requires at least 2 providers"
        )
      );
    }
    if (!isNonEmptyString(node.instructions)) {
      errors.push(
        missing(
          node.type,
          path,
          "adapter.parallel.instructions is required (non-empty string)"
        )
      );
    }
    if (!isNonEmptyString(node.output)) {
      errors.push(
        missing(
          node.type,
          path,
          "adapter.parallel.output is required (non-empty string)"
        )
      );
    }
  },
  "adapter.supervisor": (node, { path, errors }) => {
    if (!isNonEmptyString(node.goal)) {
      errors.push(
        missing(
          node.type,
          path,
          "adapter.supervisor.goal is required (non-empty string)"
        )
      );
    }
    if (!isNonEmptyString(node.output)) {
      errors.push(
        missing(
          node.type,
          path,
          "adapter.supervisor.output is required (non-empty string)"
        )
      );
    }
  },
  "spdd.import_sources": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    if (!Array.isArray(node.sourceRefs)) {
      errors.push(
        missing(
          node.type,
          path,
          "spdd.import_sources.sourceRefs is required (array)"
        )
      );
    }
  },
  "spdd.build_source_pack": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "sourceRefsKey");
  },
  "spdd.project_plan": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "promptAssetVersionId");
  },
  "spdd.scan_drift": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "promptAssetVersionId");
  },
  "spdd.run_analysis": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "planArtifactId");
  },
  "spdd.generate_canvas": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "promptAssetVersionId");
  },
  "spdd.validate_canvas": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "promptAssetVersionId");
  },
  "spdd.review_canvas": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "promptAssetVersionId");
  },
  "spdd.arm_dispatch": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "planRunId");
  },
  "spdd.run_validation": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "planRunId");
    requireString(node, path, errors, "executionRunId");
  },
  "spdd.collect_proof": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "planRunId");
  },
  "spdd.create_sync_proposal": (node, { path, errors }) => {
    requireSpddRunAndOutput(node, path, errors);
    requireString(node, path, errors, "driftFindingIdsKey");
  },
};
