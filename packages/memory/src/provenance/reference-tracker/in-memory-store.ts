/**
 * Process-local reference store — the zero-config default backend. Keeps two
 * in-memory indexes (by run, by entry) and provides deterministic filtering /
 * ordering for tests and development.
 */

import type {
  ReferenceQueryOptions,
  ReferenceRecord,
  ReferenceStore,
} from "./types.js";

interface InMemoryEntry {
  record: ReferenceRecord;
}

/**
 * Process-local reference store. Zero dependencies; deterministic for tests.
 */
export class InMemoryReferenceStore implements ReferenceStore {
  private readonly byRun = new Map<string, InMemoryEntry[]>();
  private readonly byEntry = new Map<string, InMemoryEntry[]>();

  async record(record: ReferenceRecord): Promise<void> {
    const entry: InMemoryEntry = { record };

    const runList = this.byRun.get(record.runId) ?? [];
    runList.push(entry);
    this.byRun.set(record.runId, runList);

    const entryList = this.byEntry.get(record.memoryEntryId) ?? [];
    entryList.push(entry);
    this.byEntry.set(record.memoryEntryId, entryList);
  }

  async listByRun(
    runId: string,
    options?: ReferenceQueryOptions
  ): Promise<ReferenceRecord[]> {
    return this.filterAndSort(this.byRun.get(runId) ?? [], options);
  }

  async listByEntry(
    entryId: string,
    options?: ReferenceQueryOptions
  ): Promise<ReferenceRecord[]> {
    return this.filterAndSort(this.byEntry.get(entryId) ?? [], options);
  }

  async clearRun(runId: string): Promise<void> {
    const runList = this.byRun.get(runId);
    if (!runList) return;
    for (const entry of runList) {
      const entryList = this.byEntry.get(entry.record.memoryEntryId);
      if (!entryList) continue;
      const remaining = entryList.filter((e) => e.record.runId !== runId);
      if (remaining.length === 0) {
        this.byEntry.delete(entry.record.memoryEntryId);
      } else {
        this.byEntry.set(entry.record.memoryEntryId, remaining);
      }
    }
    this.byRun.delete(runId);
  }

  private filterAndSort(
    entries: InMemoryEntry[],
    options?: ReferenceQueryOptions
  ): ReferenceRecord[] {
    const limit = options?.limit ?? 100;
    const sinceMs = options?.sinceMs;
    const untilMs = options?.untilMs;

    const filtered = entries
      .map((e) => e.record)
      .filter((r) => {
        if (sinceMs !== undefined && r.retrievedAt < sinceMs) return false;
        if (untilMs !== undefined && r.retrievedAt > untilMs) return false;
        return true;
      })
      .sort((a, b) => b.retrievedAt - a.retrievedAt);

    return filtered.slice(0, Math.max(0, limit));
  }
}
