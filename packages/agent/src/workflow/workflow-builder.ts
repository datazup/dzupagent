/**
 * Fluent workflow builder for general-purpose multi-step agent pipelines.
 *
 * Supports sequential steps, parallel fan-out/merge, conditional branching,
 * and suspend/resume for human-in-the-loop flows.
 *
 * The builder compiles workflow nodes into a canonical `PipelineDefinition`
 * and executes via `PipelineRuntime` (see {@link CompiledWorkflow}).
 *
 * @example
 * ```ts
 * const workflow = createWorkflow({ id: 'feature-gen' })
 *   .then(planStep)
 *   .suspend('plan_review')
 *   .parallel([genBackend, genFrontend, genTests])
 *   .then(validateStep)
 *   .branch(
 *     (s) => s.valid ? 'publish' : 'fix',
 *     { publish: [publishStep], fix: [fixStep, validateStep] }
 *   )
 *   .build()
 *
 * const result = await workflow.run({ spec: '...' })
 * ```
 */
import type {
  WorkflowStep,
  WorkflowNode,
  MergeStrategy,
} from "./workflow-types.js";
import type {
  WorkflowConfig,
  WorkflowErrorHandler,
} from "./workflow-builder-types.js";
import { CompiledWorkflow } from "./compiled-workflow.js";

// Re-export public config types so existing consumers of this module keep working.
export type {
  WorkflowConfig,
  WorkflowErrorHandler,
} from "./workflow-builder-types.js";
// Re-export the compiled workflow class to preserve the original public surface.
export { CompiledWorkflow } from "./compiled-workflow.js";

export class WorkflowBuilder {
  private nodes: WorkflowNode[] = [];
  private readonly errorHandlers: WorkflowErrorHandler[] = [];

  constructor(private config: WorkflowConfig) {}

  /** Add a sequential step */
  then(step: WorkflowStep): this {
    this.nodes.push({ type: "step", step });
    return this;
  }

  /**
   * Register a recovery sub-graph for errors that match `predicate`.
   *
   * Handlers are evaluated in registration order; the first match wins. If
   * no handler matches the original error is re-thrown and the workflow
   * fails. Handlers apply to all step and parallel nodes in the workflow.
   */
  onError(
    predicate: (err: Error) => boolean,
    recoverySteps: WorkflowStep[]
  ): this {
    this.errorHandlers.push({ predicate, recoverySteps });
    return this;
  }

  /** Run multiple steps in parallel and merge results */
  parallel(steps: WorkflowStep[], mergeStrategy?: MergeStrategy): this {
    this.nodes.push({
      type: "parallel",
      steps,
      mergeStrategy: mergeStrategy ?? "merge-objects",
    });
    return this;
  }

  /** Conditional branching based on current state */
  branch(
    condition: (state: Record<string, unknown>) => string,
    branches: Record<string, WorkflowStep[]>
  ): this {
    this.nodes.push({ type: "branch", condition, branches });
    return this;
  }

  /** Suspend execution until external resume (human-in-the-loop) */
  suspend(reason: string): this {
    this.nodes.push({ type: "suspend", reason });
    return this;
  }

  // TODO(W8-follow-up): WorkflowBuilder is intentionally minimal (4-surface
  // layering — see roadmap §2.1 + §3 W8 decision). For loops, sub-workflows,
  // dynamic fan-out, and per-step timeoutMs, use flow-dsl directly:
  //   import { loop, subflow, for_each } from '@dzupagent/agent/flow-dsl'
  // WorkflowBuilder will not gain .loop()/.invoke()/.forEach() methods.

  /** Build the workflow into an executable CompiledWorkflow */
  build(): CompiledWorkflow {
    return new CompiledWorkflow(
      this.config,
      [...this.nodes],
      [...this.errorHandlers]
    );
  }
}

/** Factory function for creating workflows */
export function createWorkflow(config: WorkflowConfig): WorkflowBuilder {
  return new WorkflowBuilder(config);
}
