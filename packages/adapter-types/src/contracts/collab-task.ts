import type { AdapterProviderId } from "./provider.js";
import type {
  ModelOriginFamily,
  ProviderResolution,
} from "./provider-origin.js";

/** Lifecycle state (A2A-inspired). `input_required` is the human gate. */
export type CollabState =
  | "submitted"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "rejected"
  /** MPCO P8a / T15 — terminal: a per-run budget cap was exceeded; further
   *  proposer/critic calls are blocked. Detail in `terminationReason`. */
  | "budget_exceeded";

export type CollabRole = "proposer" | "critic" | "reconciler" | "human";

export type CollabRisk = "low" | "medium" | "high";

export type CollabGateDecision =
  | "auto_accept"
  | "revise"
  | "escalated"
  | "human_approved"
  | "human_rejected"
  | "timeout"
  | "error";

export interface Finding {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

/**
 * Reference to evidence. EVIDENCE BOUNDARY (§2.8): `digestOf` is the literal
 * `'sanitized'` — the type makes a raw-event reference unrepresentable. Refs
 * may point only to sanitized/redacted artifacts, never to `raw-events.jsonl`
 * or provider-private reasoning.
 */
export interface EvidenceRef {
  uri: string;
  digest: string;
  digestOf: "sanitized";
  redactionStatus: string;
  contentClass: string;
}

export type CollabPart =
  | { kind: "verdict"; agree: boolean; confidence: number; findings: Finding[] }
  | {
      kind: "rationale";
      rationale: string;
      evidence: EvidenceRef[];
      quotedContextRefs: string[];
    }
  | { kind: "data"; schemaRef: string; data: unknown };

export interface CollabArtifact {
  type: "diff" | "doc" | "plan";
  uri: string;
  /** Digest of the artifact itself. */
  digest: string;
  baseCommit?: string;
  touchedPaths: string[];
  redactionStatus: string;
}

/**
 * The single handoff contract every MPCO construct reads/writes (A2A-inspired
 * internal schema, NOT a wire format). Persistence splits resumable state
 * (`COLLAB_TASK.json`) from append-only telemetry (`collab-events.ndjson`) — §5.1.
 */
export interface CollabTask {
  schemaVersion: 1;
  id: string;
  contextId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  parentTaskId?: string;
  state: CollabState;
  role: CollabRole;
  executionProviderId: AdapterProviderId;
  modelOriginFamily: ModelOriginFamily;
  resolution: ProviderResolution;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  parts: CollabPart[];
  artifact?: CollabArtifact;
  risk: CollabRisk;
  gateDecision?: CollabGateDecision;
  terminationReason?: string;
}
