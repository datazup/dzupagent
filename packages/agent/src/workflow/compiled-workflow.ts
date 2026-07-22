/**
 * Compiled workflow execution engine.
 *
 * Compiles `WorkflowNode[]` into a canonical `PipelineDefinition` and executes
 * via `PipelineRuntime`. Supports run/resume/stream lifecycles, durable
 * suspend/resume via a `PipelineCheckpointStore`, journal recording, and
 * RunHandle reconstruction.
 *
 * Split out of `workflow-builder.ts` to keep the builder file focused on the
 * fluent surface area and stay under the per-file LOC ceiling.
 *
 * This file is the composition root: the cross-cutting concerns it used to
 * inline — best-effort journal recording, pipeline→workflow event translation,
 * and checkpoint resolution — now live in per-concern leaf modules under
 * `./compiled-workflow/` (DZUPAGENT-ARCH-M-06). Public surface (the
 * `CompiledWorkflow` class and its methods) is unchanged.
 */
import type {
  PipelineCheckpoint,
  PipelineCheckpointStore,
} from "@dzupagent/core/pipeline";
import type { RunJournal, RunStore } from "@dzupagent/core/persistence";
import type { WorkflowNode, WorkflowEvent } from "./workflow-types.js";
import type { RunHandle } from "../agent/run-handle-types.js";
import { RunNotFoundError } from "../agent/run-handle-types.js";
import { ConcreteRunHandle } from "../agent/run-handle.js";
import { PipelineStuckDetector } from "../self-correction/pipeline-stuck-detector.js";
import type { PipelineStuckConfig } from "../self-correction/pipeline-stuck-detector.js";
import { randomUUID } from "node:crypto";
import { omitUndefined } from "../utils/exact-optional.js";
import type {
  WorkflowConfig,
  WorkflowErrorHandler,
} from "./workflow-builder-types.js";
import { compileWorkflow } from "./workflow-compiler.js";
import type { WorkflowCompilation } from "./workflow-compiler.js";
import {
  journalAppendGuarded,
  makeJournalEmit,
} from "./compiled-workflow/journal-recorder.js";
import { loadCheckpoint } from "./compiled-workflow/checkpoint-resolver.js";
import {
  buildRuntime,
  driveToTerminal,
} from "./compiled-workflow/execution-driver.js";

/**
 * Compiled workflow — ready for execution.
 *
 * Compiles to `PipelineDefinition` and executes via `PipelineRuntime`.
 */
export class CompiledWorkflow {
  private readonly compilation: WorkflowCompilation;
  private journal?: RunJournal;
  private store?: RunStore;
  private checkpointStore?: PipelineCheckpointStore;
  /** Optional config overrides for the auto-wired PipelineStuckDetector. Pass `false` to disable. */
  private stuckDetectorConfig?: Partial<PipelineStuckConfig> | false;
  private readonly activeRuns = new Map<
    string,
    { store?: RunStore; journal?: RunJournal }
  >();

  constructor(
    readonly config: WorkflowConfig,
    nodes: WorkflowNode[],
    errorHandlers: WorkflowErrorHandler[] = []
  ) {
    this.compilation = compileWorkflow(config, nodes, errorHandlers);
  }

  /** Attach a RunJournal for recording execution history. Returns `this` for fluent chaining. */
  withJournal(journal: RunJournal): this {
    this.journal = journal;
    return this;
  }

  /** Attach a RunStore for run persistence and lookup. Returns `this` for fluent chaining. */
  withStore(store: RunStore): this {
    this.store = store;
    return this;
  }

  /**
   * Attach a PipelineCheckpointStore for durable suspend/resume and crash recovery.
   *
   * When configured, the underlying PipelineRuntime persists a checkpoint after
   * each node completes (checkpointStrategy `'after_each_node'`). The persisted
   * checkpoint can later be passed to {@link resume} (or loaded by `pipelineRunId`
   * from the same store) to continue execution from the suspension point in a new
   * run, or used for crash recovery via the `workflowRunId` option in {@link run}.
   *
   * Returns `this` for fluent chaining.
   */
  withCheckpointStore(checkpointStore: PipelineCheckpointStore): this {
    this.checkpointStore = checkpointStore;
    return this;
  }

  /**
   * Configure the auto-wired PipelineStuckDetector.
   *
   * By default a detector with default thresholds is created for every run.
   * Pass a partial config to override thresholds, or `false` to disable stuck
   * detection entirely.
   *
   * Returns `this` for fluent chaining.
   */
  withStuckDetector(config: Partial<PipelineStuckConfig> | false): this {
    this.stuckDetectorConfig = config;
    return this;
  }

