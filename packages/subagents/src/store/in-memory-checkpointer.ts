import type { TaskId } from "../contracts/background-task.js";
import type { CheckpointerPort } from "../contracts/checkpointer-port.js";

/**
 * Default in-memory {@link CheckpointerPort}. Keeps the package self-contained
 * and the exit cost low; production wires the Postgres-backed checkpointer from
 * `@dzupagent/agent-adapters` via this same port.
 */
export class InMemoryCheckpointer implements CheckpointerPort {
  private readonly snapshots = new Map<string, unknown>();
  private seq = 0;

  async save(taskId: TaskId, snapshot: unknown): Promise<string> {
    const ref = `${taskId}:${(this.seq += 1)}`;
    this.snapshots.set(ref, structuredClone(snapshot));
    return ref;
  }

  async load(checkpointRef: string): Promise<unknown | null> {
    const found = this.snapshots.get(checkpointRef);
    return found === undefined ? null : structuredClone(found);
  }
}
