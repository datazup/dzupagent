/**
 * Deterministic AgentEvent aggregation for capability observations (Q3).
 *
 * The pure reducer is the only semantic implementation. Live subscription and
 * retained replay both feed the same reducer, which makes rebuild output
 * byte-equivalent to output from a completed live aggregation cycle.
 */
import {
  ADAPTER_DIGEST_V1_OPTIONS,
  canonicalStringify,
  sha256Hex,
} from "@dzupagent/canonical-json";

import type { AgentEvent } from "@dzupagent/adapter-types";
import type {
  AdapterInstallationRef,
  ObservedCapabilities,
  ObservedCapabilityEvidence,
} from "@dzupagent/adapter-types/monitoring/installation";

/** One normalized event plus the run identity supplied by its run store. */
export interface ObservedRunEvent {
  runId: string;
  event: AgentEvent;
  /** Retained-store id when one exists; otherwise a content id is derived. */
  eventId?: string;
}

export interface ObservationCycle {
  ref: AdapterInstallationRef;
  window: { from: string; to: string };
}

export interface ObservedCapabilitiesReducerInput extends ObservationCycle {
  events: readonly ObservedRunEvent[];
}

interface CanonicalRunEvent extends ObservedRunEvent {
  id: string;
  bytes: string;
}

interface RunFacts {
  runId: string;
  started: CanonicalRunEvent | null;
  terminal: CanonicalRunEvent | null;
  accepted: CanonicalRunEvent[];
}

type EvidenceKey = keyof ObservedCapabilities["evidence"];

/**
 * Reduce a complete aggregation-cycle snapshot without mutating its inputs.
 *
 * Rules:
 * - exact duplicates (or equal explicit ids) collapse to one event;
 * - conflicting events with one explicit id choose canonical byte order;
 * - events are ordered by timestamp, then id, then canonical bytes;
 * - the first terminal event closes a run and later events are ignored;
 * - a run missing either its start or terminal event makes the cycle partial;
 * - only positive streaming/tool/prompt evidence is derived from partial runs.
 */
export function reduceRunEventsToObservedCapabilities(
  input: ObservedCapabilitiesReducerInput,
): ObservedCapabilities {
  const events = canonicalEvents(input);
  const runs = groupRuns(events);
  const completeRuns = runs.filter(
    (run) => run.started !== null && run.terminal !== null,
  );
  const cycleComplete = runs.length > 0 && completeRuns.length === runs.length;

  const streaming = evidenceFor(
    runs.flatMap((run) =>
      run.accepted.filter(
        (entry) => entry.event.type === "adapter:stream_delta",
      ),
    ),
  );
  const usage = evidenceFor(
    completeRuns.flatMap((run) =>
      run.accepted.filter(
        (entry) =>
          entry.event.type === "adapter:completed" &&
          entry.event.usage !== undefined,
      ),
    ),
  );
  const resumeAttempts = runs.filter(
    (run) =>
      run.started?.event.type === "adapter:started" &&
      run.started.event.isResume === true,
  );
  const successfulResumes = resumeAttempts
    .filter((run) => run.terminal?.event.type === "adapter:completed")
    .flatMap((run) => [run.started!, run.terminal!]);
  const failedResumes = resumeAttempts
    .filter((run) => run.terminal?.event.type === "adapter:failed")
    .flatMap((run) => [run.started!, run.terminal!]);
  const toolResults = evidenceFor(
    runs.flatMap((run) =>
      run.accepted.filter(
        (entry) => entry.event.type === "adapter:tool_result",
      ),
    ),
  );
  const toolCallsWithoutResult = completeRuns.flatMap((run) => {
    const calls = run.accepted.filter(
      (entry) => entry.event.type === "adapter:tool_call",
    );
    const results = run.accepted.filter(
      (entry) => entry.event.type === "adapter:tool_result",
    );
    return calls.length > 0 && results.length === 0
      ? [run.terminal!, ...calls]
      : [];
  });
  const interactions = evidenceFor(
    runs.flatMap((run) =>
      run.accepted.filter(
        (entry) => entry.event.type === "adapter:interaction_required",
      ),
    ),
  );
  const completed = completeRuns
    .map((run) => run.terminal!)
    .filter((entry) => entry.event.type === "adapter:completed")
    .sort(compareEvents);
  const lastCompleted = completed.at(-1) ?? null;
  const terminalEvidence = evidenceFor(
    completeRuns.map((run) => run.terminal!),
  );

  const evidence: Record<EvidenceKey, ObservedCapabilityEvidence | null> = {
    streamingSeen: streaming ?? (cycleComplete ? terminalEvidence : null),
    usageReported: usage ?? (cycleComplete ? terminalEvidence : null),
    resumeSucceeded:
      evidenceFor(successfulResumes) ?? evidenceFor(failedResumes),
    toolLoopExecuted: toolResults ?? evidenceFor(toolCallsWithoutResult),
    interactionPromptsSeen:
      interactions ?? (cycleComplete ? terminalEvidence : null),
    lastSuccessfulRunAt:
      lastCompleted === null ? null : evidenceFor([lastCompleted]),
  };

  return {
    ref: input.ref,
    window: { ...input.window },
    completeness: cycleComplete ? "complete" : "partial",
    streamingSeen: streaming === null ? (cycleComplete ? false : null) : true,
    usageReported: usage === null ? (cycleComplete ? false : null) : true,
    resumeSucceeded:
      successfulResumes.length > 0
        ? true
        : failedResumes.length > 0
          ? false
          : null,
    toolLoopExecuted:
      toolResults === null
        ? toolCallsWithoutResult.length > 0
          ? false
          : null
        : true,
    interactionPromptsSeen:
      interactions === null ? (cycleComplete ? false : null) : true,
    lastSuccessfulRunAt:
      lastCompleted === null
        ? null
        : new Date(lastCompleted.event.timestamp).toISOString(),
    evidence,
  };
}

