import * as path from "node:path";

export function scopeKeyForRun(runId: string): string {
  return `run-${runId}`;
}

export function scopeDir(rootDir: string, scopeKey: string): string {
  return path.join(rootDir, scopeKey);
}
export function knowledgeDir(rootDir: string, scopeKey: string): string {
  return path.join(scopeDir(rootDir, scopeKey), "knowledge");
}
export function entriesPath(rootDir: string, scopeKey: string): string {
  return path.join(knowledgeDir(rootDir, scopeKey), "entries.ndjson");
}
export function snapshotPath(
  rootDir: string,
  scopeKey: string,
  kind: string,
  key: string
): string {
  const safeKey = key.replace(/[^\w.-]/g, "_");
  return path.join(
    knowledgeDir(rootDir, scopeKey),
    "snapshots",
    kind,
    `${safeKey}.json`
  );
}
