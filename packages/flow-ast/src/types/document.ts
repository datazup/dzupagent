import type {
  FlowDefaults,
  FlowDurabilityPolicy,
  FlowInputSpec,
  FlowNodeMetadata,
} from "./primitives.js";
import type { SequenceNode } from "./nodes.js";

/**
 * Supported DSL discriminator values.
 *
 * `dzupflow/v1` is the stable, long-lived contract.
 * `dzupflow/v1alpha-agent` opts into the Stage 1 agent-node primitives
 *  (agent + validate nodes, top-level policy block). The parser must
 *  treat these as additive — `v1` documents must continue to round-trip
 *  unchanged.
 */
export type FlowDocumentDsl = "dzupflow/v1" | "dzupflow/v1alpha-agent";

/**
 * Top-level policy constraints for an entire flow run. Acts as a ceiling that
 * applies to all nodes unless a per-agent `AgentPolicy` narrows the scope
 * further. Stage 3 (policy threading).
 */
export interface FlowDocumentPolicy {
  /** Hard budget ceiling in USD cents for the entire flow run. */
  budgetCents?: number;
  /** Hard timeout in ms for the entire flow run. */
  timeoutMs?: number;
  /** Default working directory applied to all validate/command nodes. */
  workingDirectory?: string;
}

export interface FlowDocumentV1 {
  dsl: FlowDocumentDsl;
  id: string;
  title?: string;
  description?: string;
  version: number;
  inputs?: Record<string, FlowInputSpec>;
  defaults?: FlowDefaults;
  tags?: string[];
  meta?: FlowNodeMetadata;
  /** Top-level policy constraints for the entire flow run (Stage 3). */
  policy?: FlowDocumentPolicy;
  /** Top-level crash-safety profile (P0 durability contract). Absent ⇒ volatile. */
  durability?: FlowDurabilityPolicy;
  root: SequenceNode;
}
