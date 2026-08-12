import { CheckpointManager } from '../../vfs/checkpoint-manager.js'
import {
  installCheckpointTestHook,
  type CheckpointTestPhase,
} from '../../vfs/checkpoint/checkpoint-test-hooks.js'
import type { CheckpointRecoveryAuthorization } from '../../vfs/checkpoint/checkpoint-types.js'

interface StartMessage {
  type: 'start'
  operation: 'snapshot' | 'restore' | 'compact' | 'inspect' | 'recover'
  workDir: string
  baseDir: string
  checkpointId?: string
  pausePhase?: CheckpointTestPhase
  authorization?: CheckpointRecoveryAuthorization
}

function send(message: unknown): void {
  process.send?.(message)
}

function finish(message: unknown): void {
  if (!process.send) return
  process.send(message, () => process.disconnect())
}

async function waitForContinue(phase: CheckpointTestPhase): Promise<void> {
  await new Promise<void>((resolve) => {
    const listener = (message: unknown) => {
      if (
        message
        && typeof message === 'object'
        && (message as { type?: unknown }).type === 'continue'
        && (message as { phase?: unknown }).phase === phase
      ) {
        process.off('message', listener)
        resolve()
      }
    }
    process.on('message', listener)
  })
}

process.once('message', (raw: unknown) => {
  void (async () => {
    const message = raw as StartMessage
    const removeHook = installCheckpointTestHook(async (phase) => {
      if (phase !== message.pausePhase) return
      send({ type: 'phase', phase })
      await waitForContinue(phase)
    })
    try {
      const manager = new CheckpointManager({ baseDir: message.baseDir })
      let result: unknown
      if (message.operation === 'snapshot') {
        result = await manager.ensureCheckpointDetailed(message.workDir, 'child snapshot')
      } else if (message.operation === 'restore') {
        result = await manager.restoreDetailed(message.workDir, message.checkpointId ?? '')
      } else if (message.operation === 'compact') {
        result = await manager.compactDetailed(message.workDir)
      } else if (message.operation === 'inspect') {
        result = await manager.inspectRecoveryDetailed(message.workDir)
      } else {
        result = await manager.recoverDetailed(
          message.workDir,
          message.authorization as CheckpointRecoveryAuthorization,
        )
      }
      finish({ type: 'result', result })
    } catch {
      finish({ type: 'child_error' })
    } finally {
      removeHook()
    }
  })()
})

send({ type: 'ready' })