  /** Inspect the compiled canonical pipeline definition. */
  toPipelineDefinition() {
    return structuredClone(this.compilation.definition);
  }

  /**
   * Retrieve a RunHandle for an active or previously-completed run.
   *
   * Checks in-memory active runs first, then falls back to the configured
   * RunStore (if any) to verify the run exists, then reconstructs a handle
   * from the journal.
   *
   * @throws {RunNotFoundError} if the runId is not found in active runs or the store
   * @throws {Error} if neither a store nor a journal is configured
   */
  async getHandle<TOutput = unknown, TState = Record<string, unknown>>(
    runId: string
  ): Promise<RunHandle<TOutput, TState>> {
    // Check active runs first
    const active = this.activeRuns.get(runId);
    if (active) {
      const journal = active.journal ?? this.journal;
      if (!journal) {
        throw new Error(
          `Cannot create RunHandle for run '${runId}': no journal configured`
        );
      }
      return ConcreteRunHandle.fromRunId<TOutput, TState>(
        runId,
        journal as RunJournal<TState>
      );
    }

    // Fall back to RunStore to verify the run exists
    const store = this.store;
    if (store) {
      const run = await store.get(runId);
      if (!run) {
        throw new RunNotFoundError(runId);
      }
    }

    // Reconstruct from journal
    const journal = this.journal;
    if (!journal) {
      throw new Error(
        `Cannot create RunHandle for run '${runId}': no journal configured. Use withJournal() and/or withStore().`
      );
    }

    try {
      return await ConcreteRunHandle.fromRunId<TOutput, TState>(
        runId,
        journal as RunJournal<TState>
      );
    } catch {
      throw new RunNotFoundError(runId);
    }
  }

