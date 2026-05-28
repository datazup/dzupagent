import * as path from "node:path";

export function runDir(rootDir: string, runId: string): string {
  return path.join(rootDir, `run-${runId}`);
}
export function knowledgeDir(rootDir: string, runId: string): string {
  return path.join(runDir(rootDir, runId), "knowledge");
}
export function entriesPath(rootDir: string, runId: string): string {
  return path.join(knowledgeDir(rootDir, runId), "entries.ndjson");
}
export function snapshotPath(
  rootDir: string,
  runId: string,
  kind: string,
  key: string
): string {
  const safeKey = key.replace(/[^\w.-]/g, "_");
  return path.join(
    knowledgeDir(rootDir, runId),
    "snapshots",
    kind,
    `${safeKey}.json`
  );
}
