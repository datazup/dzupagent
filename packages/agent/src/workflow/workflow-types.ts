/**
 * Types for the general-purpose workflow engine.
 */

/** A single step in a workflow */
export interface WorkflowStep<TInput = unknown, TOutput = unknown> {
  id: string;
  description?: string;
  execute: (input: TInput, ctx: WorkflowContext) => Promise<TOutput>;
}

/** Context passed to each workflow step */
export interface WorkflowContext {
  workflowId: string;
  /** Accumulated state from previous steps */
  state: Record<string, unknown>;
  /** Signal for cancellation */
  signal?: AbortSignal;
}

/** Internal node representation in the workflow graph */
export type WorkflowNode =
  | { type: "step"; step: WorkflowStep }
  | { type: "parallel"; steps: WorkflowStep[]; mergeStrategy: MergeStrategy }
  | {
      type: "branch";
      condition: (state: Record<string, unknown>) => string;
      branches: Record<string, WorkflowStep[]>;
    }
  | { type: "suspend"; reason: string };

// Workflow state merge strategy — see workflow execution
/** Strategy for merging parallel step results in a workflow graph (data shape merge). Not the same as adapter-level MergeStrategy in parallel-executor.ts, which controls response selection across providers. */
export type MergeStrategy = "merge-objects" | "concat-arrays" | "last-wins";

/**
 * A step finished successfully.
 *
 * Named (rather than inlined into {@link WorkflowEvent}) so producers can pin
 * `omitUndefined`'s target type and consumers can refer to the member without
 * an `Extract<...>` dance.
 */
export interface StepCompletedEvent {
  type: "step:completed";
  stepId: string;
  durationMs: number;
  /**
   * The value the step's `execute` returned, verbatim and untruncated.
   *
   * Optional in the `exactOptionalPropertyTypes` sense: producers OMIT the key
   * (via `omitUndefined`) when the step returned `undefined`; they never set it
   * to `undefined`. Consumers therefore read "key absent" as "this step
   * produced no observable output".
   *
   * SIZE: deliberately unbounded. `journal-recorder` mirrors this straight into
   * `StepCompletedEntry.data.output` (declared `unknown` by the core contract).
   * That is not a new exposure: `execution-driver` already writes the entire
   * merged workflow state — a superset of every step output — as
   * `run_completed.data.output`, so a per-step output is strictly smaller than
   * what the same journal already stores for the same run. The repo has no
   * truncation/redaction convention for journal payloads, and inventing one
   * here would silently corrupt `rehydrateMessagesFromJournal`, whose whole job
   * is to replay these values back into a model prompt. Bounding belongs in the
   * journal backend, where the storage limit actually lives.
   */
  output?: unknown;
  /**
   * Human-readable label for the step, taken from `WorkflowStep.description`.
   * Omitted when the step declares no description; every consumer falls back
   * to `stepId`.
   */
  stepName?: string;
}

/** Events emitted during workflow execution */
export type WorkflowEvent =
  | { type: "step:started"; stepId: string }
  | StepCompletedEvent
  | { type: "step:failed"; stepId: string; error: string }
  | { type: "parallel:started"; stepIds: string[] }
  | { type: "parallel:completed"; stepIds: string[]; durationMs: number }
  | { type: "branch:evaluated"; condition: string; selected: string }
  | { type: "suspended"; reason: string }
  | { type: "step:skipped"; stepId: string; reason: string }
  | {
      type: "step:retrying";
      stepId: string;
      attempt: number;
      maxAttempts: number;
      backoffMs: number;
    }
  | { type: "workflow:completed"; durationMs: number }
  | { type: "workflow:failed"; error: string }
  | { type: "workflow:stuck"; nodeId: string; reason: string }
  // ERR-H-10: the durable run journal underpins replay/resume/audit. When a
  // journal write fails (backend down) the entry is lost; this event surfaces
  // that degradation on the caller's own event channel so it is observable
  // instead of silently dropped. It is NOT itself written to the journal.
  | { type: "workflow:journal_degraded"; error: string };
