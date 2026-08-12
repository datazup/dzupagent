import type {
  CheckpointDetailedResult,
  CheckpointErrorCode,
  CheckpointProof,
} from '../../vfs/checkpoint/checkpoint-types.js'

export interface ProtectedCheckpointPort {
  ensureCheckpointDetailed(workDir: string, reason: string): Promise<CheckpointDetailedResult>
}

export type ProtectedMutationResult =
  | { status: 'mutated'; receipt: CheckpointProof }
  | { status: 'blocked'; code: CheckpointErrorCode | 'invalid_proof' }

function hasExactProof(result: CheckpointDetailedResult): result is Extract<
  CheckpointDetailedResult,
  { status: 'created' | 'deduplicated' }
> {
  if (result.status !== 'created' && result.status !== 'deduplicated') return false
  return result.checkpointId === result.proof.checkpointId
    && /^[0-9a-f]{64}$/.test(result.proof.rootSha256)
    && /^[0-9a-f]{64}$/.test(result.proof.sourceDigest)
    && Number.isSafeInteger(result.proof.generation)
    && result.proof.generation > 0
}

/** Provider-free conformance fixture for a protected mutation adopter. */
export async function runProtectedMutation(
  port: ProtectedCheckpointPort,
  workDir: string,
  mutate: () => Promise<void>,
): Promise<ProtectedMutationResult> {
  const checkpoint = await port.ensureCheckpointDetailed(workDir, 'protected mutation')
  if (!hasExactProof(checkpoint)) {
    return {
      status: 'blocked',
      code: checkpoint.status === 'failed' || checkpoint.status === 'skipped'
        ? checkpoint.code
        : 'invalid_proof',
    }
  }
  await mutate()
  return { status: 'mutated', receipt: checkpoint.proof }
}
