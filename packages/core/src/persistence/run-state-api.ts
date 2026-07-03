/**
 * RunStateApi — read surface over DzupRunStateStore + RunJournal.
 *
 * Provides a single `getState`/`getStateHistory` API that combines the
 * fast-path latest snapshot (DzupRunStateStore) with the append-only
 * execution/business history (RunJournal). This is the terminal
 * deliverable of the checkpoint-state-api spec; it has no consumers in
 * this package — future consumers (e.g. a server route) are out of scope.
 */
import type { DzupRunState, DzupRunStateStore } from "./run-state-store.js";
import type {
  RunJournal,
  RunJournalEntry,
  RunJournalQuery,
} from "./run-journal-types.js";

/** A point-in-time snapshot of a run's state, as returned by getState(). */
export interface RunStateSnapshot {
  runId: string;
  seq: number;
  state: DzupRunState;
  capturedAt: number;
}

/** A single journal entry summarized for the history API. */
export interface RunStateHistoryEntry {
  seq: number;
  type: RunJournalEntry["type"];
  timestamp: number;
  summary: string;
}

/** A page of run state history, mirroring RunJournalPage's cursor shape. */
export interface RunStateHistoryPage {
  runId: string;
  entries: RunStateHistoryEntry[];
  nextCursor?: number;
}

export interface RunStateApi {
  getState(runId: string): Promise<RunStateSnapshot | undefined>;
  getStateHistory(
    runId: string,
    options?: { afterSeq?: number; limit?: number }
  ): Promise<RunStateHistoryPage>;
}

export interface RunStateApiDeps {
  runStateStore: DzupRunStateStore;
  runJournal: RunJournal<DzupRunState>;
}

function summarizeEntry<TState>(entry: RunJournalEntry<TState>): string {
  switch (entry.type) {
    case "run_started":
      return "started";
    case "step_started":
      return `step started${
        entry.data.toolName ? ` (${entry.data.toolName})` : ""
      }`;
    case "step_completed":
      return `step completed${
        entry.data.toolName ? ` (${entry.data.toolName})` : ""
      }`;
    case "step_failed":
      return `step failed: ${entry.data.error}`;
    case "state_updated":
      return "state updated";
    case "run_completed":
      return "completed";
    case "run_failed":
      return `failed: ${entry.data.error}`;
    case "run_paused":
      return `paused${entry.data.reason ? ` (${entry.data.reason})` : ""}`;
    case "run_resumed":
      return `resumed (resumeToken: ${entry.data.resumeToken})`;
    case "run_suspended":
      return `suspended${
        entry.data.contactId ? ` (contact: ${entry.data.contactId})` : ""
      }`;
    case "run_cancelled":
      return `cancelled${entry.data.reason ? ` (${entry.data.reason})` : ""}`;
    case "snapshot":
      return "compaction snapshot";
    case "unknown":
      return `unknown (${entry.originalType})`;
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

export function createRunStateApi(deps: RunStateApiDeps): RunStateApi {
  const { runStateStore, runJournal } = deps;

  return {
    async getState(runId: string): Promise<RunStateSnapshot | undefined> {
      const existing = await runStateStore.load(runId);
      if (!existing) {
        return undefined;
      }
      return {
        runId,
        seq: existing.iteration,
        state: existing,
        capturedAt: existing.snapshotAt,
      };
    },

    async getStateHistory(
      runId: string,
      options?: { afterSeq?: number; limit?: number }
    ): Promise<RunStateHistoryPage> {
      const query: RunJournalQuery = {
        ...(options?.afterSeq !== undefined
          ? { afterSeq: options.afterSeq }
          : {}),
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      };
      const page = await runJournal.query(runId, query);
      return {
        runId,
        entries: page.entries.map((entry) => ({
          seq: entry.seq,
          type: entry.type,
          timestamp: new Date(entry.ts).getTime(),
          summary: summarizeEntry(entry),
        })),
        ...(page.nextCursor !== undefined
          ? { nextCursor: page.nextCursor }
          : {}),
      };
    },
  };
}
