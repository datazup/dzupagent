import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import lockfile from "proper-lockfile";
import type {
  KnowledgeStore,
  KnowledgeRef,
  KnowledgeFilter,
  Unsubscribe,
  KnowledgeEnvelope,
  KnowledgeKind,
} from "@dzupagent/agent-types/fleet";
import { KnowledgeCollisionError } from "@dzupagent/agent-types/fleet";
import {
  entriesPath,
  knowledgeDir,
  scopeDir,
  snapshotPath,
} from "./knowledge-paths.js";

interface Options {
  rootDir: string;
}

// Maps a logical scope string ("run:<id>", "global", "repo:<id>") to a
// disjoint on-disk directory name. Prefixes prevent collisions between
// (e.g.) a run literally named "global" and the global scope itself.
function parseScope(scope: string): string {
  const [k, id] = scope.split(":", 2);
  if (k === "run" && id) return `run-${id}`;
  if (k === "global" && !id) return "global";
  if (k === "repo" && id) return `repo-${id}`;
  throw new Error(`Invalid scope: ${scope}`);
}

export class FilesystemKnowledgeStore implements KnowledgeStore {
  private readonly rootDir: string;
  private readonly bus = new EventEmitter();

  constructor(opts: Options) {
    this.rootDir = opts.rootDir;
    this.bus.setMaxListeners(0);
  }

  async append(scope: string, entry: KnowledgeEnvelope): Promise<KnowledgeRef> {
    const scopeKey = parseScope(scope);
    const dir = knowledgeDir(this.rootDir, scopeKey);
    await fs.mkdir(path.join(dir, "snapshots", entry.kind), {
      recursive: true,
    });
    const ndjson = entriesPath(this.rootDir, scopeKey);
    await fs.mkdir(path.dirname(ndjson), { recursive: true });

    const release = await this.lock(scopeKey);
    try {
      await this.assertNoCollision(scope, scopeKey, entry);
      const handle = await fs.open(ndjson, "a");
      try {
        await handle.write(JSON.stringify(entry) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.updateSnapshot(scopeKey, entry);
    } finally {
      await release();
    }

    this.bus.emit("entry", scope, entry);
    return { id: entry.id, version: entry.version };
  }

  async read<T extends KnowledgeEnvelope = KnowledgeEnvelope>(
    scope: string,
    kind: KnowledgeKind,
    key: string
  ): Promise<T | null> {
    const scopeKey = parseScope(scope);
    const file = snapshotPath(this.rootDir, scopeKey, kind, key);
    try {
      const buf = await fs.readFile(file, "utf8");
      return JSON.parse(buf) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async *query(filter: KnowledgeFilter): AsyncIterable<KnowledgeEnvelope> {
    if (!filter.scope)
      throw new Error(
        "filter.scope is required for FilesystemKnowledgeStore.query"
      );
    const scopeKey = parseScope(filter.scope);
    let raw: string;
    try {
      raw = await fs.readFile(entriesPath(this.rootDir, scopeKey), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const env = JSON.parse(line) as KnowledgeEnvelope;
      if (filter.kind && env.kind !== filter.kind) continue;
      if (filter.key && env.key !== filter.key) continue;
      if (filter.repo !== undefined && env.repo !== filter.repo) continue;
      yield env;
    }
  }

  subscribe(
    filter: KnowledgeFilter,
    handler: (e: KnowledgeEnvelope) => void
  ): Unsubscribe {
    const listener = (scope: string, env: KnowledgeEnvelope) => {
      if (filter.scope && scope !== filter.scope) return;
      if (filter.kind && env.kind !== filter.kind) return;
      if (filter.key && env.key !== filter.key) return;
      if (filter.repo !== undefined && env.repo !== filter.repo) return;
      handler(env);
    };
    this.bus.on("entry", listener);
    return () => {
      this.bus.off("entry", listener);
    };
  }

  private async lock(scopeKey: string): Promise<() => Promise<void>> {
    const dir = scopeDir(this.rootDir, scopeKey);
    await fs.mkdir(dir, { recursive: true });
    return lockfile.lock(dir, {
      retries: { retries: 50, minTimeout: 5, maxTimeout: 50 },
    });
  }

  private async assertNoCollision(
    scope: string,
    scopeKey: string,
    entry: KnowledgeEnvelope
  ): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(entriesPath(this.rootDir, scopeKey), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const e = JSON.parse(line) as KnowledgeEnvelope;
      if (
        e.kind === entry.kind &&
        e.key === entry.key &&
        e.version === entry.version
      ) {
        throw new KnowledgeCollisionError(
          scope,
          entry.kind,
          entry.key,
          entry.version
        );
      }
    }
  }

  // NOTE: NDJSON append commits before this; if snapshot write fails, the
  // entry is still durable in the log. Task 6's snapshot rebuilder restores
  // the snapshot from the NDJSON, so the asymmetry is recoverable by design.
  private async updateSnapshot(
    scopeKey: string,
    entry: KnowledgeEnvelope
  ): Promise<void> {
    const file = snapshotPath(this.rootDir, scopeKey, entry.kind, entry.key);
    let current: KnowledgeEnvelope | null = null;
    try {
      current = JSON.parse(
        await fs.readFile(file, "utf8")
      ) as KnowledgeEnvelope;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!current || entry.version > current.version) {
      await fs.writeFile(file, JSON.stringify(entry, null, 2));
    }
  }
}
