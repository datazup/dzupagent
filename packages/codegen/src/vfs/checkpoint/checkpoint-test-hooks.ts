import type { CheckpointJournalPhase } from './checkpoint-types.js'

export type CheckpointTestPhase = CheckpointJournalPhase
  | 'ownership_acquired'
  | 'snapshot_commit_object_written'
  | 'snapshot_ref_written'
  | 'restore_safety_ref_written'
  | 'restore_tree_applied'
  | 'recovery_tree_applied'
  | 'compaction_repacked'
  | 'compaction_pruned'

type CheckpointTestHook = (phase: CheckpointTestPhase) => Promise<void> | void

let activeHook: CheckpointTestHook | null = null

/** @internal Deterministic fault-injection seam for disposable test processes. */
export function installCheckpointTestHook(hook: CheckpointTestHook): () => void {
  if (activeHook) throw new Error('checkpoint test hook is already installed')
  activeHook = hook
  return () => {
    if (activeHook === hook) activeHook = null
  }
}

export async function emitCheckpointTestPhase(phase: CheckpointTestPhase): Promise<void> {
  await activeHook?.(phase)
}
