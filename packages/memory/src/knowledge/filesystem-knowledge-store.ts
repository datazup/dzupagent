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
  runDir,
  snapshotPath,
} from "./knowledge-paths.js";

interface Options {
  rootDir: string;
}

function parseScope(scope: string): {
  kind: "run" | "global" | "repo";
  id: string;
} {
  const [k, id] = scope.split(":", 2);
  if (k === "run" && id) return { kind: "run", id };
  if (k === "global") return { kind: "global", id: "global" };
  if (k === "repo" && id) return { kind: "repo", id };
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
    const parsed = parseScope(scope);
    const rid = parsed.kind === "run" ? parsed.id : parsed.kind;
    const dir = knowledgeDir(this.rootDir, rid);
    await fs.mkdir(path.join(dir, "snapshots", entry.kind), {
      recursive: true,
    });
    const ndjson = entriesPath(this.rootDir, rid);
    await fs.mkdir(path.dirname(ndjson), { recursive: true });

    const release = await this.lock(rid);
    try {
      await this.assertNoCollision(rid, entry);
      const handle = await fs.open(ndjson, "a");
      try {
        await handle.write(JSON.stringify(entry) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.updateSnapshot(rid, entry);
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
    const parsed = parseScope(scope);
    const rid = parsed.kind === "run" ? parsed.id : parsed.kind;
    const file = snapshotPath(this.rootDir, rid, kind, key);
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
    const parsed = parseScope(filter.scope);
    const rid = parsed.kind === "run" ? parsed.id : parsed.kind;
    let raw: string;
    try {
      raw = await fs.readFile(entriesPath(this.rootDir, rid), "utf8");
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

  private async lock(rid: string): Promise<() => Promise<void>> {
    const dir = runDir(this.rootDir, rid);
    await fs.mkdir(dir, { recursive: true });
    return lockfile.lock(dir, {
      retries: { retries: 50, minTimeout: 5, maxTimeout: 50 },
    });
  }

  private async assertNoCollision(
    rid: string,
    entry: KnowledgeEnvelope
  ): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(entriesPath(this.rootDir, rid), "utf8");
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
          `run:${rid}`,
          entry.kind,
          entry.key,
          entry.version
        );
      }
    }
  }

  private async updateSnapshot(
    rid: string,
    entry: KnowledgeEnvelope
  ): Promise<void> {
    const file = snapshotPath(this.rootDir, rid, entry.kind, entry.key);
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
