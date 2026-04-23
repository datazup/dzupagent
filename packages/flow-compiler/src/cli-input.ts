import type { CompileFailure, CompileSuccess, FlowCompiler } from './types.js'

export async function compileTextInput(
  compiler: FlowCompiler,
  rawInput: string,
): Promise<CompileSuccess | CompileFailure> {
  try {
    const parsed: unknown = JSON.parse(rawInput)
    if (isFlowDocumentJson(parsed)) {
      return compiler.compileDocument(parsed)
    }
    if (typeof parsed === 'string' || (typeof parsed === 'object' && parsed !== null)) {
      return compiler.compile(parsed as string | object)
    }
    return {
      compileId: crypto.randomUUID(),
      errors: [{ stage: 1 as const, code: 'INVALID_REQUEST', message: 'flow must be a JSON object or string', nodePath: 'root' }],
    }
  } catch {
    return compiler.compileDsl(rawInput)
  }
}

export function isFlowDocumentJson(value: unknown): value is { dsl: string; root: object } {
  return typeof value === 'object'
    && value !== null
    && 'dsl' in value
    && 'root' in value
}
