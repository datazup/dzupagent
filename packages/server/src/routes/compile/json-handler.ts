/**
 * Default JSON branch of `POST /compile`.
 *
 * Compiles the flow/document/DSL synchronously and returns either a single
 * success body or a 400 failure body. Persists the compiled artifact to the
 * configured `runEventStore` (fire-and-forget) and republishes the terminal
 * `flow:compile_result` event over the shared event gateway when configured.
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
import { secureLogger } from '@dzupagent/core'

import { sanitizeError } from '../route-error.js'
import { buildCompileResultEvent } from '../compile-result-event.js'
import {
  type CompileRequestBody,
  type CompileRouteConfig,
  type CompileSuccessResponse,
  failureBody,
  makeCompileBus,
  makeRouteDiagnostic,
  publishToGateway,
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
    const result = await compiler.compile(flowInput, invocationOptions)

    if ('errors' in result) {
      // Failure — report the first error's stage (stages are monotonic; the
      // pipeline short-circuits at the first failing stage) along with the
      // aggregated message list.
      return c.json(failureBody(result.errors, result.compileId), 400)
    }

    // Success path — optional target assertion.
    if (requestedTarget !== undefined && result.target !== requestedTarget) {
      const diagnostics = [
        makeRouteDiagnostic(
          4,
          'TARGET_MISMATCH',
          `Requested target "${requestedTarget}" does not match compiler-routed target "${result.target}"`,
        ),
      ]
      return c.json(failureBody(diagnostics, result.compileId), 400)
    }

    publishToGateway(config, buildCompileResultEvent(result))

    // Persist compile artifact to the run event store (fire-and-forget).
    // Honour an optional caller-supplied runId (same pattern as the SSE branch).
    if (config.runEventStore) {
      config.runEventStore.appendArtifact({
        runId: runId || result.compileId,
        providerId: 'claude',
        timestamp: Date.now(),
        artifactType: 'output',
        path: `compile:${result.compileId}`,
        action: 'created',
        metadata: {
          type: 'compile:completed',
          target: result.target,
          artifact: result.artifact,
          evidence: result.evidence,
          warnings: result.warnings,
          reasons: result.reasons,
        },
      }).catch(() => {
        // Store errors are handled internally by RunEventStore (logged to stderr).
      })
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
