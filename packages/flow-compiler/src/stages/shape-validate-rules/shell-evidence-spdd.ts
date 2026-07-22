import {
  isNonEmptyString,
  isPlainObject,
  missing,
  type ShapeRulePartial,
} from "../shape-validate-shared.js";

/**
 * Structural rules for the shell / evidence / schema-validation leaf kinds plus
 * the SPDD workflow node kinds (spdd.*). These are all leaves for traversal
 * purposes (no child slices). The SPDD kinds carry no structural required
 * fields at Stage 2 — their per-node parsing/validation lives in
 * `@dzupagent/flow-ast` (parse/spdd, validate/spdd) — so their rules are
 * intentional no-ops here, present only to satisfy the exhaustive
 * `ShapeRuleTable`. Split out of `shape-validate-rules.ts` for the ARCH-M-06 /
 * MJ-01 god-module decomposition.
 *
 * Pure refactor: behaviour (defect codes, messages) is unchanged.
 */
export type ShellEvidenceSpddKind =
  | "shell.run"
  | "evidence.write"
  | "validate.schema"
  | "spdd.import_sources"
  | "spdd.build_source_pack"
  | "spdd.run_analysis"
  | "spdd.generate_canvas"
  | "spdd.validate_canvas"
  | "spdd.review_canvas"
  | "spdd.project_plan"
  | "spdd.arm_dispatch"
  | "spdd.run_validation"
  | "spdd.collect_proof"
  | "spdd.scan_drift"
  | "spdd.create_sync_proposal"
  | "spdd.agent_swarm";

export const shellEvidenceSpddValidators: ShapeRulePartial<ShellEvidenceSpddKind> =
  {
    "shell.run": (node, { path, errors }) => {
      if (!isNonEmptyString(node.command)) {
        errors.push(
          missing(
            node.type,
            path,
            "shell.run.command is required (non-empty string)"
          )
        );
      }
      if (!isNonEmptyString(node.output)) {
        errors.push(
          missing(
            node.type,
            path,
            "shell.run.output is required (non-empty string)"
          )
        );
      }
    },
    "evidence.write": (node, { path, errors }) => {
      if (!isNonEmptyString(node.source)) {
        errors.push(
          missing(
            node.type,
            path,
            "evidence.write.source is required (non-empty string)"
          )
        );
      }
      if (!isNonEmptyString(node.output)) {
        errors.push(
          missing(
            node.type,
            path,
            "evidence.write.output is required (non-empty string)"
          )
        );
      }
    },
    "validate.schema": (node, { path, errors }) => {
      if (!isNonEmptyString(node.source)) {
        errors.push(
          missing(
            node.type,
            path,
            "validate.schema.source is required (non-empty string)"
          )
        );
      }
      if (!isNonEmptyString(node.output)) {
        errors.push(
          missing(
            node.type,
            path,
            "validate.schema.output is required (non-empty string)"
          )
        );
      }
      if (!isNonEmptyString(node.schema) && !isPlainObject(node.schema)) {
        errors.push(
          missing(
            node.type,
            path,
            "validate.schema.schema is required (schema ref string or object)"
          )
        );
      }
    },
    "spdd.import_sources": () => {},
    "spdd.build_source_pack": () => {},
    "spdd.run_analysis": () => {},
    "spdd.generate_canvas": () => {},
    "spdd.validate_canvas": () => {},
    "spdd.review_canvas": () => {},
    "spdd.project_plan": () => {},
    "spdd.arm_dispatch": () => {},
    "spdd.run_validation": () => {},
    "spdd.collect_proof": () => {},
    "spdd.scan_drift": () => {},
    "spdd.create_sync_proposal": () => {},
    "spdd.agent_swarm": () => {},
  };