  /**
   * Execute the workflow with initial state.
   *
   * **Crash recovery:** when `workflowRunId` is supplied and a checkpoint store
   * is configured (via {@link withCheckpointStore}), the runtime loads the most
   * recent checkpoint for that run ID and resumes from the first incomplete node,
   * skipping already-completed ones. This provides at-most-once node execution
   * on crash-restart cycles.
   */
  async run(
    initialState: Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
      runId?: string;
      /**
       * Stable run ID for crash recovery. When provided and a checkpoint exists
       * in the configured checkpoint store, the workflow resumes from the last
       * completed node rather than re-executing from the start.
       */
      workflowRunId?: string;
      onEvent?: (event: WorkflowEvent) => void;
    }
  ): Promise<Record<string, unknown>> {
    const journal = this.journal;
    const runId = options?.runId ?? randomUUID();
    const emit = options?.onEvent ?? (() => {});

    // Track active run
    this.activeRuns.set(runId, omitUndefined({ store: this.store, journal }));

    // Wrap the caller's emit to also write journal entries
    const journalEmit = makeJournalEmit(journal, runId, emit);

    // Auto-wire stuck detector (one per run, unless explicitly disabled)
    const stuckDetector =
      this.stuckDetectorConfig === false
        ? undefined
        : new PipelineStuckDetector(
            this.stuckDetectorConfig as Partial<PipelineStuckConfig> | undefined
          );

    let latestObservedState: Record<string, unknown> = { ...initialState };
    let pipelineFailure: string | null = null;

    // Crash recovery: if a stable workflowRunId is supplied and a checkpoint
    // exists for it, skip re-running from scratch and resume instead.
    const workflowRunId = options?.workflowRunId;
    if (workflowRunId && this.checkpointStore) {
      const existingCheckpoint = await this.checkpointStore.load(workflowRunId);
      if (existingCheckpoint) {
        // Re-use the existing pipelineRunId from the checkpoint so node
        // idempotency keys stay stable across the crash boundary.
        //
        // If the checkpoint has no suspendedAtNodeId (crash without a suspend
        // gate), synthesise one by pointing at the last completed node. The
        // PipelineRuntime will then continue from the first node AFTER that
        // point, and the executor skips all nodes in completedNodeIds.
        let checkpointToResume = existingCheckpoint;
        if (
          !existingCheckpoint.suspendedAtNodeId &&
          existingCheckpoint.completedNodeIds.length > 0
        ) {
          const lastCompleted =
            existingCheckpoint.completedNodeIds[
              existingCheckpoint.completedNodeIds.length - 1
            ]!;
          checkpointToResume = {
            ...existingCheckpoint,
            suspendedAtNodeId: lastCompleted,
          };
        }
        this.activeRuns.delete(runId);
        return this.resume(checkpointToResume, initialState, {
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
          ...(options?.onEvent !== undefined
            ? { onEvent: options.onEvent }
            : {}),
        });
      }
    }

    // Journal: run_started
    if (journal) {
      await journalAppendGuarded(
        journal,
        runId,
        {
          type: "run_started",
          data: { input: initialState, agentId: `workflow:${this.config.id}` },
        },
        emit
      );
    }

    const runtime = buildRuntime({
      compilation: this.compilation,
      checkpointStore: this.checkpointStore,
      journalEmit,
      onLatestState: (state) => {
        latestObservedState = state;
      },
      onFailure: (err) => {
        pipelineFailure = err;
      },
      signal: options?.signal,
      stuckDetector,
    });

    return driveToTerminal(
      {
        compilation: this.compilation,
        journal,
        checkpointStore: this.checkpointStore,
        runId,
        emit,
        journalEmit,
        getLatestState: () => latestObservedState,
      },
      () => runtime.execute(initialState),
      () => pipelineFailure,
      "Workflow execution failed",
      () => this.activeRuns.delete(runId)
    );
  }

  /** Stream workflow events as an async generator */
  async *stream(
    initialState: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<WorkflowEvent> {
    const events: WorkflowEvent[] = [];
    let resolveNext: (() => void) | null = null;

    const onEvent = (event: WorkflowEvent) => {
      events.push(event);
      resolveNext?.();
    };

    // Run workflow in background
    const runPromise = this.run(
      initialState,
      omitUndefined({ signal: options?.signal, onEvent })
    ).catch((err: unknown) => {
      onEvent({
        type: "workflow:failed",
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Yield events as they arrive
    while (true) {
      if (events.length > 0) {
        const event = events.shift()!;
        yield event;
        if (
          event.type === "workflow:completed" ||
          event.type === "workflow:failed" ||
          event.type === "suspended"
        ) {
          break;
        }
      } else {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    }

    await runPromise;
  }

  /**
   * Resume a previously suspended workflow run from a pipeline checkpoint.
   *
   * Thin delegation to {@link PipelineRuntime.resume}. The checkpoint can be
   * supplied directly or looked up from the configured PipelineCheckpointStore
   * by `pipelineRunId`.
   *
   * Continues execution from the node *after* the suspension point. The same
   * compiled workflow instance is used, so step handlers and predicates are
   * identical to the original run. State is restored from the checkpoint and
   * shallow-merged with `additionalState` (e.g. human review input).
   *
   * @param checkpointOrRunId — a PipelineCheckpoint object, or a `pipelineRunId`
   *   string to load from the configured checkpoint store.
   * @param additionalState — optional state delta merged into the restored state
   *   (useful for injecting human-in-the-loop input).
   * @param options — abort signal and optional event subscriber.
   * @returns the final observed state when the resumed run reaches a terminal
   *   state (or the snapshot at the next suspension if it suspends again).
   * @throws if `checkpointOrRunId` is a string and no checkpoint store is
   *   configured, or if no checkpoint exists for the given runId.
   */
  async resume(
    checkpointOrRunId: PipelineCheckpoint | string,
    additionalState?: Record<string, unknown>,
    options?: { signal?: AbortSignal; onEvent?: (event: WorkflowEvent) => void }
  ): Promise<Record<string, unknown>> {
    const checkpoint = await loadCheckpoint(
      checkpointOrRunId,
      this.checkpointStore
    );

    const journal = this.journal;
    const runId = checkpoint.pipelineRunId;
    const emit = options?.onEvent ?? (() => {});

    this.activeRuns.set(runId, omitUndefined({ store: this.store, journal }));

    const journalEmit = makeJournalEmit(journal, runId, emit);

    let latestObservedState: Record<string, unknown> = {
      ...checkpoint.state,
      ...additionalState,
    };
    let pipelineFailure: string | null = null;

    if (journal) {
      await journalAppendGuarded(
        journal,
        runId,
        {
          type: "run_resumed",
          data: {
            resumeToken: `pipeline:${checkpoint.version}`,
            input: additionalState,
          },
        },
        emit
      );
    }

    const runtime = buildRuntime({
      compilation: this.compilation,
      checkpointStore: this.checkpointStore,
      journalEmit,
      onLatestState: (state) => {
        latestObservedState = state;
      },
      onFailure: (err) => {
        pipelineFailure = err;
      },
      signal: options?.signal,
    });

    return driveToTerminal(
      {
        compilation: this.compilation,
        journal,
        checkpointStore: this.checkpointStore,
        runId,
        emit,
        journalEmit,
        getLatestState: () => latestObservedState,
      },
      () => runtime.resume(checkpoint, additionalState),
      () => pipelineFailure,
      "Workflow resume failed",
      () => this.activeRuns.delete(runId)
    );
  }
}
