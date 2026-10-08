import {
  prepareFlowInputFromDocument,
  prepareFlowInputFromDsl,
  type CompilationDiagnostic,
  type CompileInvocationOptions,
  type CompileResult,
  type FlowCompiler,
} from '@dzupagent/flow-compiler'

export interface CompileInputPayload {
  flow?: unknown
  document?: unknown
  dsl?: unknown
}

export interface NormalizedCompileInput {
  kind: 'flow' | 'document' | 'dsl'
  flowInput: string | object
}

export function normalizeCompileInput(
  payload: CompileInputPayload,
): { ok: true; value: NormalizedCompileInput } | { ok: false; diagnostics: CompilationDiagnostic[] } {
  const presentKeys = ['flow', 'document', 'dsl'].filter((key) => {
    const value = payload[key as keyof CompileInputPayload]
    return value !== undefined && value !== null
  })

  if (presentKeys.length === 0) {
    return {
      ok: false,
      diagnostics: [makeDiagnostic(1, 'MISSING_REQUIRED_FIELD', 'one of "flow", "document", or "dsl" is required')],
    }
  }

  if (presentKeys.length > 1) {
    return {
      ok: false,
      diagnostics: [makeDiagnostic(1, 'INVALID_REQUEST', 'provide exactly one of "flow", "document", or "dsl"')],
    }
  }

  if (payload.flow !== undefined && payload.flow !== null) {
    if (typeof payload.flow === 'string') {
      return { ok: true, value: { kind: 'flow', flowInput: payload.flow } }
    }
    if (typeof payload.flow === 'object') {
      return { ok: true, value: { kind: 'flow', flowInput: payload.flow as object } }
    }
    return {
      ok: false,
      diagnostics: [makeDiagnostic(1, 'INVALID_REQUEST', 'flow must be a JSON string or object')],
    }
  }

  if (payload.document !== undefined && payload.document !== null) {
    const prepared = prepareFlowInputFromDocument(payload.document)
    if (!prepared.ok) {
      return { ok: false, diagnostics: prepared.errors }
    }
    return { ok: true, value: { kind: 'document', flowInput: prepared.flowInput } }
  }

  const prepared = prepareFlowInputFromDsl(payload.dsl)
  if (!prepared.ok) {
    return {
      ok: false,
      diagnostics: prepared.errors,
    }
  }

  return { ok: true, value: { kind: 'dsl', flowInput: prepared.flowInput } }
}

/**
 * Compile a normalized request input. DSL sources go through `compileDsl`, the
 * only entry that carries the dzupflow/v2 frontend metadata (retry, catch,
 * policy, multi-port save) and the F-R4 durability gate to the target gates;
 * `compile(flowInput)` would compile a lossy projection. The run correlation
 * goes to `compileDsl`, so the compiler builds `evidence.correlationIds`. Flow
 * and document inputs keep `compile(flowInput, options)`.
 */
export async function compileNormalizedInput(
  compiler: Pick<FlowCompiler, 'compile' | 'compileDsl'>,
  flowInput: string | object,
  invocationOptions: CompileInvocationOptions,
): Promise<CompileResult> {
  if (invocationOptions.sourceKind !== 'dzupflow-dsl') {
    return compiler.compile(flowInput, invocationOptions)
  }
  const { correlation } = invocationOptions
  return compiler.compileDsl(invocationOptions.source, correlation ? { correlation } : {})
}

function makeDiagnostic(
  stage: 1 | 2,
  code: string,
  message: string,
): CompilationDiagnostic {
  return {
    stage,
    code,
    message,
    nodePath: 'root',
  }
}
