/**
 * Drizzle-backed run trace store.
 *
 * Persists the step-by-step trace of each agent run in two tables:
 *   - `run_traces`  — one row per run (header / aggregate)
 *   - `trace_steps` — one row per step, FK → run_traces(run_id)
 *
 * Implements {@link RunTraceStore}. The interface declares all methods as
 * returning Promises so both the in-memory and Drizzle-backed implementations
 * can satisfy it uniformly. Callers must `await` each method call.
 */
import { randomUUID } from 'node:crypto'
import { asc, eq, gte, lt, and } from 'drizzle-orm'
import type { RunTrace, RunTraceStore, TraceStep } from './run-trace-store.js'
import { runTraces, traceSteps } from './drizzle-schema.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzle = any

/** Inferred row types for the run-trace tables. */
type RunTracesRow = typeof runTraces.$inferSelect
type TraceStepsRow = typeof traceSteps.$inferSelect

export class DrizzleRunTraceStore implements RunTraceStore {
  constructor(private readonly db: AnyDrizzle) {}

  /**
   * Start a new trace for a run.
   *
   * If a trace already exists for `runId` it is deleted first so the new
   * trace starts from a clean slate (idempotent re-start).
   */
  async startTrace(runId: string, agentId: string): Promise<void> {
    // Cascade-delete any existing steps first, then the header row.
    await this.db.delete(traceSteps).where(eq(traceSteps.runId, runId))
    await this.db.delete(runTraces).where(eq(runTraces.runId, runId))
    await this.db.insert(runTraces).values({
      runId,
      agentId,
      startedAt: Date.now(),
      completedAt: null,
      totalSteps: 0,
    })
  }

  /**
   * Append a step to the trace.
   *
   * The `stepIndex` is derived from the current `totalSteps` counter on the
   * header row and then incremented atomically.
   */
  async addStep(runId: string, step: Omit<TraceStep, 'stepIndex'>): Promise<void> {
    const rows = await this.db
      .select()
      .from(runTraces)
      .where(eq(runTraces.runId, runId))
      .limit(1)
    const trace = rows[0]
    if (!trace) return

    const stepIndex: number = trace.totalSteps
    await this.db.insert(traceSteps).values({
      id: randomUUID(),
      runId,
      stepIndex,
      timestamp: step.timestamp,
      type: step.type,
      content: step.content,
      metadata: step.metadata ?? null,
      durationMs: step.durationMs ?? null,
    })
    await this.db
      .update(runTraces)
      .set({ totalSteps: stepIndex + 1 })
      .where(eq(runTraces.runId, runId))
  }

  /** Mark the trace as completed by recording the completion timestamp. */
  async completeTrace(runId: string): Promise<void> {
    await this.db
      .update(runTraces)
      .set({ completedAt: Date.now() })
      .where(eq(runTraces.runId, runId))
  }

  /** Return the full trace (header + all steps), or `null` if not found. */
  async getTrace(runId: string): Promise<RunTrace | null> {
    const rows = await this.db
      .select()
      .from(runTraces)
      .where(eq(runTraces.runId, runId))
      .limit(1)
    const trace = rows[0]
    if (!trace) return null

    const steps = await this.db
      .select()
      .from(traceSteps)
      .where(eq(traceSteps.runId, runId))
      .orderBy(asc(traceSteps.stepIndex))

    const traceRow = trace as RunTracesRow
    return {
      runId: traceRow.runId,
      agentId: traceRow.agentId,
      startedAt: traceRow.startedAt,
      completedAt: traceRow.completedAt ?? undefined,
      totalSteps: traceRow.totalSteps,
      steps: (steps as TraceStepsRow[]).map((s) => ({
        stepIndex: s.stepIndex,
        timestamp: s.timestamp,
        type: s.type as TraceStep['type'],
        content: s.content as TraceStep['content'],
        metadata: (s.metadata ?? undefined) as TraceStep['metadata'],
        durationMs: s.durationMs ?? undefined,
      })),
    }
  }

  /**
   * Return steps in the half-open range `[from, to)`.
   *
   * Useful for paginated replay UIs.
   */
  async getSteps(runId: string, from: number, to: number): Promise<TraceStep[]> {
    const rows = await this.db
      .select()
      .from(traceSteps)
      .where(
        and(
          eq(traceSteps.runId, runId),
          gte(traceSteps.stepIndex, from),
          lt(traceSteps.stepIndex, to),
        ),
      )
      .orderBy(asc(traceSteps.stepIndex))

    return (rows as TraceStepsRow[]).map((s) => ({
      stepIndex: s.stepIndex,
      timestamp: s.timestamp,
      type: s.type as TraceStep['type'],
      content: s.content as TraceStep['content'],
      metadata: (s.metadata ?? undefined) as TraceStep['metadata'],
      durationMs: s.durationMs ?? undefined,
    }))
  }

  /** Delete a trace and all its steps. */
  async deleteTrace(runId: string): Promise<void> {
    await this.db.delete(traceSteps).where(eq(traceSteps.runId, runId))
    await this.db.delete(runTraces).where(eq(runTraces.runId, runId))
  }
}
