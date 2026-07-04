import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  BackgroundTask,
  TaskId,
  TaskStatus,
} from "../contracts/background-task.js";
import type { TaskFilter, TaskStore } from "../contracts/task-store.js";

export interface HostTaskStoreOptions {
  directory: string;
}

/**
 * Host-backed task store. Each task is persisted as a JSON file so a new runner
 * process can reattach to queued/running task state.
 */
export class HostTaskStore implements TaskStore {
  private readonly directory: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: HostTaskStoreOptions) {
    this.directory = options.directory;
  }

  async put(task: BackgroundTask): Promise<void> {
    await this.mutate(async () => {
      await this.write(structuredClone(task));
    });
  }

  async get(id: TaskId): Promise<BackgroundTask | null> {
    const found = await this.read(id);
    return found === null ? null : structuredClone(found);
  }

  async list(filter: TaskFilter): Promise<BackgroundTask[]> {
    const statuses = normaliseStatuses(filter.status);
    const tasks = await this.readAll();
    const results: BackgroundTask[] = [];
    for (const task of tasks) {
      if (
        filter.parentRunId !== undefined &&
        task.parentRunId !== filter.parentRunId
      ) {
        continue;
      }
      if (statuses && !statuses.includes(task.status)) {
        continue;
      }
      if (filter.endedBefore !== undefined) {
        if (task.endedAt === undefined || task.endedAt >= filter.endedBefore) {
          continue;
        }
      }
      results.push(structuredClone(task));
    }
    return results;
  }

  async patch(id: TaskId, patch: Partial<BackgroundTask>): Promise<void> {
    await this.mutate(async () => {
      const existing = await this.read(id);
      if (existing === null) return;
      await this.write({ ...existing, ...structuredClone(patch) });
    });
  }

  async patchIfStatus(
    id: TaskId,
    expectedStatus: TaskStatus,
    patch: Partial<BackgroundTask>,
  ): Promise<boolean> {
    let applied = false;
    await this.mutate(async () => {
      const existing = await this.read(id);
      if (existing === null || existing.status !== expectedStatus) return;
      await this.write({ ...existing, ...structuredClone(patch) });
      applied = true;
    });
    return applied;
  }

  async remove(id: TaskId): Promise<void> {
    await this.mutate(async () => {
      try {
        await rm(this.pathFor(id), { force: true });
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return;
        throw error;
      }
    });
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);
    await next;
  }

  private async read(id: TaskId): Promise<BackgroundTask | null> {
    try {
      const payload = await readFile(this.pathFor(id), "utf8");
      return JSON.parse(payload) as BackgroundTask;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async readAll(): Promise<BackgroundTask[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const tasks: BackgroundTask[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const payload = await readFile(join(this.directory, entry), "utf8");
      tasks.push(JSON.parse(payload) as BackgroundTask);
    }
    return tasks;
  }

  private async write(task: BackgroundTask): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(task.id);
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }

  private pathFor(id: TaskId): string {
    return join(
      this.directory,
      `${Buffer.from(id).toString("base64url")}.json`,
    );
  }
}

function normaliseStatuses(
  status: TaskStatus | TaskStatus[] | undefined,
): TaskStatus[] | null {
  if (status === undefined) return null;
  return Array.isArray(status) ? status : [status];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
