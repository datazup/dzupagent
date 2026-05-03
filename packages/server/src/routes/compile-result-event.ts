import type {
  CompilationTarget,
  CompilationTargetReason,
  CompilationWarning,
  CompileSuccess,
} from '@dzupagent/flow-compiler'
import type { DzupEventOf } from '@dzupagent/core'

export type CompileResultEvent = DzupEventOf<'flow:compile_result'>

type CompileResultPayload = Pick<
  CompileSuccess,
  'compileId' | 'target' | 'artifact' | 'warnings' | 'reasons' | 'evidence'
>

type PartialCompileResultPayload = {
  compileId: string
  target: CompilationTarget
  artifact: unknown
  evidence?: CompileSuccess['evidence']
  warnings: readonly CompilationWarning[]
  reasons?: readonly CompilationTargetReason[]
}

/**
 * Normalize a successful compile into the server-owned terminal result event.
 *
 * This payload is synthesized by transport layers such as SSE/WS bridges after
 * the compiler returns a successful result. The compiler itself only emits
 * lifecycle events on the shared bus.
 */
export function buildCompileResultEvent(
  payload: CompileResultPayload | PartialCompileResultPayload,
): CompileResultEvent {
  return {
    type: 'flow:compile_result',
    compileId: payload.compileId,
    target: payload.target,
    artifact: payload.artifact,
    ...(payload.evidence ? { evidence: payload.evidence } : {}),
    warnings: [...payload.warnings],
    reasons: [...(payload.reasons ?? [])],
  }
}
