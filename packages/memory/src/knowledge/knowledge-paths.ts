import * as path from "node:path";

export function scopeKeyForRun(runId: string): string {
  return `run-${runId}`;
}

export function scopeDir(rootDir: string, scopeKey: string): string {
  if (!scopeKey || /[\/\\\x00]/.test(scopeKey) || scopeKey === "." || scopeKey === "..") throw new Error("Invalid knowledge scope key");
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
  key: string,
  legacy = false
): string {
  if (!/^[a-z][a-z-]*$/.test(kind)) throw new Error("Invalid knowledge kind");
  const safeKey = legacy ? key.replace(/[^\w.-]/g, "_") : encodeURIComponent(key);
  return path.join(
    knowledgeDir(rootDir, scopeKey),
    "snapshots",
    kind,
    `${safeKey}.json`
  );
}
