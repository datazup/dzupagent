import {
  isNonEmptyString,
  isPlainObject,
  missing,
  type ShapeRulePartial,
} from "./shape-validate-shared.js";

/**
 * Structural rules for the distributed / multi-agent / adapter execution node
 * kinds (fleet.*, knowledge.*, worker.dispatch, adapter.*). Split out of
 * `shape-validate-rules.ts` for the RF-9 500-LOC ceiling. These nodes are all
 * leaves for traversal purposes (no child slices), so their rules only emit
 * MISSING_REQUIRED_FIELD defects.
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
  | "adapter.supervisor";

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
};
