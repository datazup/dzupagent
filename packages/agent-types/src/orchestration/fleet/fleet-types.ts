export type WorkerId = string;
export type RunId = string;
export type TaskId = string;

export interface RepoRef {
  name: string;
  path: string;
  executor?: { id: string; config?: Record<string, unknown> };
}

export type KnowledgeKind =
  | "contract"
  | "finding"
  | "task-state"
  | "lesson"
  | "decision";

export interface ContractPayload {
  surface: string;
  changeKind: "add" | "modify" | "remove";
  before?: unknown;
  after: unknown;
  consumers: string[];
  rationale: string;
  status: "proposed" | "ratified" | "rejected";
}

export interface FindingPayload {
  category: "hotspot" | "dead-code" | "test-gap" | "repo-map" | "hazard";
  location: string;
  summary: string;
  evidence: string[];
  confidence: number;
}

export type TaskState =
  | "queued"
  | "claimed"
  | "in-progress"
  | "blocked"
  | "completed"
  | "failed"
  | "surrendered";

export interface TaskStatePayload {
  taskId: TaskId;
  state: TaskState;
  claimedBy?: WorkerId;
  blockedReason?: string;
  outcome?: unknown;
}

export interface LessonPayload {
  scope: "this-run" | "repo" | "workspace";
  rule: string;
  why: string;
  howToApply: string;
  evidenceLinks: string[];
}

export interface DecisionPayload {
  decisionKind:
    | "assignment"
    | "reconciliation"
    | "escalation"
    | "budget-exhausted";
  inputs: unknown[];
  outcome: unknown;
  policyId: string;
}

export type KnowledgePayload =
  | ContractPayload
  | FindingPayload
  | TaskStatePayload
  | LessonPayload
  | DecisionPayload;

export interface KnowledgeEnvelope {
  id: string;
  runId: RunId;
  repo: string | null;
  kind: KnowledgeKind;
  key: string;
  version: number;
  authorWorkerId: WorkerId | null;
  parentId: string | null;
  createdAt: string;
  supersededAt: string | null;
  payload: KnowledgePayload;
  tags: string[];
}

export interface FleetTask {
  id: TaskId;
  description: string;
  payload: unknown;
  dependsOn: TaskId[];
}

export type FleetScenario =
  | "coordinated-feature"
  | "independent-tasks"
  | "audit-fanout"
  | "continuous-fleet";

export interface FleetBudgets {
  /**
   * Wall-clock deadline for the whole run, measured from the first line of
   * `FleetSupervisor.run()`. Enforced: the supervisor checks the deadline
   * before dispatching each task and stops dispatching (escalating with
   * `budget-exhausted`) once it has passed. Tasks already in flight are not
   * interrupted — the budget bounds how much *new* work a run starts.
   */
  wallclockMs?: number;
  /**
   * NOT enforced by FleetSupervisor.
   *
   * SCOPED OUT: the fleet execution path carries no token accounting. Workers
   * report progress as a {@link WorkerEvent} stream and terminate with a
   * `WorkerOutcome`, and neither shape has a token field — `RepoAgentResult`
   * exposes only `events` and `state`. There is therefore nothing for the
   * supervisor to measure, and inferring tokens from event text would be a
   * fabricated number, so the field is a documented no-op rather than a
   * silently-ignored one.
   *
   * To enforce it, a token count would first have to reach the supervisor:
   * either add a usage-bearing `WorkerEvent` variant (e.g.
   * `{ kind: "usage"; inputTokens; outputTokens }`) that executors emit, or
   * carry usage on `WorkerOutcome` and surface it on `RepoAgentResult`. Once a
   * real source exists, `maxTokens` slots into the same
   * check-after-each-task seam that `maxToolCalls` uses.
   */
  maxTokens?: number;
  /**
   * Cumulative cap on `WorkerEvent{kind:"tool_call"}` across every completed
   * task's `RepoAgentResult.events`. Enforced: checked after each task
   * completes; exceeding it stops further dispatch and escalates with
   * `budget-exhausted`.
   */
  maxToolCalls?: number;
}

export interface FleetRunSpec {
  runId: RunId;
  scenario: FleetScenario;
  repos: RepoRef[];
  seedKnowledge?: KnowledgeEnvelope[];
  tasks: FleetTask[];
  budgets?: FleetBudgets;
}

export type WorkerEvent =
  | { kind: "step_start"; stepId: string; at: string }
  | { kind: "step_done"; stepId: string; at: string }
  | { kind: "message"; text: string; role: "assistant" | "tool"; at: string }
  | { kind: "tool_call"; toolName: string; inputSummary: string; at: string }
  | { kind: "error"; message: string; fatal: boolean; at: string }
  | { kind: "exit"; code: number | null; reason: string | null; at: string };

export interface Assignment {
  taskId: TaskId;
  workerId: WorkerId;
  rationale: string;
}

export type EscalationReason =
  | "no-bidder"
  | "contract-conflict"
  | "repeated-failure"
  | "budget-exhausted";

export interface ContractChange {
  surface: string;
  /** Envelope IDs aligned one-for-one with `proposals` in stable query order. */
  proposalIds: string[];
  proposals: ContractPayload[];
}

export interface ReconciliationPlan {
  ratified: ContractPayload | null;
  rejectIds: string[];
  pauseTasks: TaskId[];
  escalate: boolean;
}

export interface RepoAgentResult {
  workerId: WorkerId;
  repo: string;
  taskId: TaskId;
  state: TaskState;
  outcome?: unknown;
  events: WorkerEvent[];
}

export interface FleetRunResult {
  runId: RunId;
  status: "completed" | "failed" | "escalated";
  finishedAt: string;
  taskOutcomes: RepoAgentResult[];
}

export function isKnowledgeEnvelope(
  value: unknown
): value is KnowledgeEnvelope {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.runId === "string" &&
    typeof v.kind === "string" &&
    typeof v.key === "string" &&
    typeof v.version === "number" &&
    typeof v.createdAt === "string" &&
    Array.isArray(v.tags) &&
    v.payload !== undefined
  );
}

export function isContractPayload(value: unknown): value is ContractPayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.surface === "string" &&
    typeof v.changeKind === "string" &&
    Array.isArray(v.consumers) &&
    typeof v.rationale === "string" &&
    typeof v.status === "string"
  );
}
