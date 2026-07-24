import {
  validateFlowDocumentShape,
  type FlowDocumentV1,
} from '@dzupagent/flow-ast'
import {
  canonicalizeDsl,
  toPrimitiveRegistryV1,
  type PrimitiveExpansionHandlers,
  type PrimitiveRegistryV2,
} from '@dzupagent/flow-dsl'
import {
  createDslSourceMap,
  resolveDslSourceSpan,
  type DslSourceMap,
} from '@dzupagent/flow-dsl/source-map'

import type { CompilationDiagnostic } from './types.js'

export function prepareFlowInputFromDocument(
  document: unknown,
): { ok: true; flowInput: object } | { ok: false; errors: CompilationDiagnostic[] } {
  if (typeof document !== 'object' || document === null) {
    return {
      ok: false,
      errors: [makeDiagnostic(1, 'INVALID_REQUEST', 'document must be a workflow document object')],
    }
  }

  const issues = validateFlowDocumentShape(document).map((issue) => ({
    stage: 2 as const,
    code: issue.code,
    message: issue.message,
    nodePath: issue.nodePath,
    category: 'shape' as const,
  }))
  if (issues.length > 0) {
    return { ok: false, errors: issues }
  }

  return {
    ok: true,
    flowInput: (document as { root: object }).root,
  }
}

export function prepareFlowInputFromDsl(
  source: unknown,
  options: {
    primitiveRegistry?: PrimitiveRegistryV2
    primitiveExpansionHandlers?: PrimitiveExpansionHandlers
  } = {},
):
  | {
      ok: true
      flowInput: object
      document?: FlowDocumentV1
      sourceMap?: DslSourceMap
    }
  | { ok: false; errors: CompilationDiagnostic[] } {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return {
      ok: false,
      errors: [makeDiagnostic(1, 'INVALID_REQUEST', 'dsl must be a non-empty string')],
    }
  }

  const canonicalized = canonicalizeDsl(
    source,
    options.primitiveRegistry === undefined
      ? {}
      : {
          primitiveRegistry: toPrimitiveRegistryV1(
            options.primitiveRegistry,
            options.primitiveExpansionHandlers,
          ),
        },
  )
  if (!canonicalized.ok) {
    const sourceMap = createDslSourceMap(
      source,
      canonicalized.partialDocument ?? undefined,
    )
    return {
      ok: false,
      errors: canonicalized.diagnostics.map((diagnostic) => ({
        stage: diagnostic.phase === 'parse' ? 1 : 2,
        code: diagnostic.code,
        message: diagnostic.message,
        nodePath: diagnostic.path,
        category: 'shape' as const,
        ...(diagnostic.suggestion ? { suggestion: diagnostic.suggestion } : {}),
        ...(diagnostic.span
          ? {
              span: {
                kind: 'source-lines' as const,
                lineStart: diagnostic.span.lineStart,
                columnStart: diagnostic.span.columnStart,
                lineEnd: diagnostic.span.lineEnd,
                columnEnd: diagnostic.span.columnEnd,
              },
            }
          : {}),
        ...(!diagnostic.span && sourceMap !== undefined
          ? sourceOffsetSpan(sourceMap, diagnostic.path)
          : {}),
      })),
    }
  }

  const sourceMap = createDslSourceMap(source, canonicalized.document)
  return {
    ok: true,
    flowInput: canonicalized.flowInput,
    document: canonicalized.document,
    ...(sourceMap !== undefined ? { sourceMap } : {}),
  }
}

function sourceOffsetSpan(
  sourceMap: DslSourceMap,
  path: string,
): Pick<CompilationDiagnostic, 'span'> {
  const span = resolveDslSourceSpan(sourceMap, path)
  return span === undefined
    ? {}
    : {
        span: {
          kind: 'source-offsets',
          ...span,
        },
      }
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
    category: 'shape',
  }
}
