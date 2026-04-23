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
  'compileId' | 'target' | 'artifact' | 'warnings' | 'reasons'
>

type PartialCompileResultPayload = {
  compileId: string
  target: CompilationTarget
  artifact: unknown
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
    warnings: [...payload.warnings],
    reasons: [...(payload.reasons ?? [])],
  }
}
