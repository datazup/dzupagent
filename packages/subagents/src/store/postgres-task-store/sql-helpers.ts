import type {
  BackgroundTask,
  TaskStatus,
} from "../../contracts/background-task.js";

/**
 * Minimal Postgres client contract the store/queue depend on. Accepts either a
 * `{ rows }` result envelope (node-postgres) or a bare row array so callers can
 * inject thin adapters without pulling in a driver dependency.
 */
export interface PostgresQueryClient {
  query(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows?: Record<string, unknown>[] } | Record<string, unknown>[]>;
}

export interface VersionedTask {
  task: BackgroundTask;
  version: number;
}

export function rowToVersionedTask(
  row: Record<string, unknown> | undefined
): VersionedTask | null {
  if (!row) return null;
  const taskJson = row.task_json;
  if (!taskJson || typeof taskJson !== "object") return null;
  return {
    task: structuredClone(taskJson) as BackgroundTask,
    version: Number(row.version ?? 0),
  };
}

export function toRows(
  result: { rows?: Record<string, unknown>[] } | Record<string, unknown>[]
): Record<string, unknown>[] {
  if (Array.isArray(result)) return result;
  return Array.isArray(result.rows) ? result.rows : [];
}

export function normaliseStatuses(
  status: TaskStatus | TaskStatus[] | undefined
): TaskStatus[] | undefined {
  if (status === undefined) return undefined;
  return Array.isArray(status) ? status : [status];
}

export function sanitizeIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid Postgres identifier: ${identifier}`);
  }
  return identifier;
}
