import type {
  FleetTask,
  RepoRef,
  WorkerEvent,
  WorkerId,
} from "./fleet-types.js";
import type { KnowledgeStore } from "./knowledge-store.js";

export interface ScopedKnowledgeHandle {
  store: KnowledgeStore;
  scope: string;
  repo: string | null;
}

export interface WorkerSpec {
  workerId: WorkerId;
  repo: RepoRef;
  repoPath: string;
  taskBundle: FleetTask;
  knowledgeHandle: ScopedKnowledgeHandle;
  mailboxAddress: string;
  config: Record<string, unknown>;
}

export interface WorkerOutcome {
  state: "completed" | "failed" | "cancelled" | "crashed";
  exitCode: number | null;
  reason?: string;
}

export type WorkerInbound =
  | { kind: "cancel"; reason: string }
  | { kind: "message"; text: string }
  | { kind: "contract-update"; surface: string };

export interface WorkerHandle {
  readonly workerId: WorkerId;
  readonly events: AsyncIterable<WorkerEvent>;
  send(msg: WorkerInbound): Promise<void>;
  cancel(reason: string): Promise<void>;
  wait(): Promise<WorkerOutcome>;
}

export interface Executor {
  readonly id: string;
  spawn(spec: WorkerSpec): Promise<WorkerHandle>;
}
