import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { KnowledgeEnvelope } from "@dzupagent/agent-types/fleet";
import {
  entriesPath,
  scopeKeyForRun,
  snapshotPath,
} from "./knowledge-paths.js";

interface Opts {
  rootDir: string;
  runId: string;
}

export async function rebuildSnapshots(opts: Opts): Promise<void> {
  const scopeKey = scopeKeyForRun(opts.runId);
  let raw: string;
  try {
    raw = await fs.readFile(entriesPath(opts.rootDir, scopeKey), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const latest = new Map<string, KnowledgeEnvelope>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const env = JSON.parse(line) as KnowledgeEnvelope;
    const key = `${env.kind}:${env.key}`;
    const cur = latest.get(key);
    if (!cur || env.version > cur.version) latest.set(key, env);
  }
  for (const env of latest.values()) {
    const file = snapshotPath(opts.rootDir, scopeKey, env.kind, env.key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(env, null, 2));
  }
}
