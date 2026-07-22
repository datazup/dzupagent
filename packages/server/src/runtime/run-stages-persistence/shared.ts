import { defaultLogger } from "@dzupagent/core/utils";

export interface TerminalPersistenceResult {
  durationMs: number;
}

/**
 * DZUPAGENT-CODE-L-01 — single best-effort logger for the swallowed nested
 * failures in the telemetry/persistence catch blocks.
 *
 * The outer catch blocks already record a warn log via `runStore.addLog`. When
 * that *addLog itself* fails, the error was previously discarded by an
 * anonymous `.catch(() => {})`, so a broken run-store was completely invisible.
 * Routing every such swallow through here keeps the happy path unchanged (still
 * best-effort, never throws) while making the store failure observable at warn
 * level through the framework logger.
 */
export function logBestEffortFailure(operation: string, error: unknown): void {
  defaultLogger.warn(
    `[ForgeServer] best-effort persistence step "${operation}" failed and was swallowed`,
    { error: error instanceof Error ? error.message : String(error) }
  );
}
