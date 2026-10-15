/**
 * Default JSON branch of `POST /compile`.
 *
 * Compiles the flow/document/DSL synchronously and returns either a single
 * success body or a 400 failure body. Post-compile handling (target assertion,
 * gateway publish, artifact persistence) runs through `finalizeCompileSuccess`.
 *
 * Extracted from `routes/compile.ts` (RF-23).
 */
import type { Context } from 'hono'
import { createFlowCompiler } from '@dzupagent/flow-compiler'
import type {
  AsyncPersonaResolver,
  CompilationTarget,
  CompileInvocationOptions,
  PersonaResolver,
} from '@dzupagent/flow-compiler'
import type { AsyncToolResolver, ToolResolver } from '@dzupagent/flow-ast'
import { secureLogger } from '@dzupagent/core/utils'

import { compileNormalizedInput } from '../compile-input.js'
import { sanitizeError } from '../route-error.js'
import {
  type CompileRequestBody,
  type CompileRouteConfig,
  type CompileSuccessResponse,
  failureBody,
  finalizeCompileSuccess,
  logInternalCompileDiagnostics,
  makeCompileBus,
  makeRouteDiagnostic,
} from './shared.js'

export interface JsonCompileArgs {
  c: Context
  flowInput: string | object
  invocationOptions: CompileInvocationOptions
  requestedTarget: CompilationTarget | undefined
  runId: string
  body: CompileRequestBody
  config: CompileRouteConfig
  effectivePersonaResolver: PersonaResolver | AsyncPersonaResolver | undefined
  resolveToolResolver: () => Promise<ToolResolver | AsyncToolResolver>
}

export async function handleJsonCompile(args: JsonCompileArgs): Promise<Response> {
  const {
    c,
    flowInput,
    invocationOptions,
    requestedTarget,
    runId,
    config,
    effectivePersonaResolver,
    resolveToolResolver,
  } = args

  const toolResolver = await resolveToolResolver()
  const eventBus = makeCompileBus(config)
  const compiler = createFlowCompiler({
    toolResolver,
    ...(effectivePersonaResolver ? { personaResolver: effectivePersonaResolver } : {}),
    ...(eventBus ? { eventBus, forwardInnerEvents: true } : {}),
  })

  try {
    const result = await compileNormalizedInput(compiler, flowInput, invocationOptions)

    if ('errors' in result) {
      // Failure — report the first error's stage (stages are monotonic; the
      // pipeline short-circuits at the first failing stage) along with the
      // aggregated message list. DZUPAGENT-ERR-H-02: infrastructure
      // diagnostics are logged, redacted by failureBody and reported as 500.
      const infrastructure = logInternalCompileDiagnostics(result.errors, result.compileId)
      return c.json(failureBody(result.errors, result.compileId), infrastructure ? 500 : 400)
    }

    // Success path — target assertion, gateway publish and artifact
    // persistence are shared with every other branch (DZUPAGENT-CODE-M-17).
    const finalized = finalizeCompileSuccess(result, { requestedTarget, runId, config })
    if (!finalized.ok) {
      return c.json(finalized.failure, 400)
    }

    const response: CompileSuccessResponse = {
      ok: true,
      artifact: result.artifact,
      warnings: result.warnings,
      reasons: result.reasons,
      target: result.target,
      compileId: result.compileId,
      evidence: result.evidence,
    }
    return c.json(response)
  } catch (err) {
    const { safe, internal } = sanitizeError(err)

    secureLogger.error(`[compile] ${internal}`)
    return c.json(
      failureBody([makeRouteDiagnostic(1, 'INTERNAL_ERROR', safe)]),
      500,
    )
  }
}
