/**
 * walk.ts — AST walk + recursing variant walkers for the skill-chain lowerer.
 *
 * `walkNode` is the recursive dispatcher; the variant walkers in this module
 * (branch / parallel / approval / persona / route) descend into child node
 * slices and therefore call back into `walkNode`, so they are co-located to
 * keep the mutual recursion within a single module. Non-recursing leaves
 * (action, clarification, complete, memory) live in sibling leaf modules.
 *
 * @module lower/lower-skill-chain/walk
 */

import type {
  ApprovalNode,
  BranchNode,
  FlowNode,
  ParallelNode,
  PersonaNode,
  ResolvedTool,
  RouteNode,
} from "@dzupagent/flow-ast";
import type { SkillChainStep } from "@dzupagent/core/pipeline";
import type { LoweringMode } from "../_shared.js";
import { lowerAction } from "./action.js";
import {
  walkClarification,
  walkComplete,
  walkMemory,
} from "./synthetic-steps.js";

// ---------------------------------------------------------------------------
// AST walk
// ---------------------------------------------------------------------------

export function walkNode(
  node: FlowNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  mode: LoweringMode,
  steps: SkillChainStep[],
  warnings: string[]
): void {
  switch (node.type) {
    case "sequence": {
      if (node.nodes.length === 1) {
        warnings.push(
          `Redundant single-child sequence wrapper at "${path}" — consider inlining the child node.`
        );
      }
      for (let i = 0; i < node.nodes.length; i++) {
        const child = node.nodes[i];
        // noUncheckedIndexedAccess: child may be undefined (index out of bounds).
        // In practice this cannot happen because i < node.nodes.length, but we
        // must satisfy the compiler.
        if (child === undefined) continue;
        walkNode(child, `${path}.nodes[${i}]`, resolved, mode, steps, warnings);
      }
      return;
    }

    case "action": {
      const step = lowerAction(node, path, resolved, mode, warnings);
      steps.push(step);
      return;
    }

    case "branch": {
      walkBranch(node, path, resolved, mode, steps, warnings);
      return;
    }

    case "parallel": {
      walkParallel(node, path, resolved, mode, steps, warnings);
      return;
    }

    case "approval": {
      walkApproval(node, path, resolved, mode, steps, warnings);
      return;
    }

    case "clarification": {
      walkClarification(node, path, steps, warnings);
      return;
    }

    case "persona": {
      walkPersona(node, path, resolved, mode, steps, warnings);
      return;
    }

    case "route": {
      walkRoute(node, path, resolved, mode, steps, warnings);
      return;
    }

    case "complete": {
      walkComplete(node, path, warnings);
      return;
    }

    case "for_each": {
      // Router contract violated — for_each is pipeline-only per ADR.
      throw new Error(
        `lowerSkillChain: for_each node encountered at "${path}". ` +
          `for_each is a pipeline-only variant; the router must dispatch such ASTs to the pipeline-loop target.`
      );
    }

    case "spawn":
    case "classify":
    case "emit":
    case "checkpoint":
    case "restore":
    case "http":
    case "wait":
    case "subflow":
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "knowledge.write":
    case "knowledge.query":
    case "worker.dispatch":
    case "shell.run":
    case "evidence.write":
    case "validate.schema":
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor":
    case "spdd.import_sources":
    case "spdd.build_source_pack":
    case "spdd.run_analysis":
    case "spdd.generate_canvas":
    case "spdd.validate_canvas":
    case "spdd.review_canvas":
    case "spdd.project_plan":
    case "spdd.arm_dispatch":
    case "spdd.run_validation":
    case "spdd.collect_proof":
    case "spdd.scan_drift":
    case "spdd.create_sync_proposal":
    case "spdd.agent_swarm": {
      // Runtime-executed nodes — no skill-chain step emitted; silently pass through.
      return;
    }

    case "memory": {
      walkMemory(node, path, steps);
      return;
    }

    case "try_catch": {
      for (let i = 0; i < node.body.length; i++) {
        const child = node.body[i];
        if (child !== undefined)
          walkNode(
            child,
            `${path}.body[${i}]`,
            resolved,
            mode,
            steps,
            warnings
          );
      }
      for (let i = 0; i < node.catch.length; i++) {
        const child = node.catch[i];
        if (child !== undefined)
          walkNode(
            child,
            `${path}.catch[${i}]`,
            resolved,
            mode,
            steps,
            warnings
          );
      }
      return;
    }

    case "loop": {
      for (let i = 0; i < node.body.length; i++) {
        const child = node.body[i];
        if (child !== undefined)
          walkNode(
            child,
            `${path}.body[${i}]`,
            resolved,
            mode,
            steps,
            warnings
          );
      }
      return;
    }

    case "prompt":
    case "return_to":
    case "agent":
    case "validate":
    case "set":
      return;

    default: {
      // Exhaustiveness guard — adding a FlowNode variant without a case fails here.
      const _exhaustive: never = node;
      void _exhaustive;
      throw new Error(
        `lowerSkillChain: unexpected node type "${
          (node as FlowNode).type
        }" at "${path}".`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Recursing variant walkers (best-effort degradation)
// ---------------------------------------------------------------------------

/**
 * branch → linear concatenation of `then` followed by `else` bodies.
 *
 * Skill chains have no conditional-dispatch primitive that takes a string
 * predicate (SkillChainStep.condition is a runtime callback). We therefore
 * emit both bodies inline and warn — the runtime predicate in `node.condition`
 * is lost.
 */
function walkBranch(
  node: BranchNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  mode: LoweringMode,
  steps: SkillChainStep[],
  warnings: string[]
): void {
  warnings.push(
    `Branch at "${path}" (condition="${node.condition}") lowered as sequential then+else — ` +
      `skill-chain has no native conditional dispatch; predicate is dropped.`
  );

  for (let i = 0; i < node.then.length; i++) {
    const child = node.then[i];
    if (child === undefined) continue;
    walkNode(child, `${path}.then[${i}]`, resolved, mode, steps, warnings);
  }

  if (node.else !== undefined) {
    for (let i = 0; i < node.else.length; i++) {
      const child = node.else[i];
      if (child === undefined) continue;
      walkNode(child, `${path}.else[${i}]`, resolved, mode, steps, warnings);
    }
  }
}

/**
 * parallel → sequential concatenation of all branches.
 *
 * Skill chains are linear; parallelism is lost. Each branch is walked in order.
 */
function walkParallel(
  node: ParallelNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  mode: LoweringMode,
  steps: SkillChainStep[],
  warnings: string[]
): void {
  warnings.push(
    `Parallel at "${path}" with ${node.branches.length} branches lowered as sequential — ` +
      `skill-chain has no fork/join; branches will run in order.`
  );

  for (let bIdx = 0; bIdx < node.branches.length; bIdx++) {
    const branch = node.branches[bIdx];
    if (branch === undefined) continue;
    for (let i = 0; i < branch.length; i++) {
      const child = branch[i];
      if (child === undefined) continue;
      walkNode(
        child,
        `${path}.branches[${bIdx}][${i}]`,
        resolved,
        mode,
        steps,
        warnings
      );
    }
  }
}

/**
 * approval → onApprove body with `suspendBefore: true` on the first step.
 *
 * The onReject body cannot be represented on the main linear chain and is
 * dropped with a warning.
 */
function walkApproval(
  node: ApprovalNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  mode: LoweringMode,
  steps: SkillChainStep[],
  warnings: string[]
): void {
  const before = steps.length;

  for (let i = 0; i < node.onApprove.length; i++) {
    const child = node.onApprove[i];
    if (child === undefined) continue;
    walkNode(child, `${path}.onApprove[${i}]`, resolved, mode, steps, warnings);
  }

  // Mark the first newly-appended approval step for HITL suspension.
  if (steps.length > before) {
    const first = steps[before];
    if (first !== undefined) {
      steps[before] = { ...first, suspendBefore: true };
    }
  } else {
    warnings.push(
      `Approval at "${path}" (question="${node.question}") produced no onApprove steps — suspend hint skipped.`
    );
  }

  if (node.onReject !== undefined && node.onReject.length > 0) {
    warnings.push(
      `Approval at "${path}" onReject body dropped — skill-chain cannot express branch-on-rejection; ` +
        `${node.onReject.length} reject step(s) lost.`
    );
  }
}

/**
 * persona → body inlined; persona metadata dropped.
 */
function walkPersona(
  node: PersonaNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  mode: LoweringMode,
  steps: SkillChainStep[],
  warnings: string[]
): void {
  warnings.push(
    `Persona "${node.personaId}" at "${path}" lowered as inline body — ` +
      `skill-chain cannot carry persona binding metadata.`
  );

  for (let i = 0; i < node.body.length; i++) {
    const child = node.body[i];
    if (child === undefined) continue;
    walkNode(child, `${path}.body[${i}]`, resolved, mode, steps, warnings);
  }
}

/**
 * route → body inlined; routing metadata dropped.
 */
function walkRoute(
  node: RouteNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  mode: LoweringMode,
  steps: SkillChainStep[],
  warnings: string[]
): void {
  const meta = node.provider ?? node.tags?.join(",") ?? node.strategy;
  warnings.push(
    `Route (strategy="${node.strategy}", meta="${meta}") at "${path}" lowered as inline body — ` +
      `skill-chain cannot carry routing metadata.`
  );

  for (let i = 0; i < node.body.length; i++) {
    const child = node.body[i];
    if (child === undefined) continue;
    walkNode(child, `${path}.body[${i}]`, resolved, mode, steps, warnings);
  }
}
