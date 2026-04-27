/**
 * Stage 4 lowerer — checkpoint / restore nodes.
 *
 * Lowering: checkpoint nodes become a special action node that writes to the
 * journal at runtime (handled by flow-runtime.service.ts). At compile time,
 * we just annotate them as leaf nodes with no branching.
 *
 * These lowerers are intentionally orthogonal to the pipeline lowerers in
 * `_shared.ts`: checkpoint/restore are runtime-executed nodes that do not
 * participate in graph edges. The `LoweredNode` shape exposed here is a
 * lightweight artifact that downstream consumers (flow-runtime) can attach
 * to journal entries without going through PipelineNode.
 *
 * @module lower/lower-checkpoint
 */

import type { CheckpointNode, RestoreNode } from '@dzupagent/flow-ast'

// ---------------------------------------------------------------------------
// Public artifact type
// ---------------------------------------------------------------------------

export interface LoweredCheckpointNode {
  id: string | undefined
  kind: 'checkpoint'
  /** Node id whose runtime output should be snapshotted into the journal. */
  captureOutputOf: string
  /** Resolved label — falls back to nodeId when the AST omits `label`. */
  label: string
  /** Single-element dependency list naming the captured node. */
  deps: string[]
  /** Checkpoints have no outgoing edges — runtime resumes the host flow. */
  edges: never[]
}

export interface LoweredRestoreNode {
  id: string | undefined
  kind: 'restore'
  /** Label of the checkpoint to restore from. */
  checkpointLabel: string
  /** Behavior when the named checkpoint is absent at runtime. */
  onNotFound: 'fail' | 'skip'
  /** Restores have no compile-time deps — runtime resolves the label. */
  deps: never[]
  /** Restores have no outgoing edges — host flow continues from this node. */
  edges: never[]
}

export type LoweredNode = LoweredCheckpointNode | LoweredRestoreNode

// ---------------------------------------------------------------------------
// Lowerers
// ---------------------------------------------------------------------------

export function lowerCheckpointNode(node: CheckpointNode): LoweredCheckpointNode {
  return {
    id: node.id,
    kind: 'checkpoint',
    captureOutputOf: node.captureOutputOf,
    // Default label to the nodeId when the author omits an explicit label.
    // When both are absent, downstream consumers fall back to an empty string
    // so the artifact shape stays predictable; semantic-stage rules already
    // surface the missing-label condition as a warning.
    label: node.label ?? node.id ?? '',
    deps: [node.captureOutputOf],
    edges: [],
  }
}

export function lowerRestoreNode(node: RestoreNode): LoweredRestoreNode {
  return {
    id: node.id,
    kind: 'restore',
    checkpointLabel: node.checkpointLabel,
    onNotFound: node.onNotFound ?? 'fail',
    deps: [],
    edges: [],
  }
}
