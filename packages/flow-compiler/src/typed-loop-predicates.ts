/**
 * Typed-loop predicate registration (F-R4 runtime join).
 *
 * `lowerTypedLoop` emits a `LoopNode` carrying the canonical typed condition
 * as its `typedWhile` compile-time contract, and names a continue predicate
 * `loopTyped__<node>__predicate` that it deliberately does NOT register. That
 * indirection is the fail-closed seam: a host without a reviewed evaluator
 * never resolves the name, so `executeLoop` throws instead of iterating on
 * semantics it cannot evaluate.
 *
 * This module is the sanctioned way to close that seam. It lives in
 * flow-compiler because it is the only package depending on both `flow-ast`
 * (which owns the reviewed evaluator) and `core` (which owns the artifact
 * types) — `@dzupagent/agent` and `@dzupagent/core` must not depend on
 * flow-ast, so the contract keeps `condition` structural and the bridge is
 * assembled here.
 *
 * The host must still explicitly advertise the typed-condition capability;
 * this module does not grant it on the host's behalf.
 *
 * @module typed-loop-predicates
 */

import {
  FLOW_TYPED_CONDITION_CAPABILITY,
  evaluateFlowTypedCondition,
} from "@dzupagent/flow-ast/typed-condition-evaluator";
import type { LoopNode, PipelineNode } from "@dzupagent/core/pipeline";

export { FLOW_TYPED_CONDITION_CAPABILITY };

/**
 * Raised when a registered typed-loop predicate cannot decide continuation.
 *
 * Continuation is a binary decision with no safe default: continuing on an
 * unevaluated condition commits another iteration's effects, and stopping
 * silently reports convergence that never happened. Both are wrong, so the
 * predicate throws and lets the loop fail closed.
 */
export class TypedLoopPredicateError extends Error {
  readonly nodeId: string;
  readonly predicateName: string;
  readonly code: string;
  readonly path: string;

  constructor(options: {
    nodeId: string;
    predicateName: string;
    code: string;
    message: string;
    path: string;
  }) {
    super(
      `Typed loop "${options.nodeId}" could not evaluate its condition ` +
        `(${options.code} at ${options.path}): ${options.message}`
    );
    this.name = "TypedLoopPredicateError";
    this.nodeId = options.nodeId;
    this.predicateName = options.predicateName;
    this.code = options.code;
    this.path = options.path;
  }
}

/** A continue predicate as `executeLoop` consumes it. */
export type TypedLoopPredicate = (state: Record<string, unknown>) => boolean;

export interface RegisterTypedLoopPredicateOptions {
  /**
   * Capabilities explicitly owned by the calling host. Must include
   * `FLOW_TYPED_CONDITION_CAPABILITY` for evaluation to be admitted — this
   * module never advertises it on the host's behalf.
   */
  readonly hostCapabilities: readonly string[];
}

/**
 * Build the continue predicates for every typed-condition loop in an artifact.
 *
 * Returns a registry keyed by `continuePredicateName`, ready to merge into the
 * `predicates` map a `PipelineRuntime` is constructed with. Nodes without a
 * `typedWhile` contract are skipped: legacy string-condition loops keep their
 * existing registration path, and `forEach` loops never consult a predicate.
 *
 * Each predicate reads loop state as the evaluator's bindings, so a condition
 * observes exactly the state the runtime accumulated for that iteration.
 */
export function createTypedLoopPredicates(
  nodes: readonly PipelineNode[],
  options: RegisterTypedLoopPredicateOptions
): Record<string, TypedLoopPredicate> {
  const predicates: Record<string, TypedLoopPredicate> = {};
  for (const node of nodes) {
    if (node.type !== "loop") continue;
    const loopNode = node as LoopNode;
    const typedWhile = loopNode.typedWhile;
    if (typedWhile === undefined) continue;

    predicates[loopNode.continuePredicateName] = createTypedLoopPredicate(
      loopNode,
      options
    );
  }
  return predicates;
}

/**
 * Build the continue predicate for a single typed-condition loop node.
 *
 * Exported for hosts registering one loop at a time; `createTypedLoopPredicates`
 * is the usual entry point.
 */
export function createTypedLoopPredicate(
  loopNode: LoopNode,
  options: RegisterTypedLoopPredicateOptions
): TypedLoopPredicate {
  const typedWhile = loopNode.typedWhile;
  if (typedWhile === undefined) {
    throw new Error(
      `createTypedLoopPredicate: loop "${loopNode.id}" carries no typedWhile contract`
    );
  }

  // Reassemble the canonical typed condition from the structural contract the
  // artifact carries. `core` cannot name flow-ast's types, so `condition` rides
  // as a plain record and is re-validated by the evaluator on every call.
  const condition = {
    schema: typedWhile.conditionSchema,
    expression: typedWhile.condition,
  };

  return (state: Record<string, unknown>): boolean => {
    const result = evaluateFlowTypedCondition(condition, {
      hostCapabilities: options.hostCapabilities,
      bindings: state,
    });
    if (false) { // MUTANT
      throw new TypedLoopPredicateError({
        nodeId: loopNode.id,
        predicateName: loopNode.continuePredicateName,
        code: result.code,
        message: result.message,
        path: result.path,
      });
    }
    return result.value;
  };
}