/** Port implemented by a normalized live run-event source. */
export interface ObservedRunEventSource {
  subscribe(listener: (event: ObservedRunEvent) => void): () => void;
}

/** Live adapter that snapshots one explicit aggregation cycle. */
export class ObservedCapabilitiesLiveSubscriber {
  private readonly events: ObservedRunEvent[] = [];
  private unsubscribe: (() => void) | null = null;
  private completed: ObservedCapabilities | null = null;

  constructor(
    private readonly source: ObservedRunEventSource,
    private readonly cycle: ObservationCycle,
  ) {}

  start(): void {
    if (this.unsubscribe !== null || this.completed !== null) return;
    this.unsubscribe = this.source.subscribe((event) =>
      this.events.push(event),
    );
  }

  completeCycle(): ObservedCapabilities {
    if (this.completed !== null) return this.completed;
    this.completed = reduceRunEventsToObservedCapabilities({
      ...this.cycle,
      events: this.events,
    });
    this.dispose();
    return this.completed;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/** Retained-event adapter; deliberately delegates every semantic rule. */
export function replayObservedCapabilities(
  input: ObservedCapabilitiesReducerInput,
): ObservedCapabilities {
  return reduceRunEventsToObservedCapabilities(input);
}

function canonicalEvents(
  input: ObservedCapabilitiesReducerInput,
): CanonicalRunEvent[] {
  const byId = new Map<string, CanonicalRunEvent>();

  for (const entry of input.events) {
    if (entry.event.providerId !== input.ref.coordinates.providerId) continue;
    if (!isInWindow(entry.event.timestamp, input.window)) continue;

    const bytes = stableStringify({ runId: entry.runId, event: entry.event });
    const id = entry.eventId ?? `agent-event:sha256:${sha256(bytes)}`;
    const candidate = { ...entry, id, bytes };
    const existing = byId.get(id);
    if (existing === undefined || candidate.bytes < existing.bytes) {
      byId.set(id, candidate);
    }
  }

  return [...byId.values()].sort(compareEvents);
}

function groupRuns(events: CanonicalRunEvent[]): RunFacts[] {
  const byRun = new Map<string, CanonicalRunEvent[]>();
  for (const event of events) {
    const run = byRun.get(event.runId) ?? [];
    run.push(event);
    byRun.set(event.runId, run);
  }

  return [...byRun.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([runId, runEvents]) => {
      const terminalIndex = runEvents.findIndex((entry) =>
        isTerminal(entry.event),
      );
      const accepted =
        terminalIndex === -1
          ? runEvents
          : runEvents.slice(0, terminalIndex + 1);
      return {
        runId,
        started:
          accepted.find((entry) => entry.event.type === "adapter:started") ??
          null,
        terminal: terminalIndex === -1 ? null : runEvents[terminalIndex]!,
        accepted,
      };
    });
}

function evidenceFor(
  events: readonly CanonicalRunEvent[],
): ObservedCapabilityEvidence | null {
  if (events.length === 0) return null;
  return {
    eventIds: [...new Set(events.map((event) => event.id))].sort(),
    runIds: [...new Set(events.map((event) => event.runId))].sort(),
  };
}

function isTerminal(event: AgentEvent): boolean {
  return event.type === "adapter:completed" || event.type === "adapter:failed";
}

function isInWindow(
  timestamp: number,
  window: ObservationCycle["window"],
): boolean {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return (
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    timestamp >= from &&
    timestamp <= to
  );
}

function compareEvents(
  left: CanonicalRunEvent,
  right: CanonicalRunEvent,
): number {
  return (
    left.event.timestamp - right.event.timestamp ||
    eventOrder(left.event) - eventOrder(right.event) ||
    left.id.localeCompare(right.id) ||
    left.bytes.localeCompare(right.bytes)
  );
}

/** Starts precede evidence and terminals close the timestamp's event batch. */
function eventOrder(event: AgentEvent): number {
  if (event.type === "adapter:started") return 0;
  if (isTerminal(event)) return 2;
  return 1;
}

function sha256(value: string): string {
  return sha256Hex(value);
}

// DELIBERATE digest change (ARCH27-T-01 family): the removed local
// stableStringify sorted keys with localeCompare, whose order varies with
// the host ICU locale, so synthesized event ids were never locale-stable.
// Corpus-proven identical for lowercase/camelCase key sets; only
// mixed-case or non-ASCII key orders change.
function stableStringify(value: unknown): string {
  return canonicalStringify(value, ADAPTER_DIGEST_V1_OPTIONS);
}
