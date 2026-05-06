/**
 * Flow compilation route — router only.
 *
 * POST /compile — Compile a FlowNode (JSON/object) into a skill-chain,
 *                 workflow-builder, or pipeline artifact via the
 *                 four-stage pipeline in `@dzupagent/flow-compiler`.
 *
 * Content negotiation:
 *  - `Accept: application/json` (default) → single JSON response.
 *  - `Accept: text/event-stream`          → SSE stream of
 *    `flow:compile_*` lifecycle events plus a terminal
 *    `flow:compile_result` success payload or `flow:compile_failed`.
 *  - `?stream=true`                       → coarse-grained `stage` SSE
 *    stream (independent of Accept).
 *  - `?subprocess=true` (with SSE)        → spawn `dzupagent-compile`
 *    as a child process and bridge its NDJSON stdout to SSE.
 *
 * The request body is one of:
 * ```
 * { "flow":     <FlowNode JSON>,        "target"?: ... }
 * { "document": <FlowDocumentV1 JSON>,  "target"?: ... }
 * { "dsl":      "dzupflow/v1 ...",      "target"?: ... }
 * ```
 *
 * If `target` is provided and does not match the compiler's auto-routed
 * target, a 400 is returned (guard against silent target drift between
 * caller intent and lowerer choice). When `target` is omitted the compiler's
 * routing decision is authoritative.
 *
 * Per-mode handlers live under `./compile/*` (RF-23). This file is the thin
 * Hono wiring layer that parses the body, validates the optional `target`,
 * negotiates the response shape, and dispatches to the appropriate handler.
 */
import { Hono } from 'hono'
import { createBuiltinToolRegistryFromIndex } from '@dzupagent/app-tools'
import type { AsyncToolResolver, ToolResolver } from '@dzupagent/flow-ast'
import type { CompilationTarget } from '@dzupagent/flow-compiler'

import type { AppEnv } from '../types.js'
import { createPersonaStoreResolver } from '../personas/persona-resolver.js'
import { normalizeCompileInput } from './compile-input.js'
import { handleSubprocessCompile } from './spawn-compiler-bridge.js'
import { handleJsonCompile } from './compile/json-handler.js'
import { handleSseCompile } from './compile/sse-handler.js'
import { handleStageStreamCompile } from './compile/stage-stream-handler.js'
import {
  ALLOWED_TARGETS,
  type CompileRequestBody,
  type CompileRouteConfig,
  failureBody,
  getOversizedCompilePayloadField,
  isAllowedTarget,
  makeCompileInvocationOptions,
  makeRouteDiagnostic,
  NOOP_TOOL_RESOLVER,
} from './compile/shared.js'

export type { CompileRouteConfig } from './compile/shared.js'

export function createCompileRoutes(config: CompileRouteConfig = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const effectivePersonaResolver =
    config.personaResolver
    ?? (config.personaStore ? createPersonaStoreResolver(config.personaStore) : undefined)

  // Lazy tool resolver: when `knowledgeIndexPath` is configured and no
  // explicit `toolResolver` is provided, the first compile request triggers
  // a one-time load of the knowledge index and memoises the resulting
  // resolver for subsequent requests. Explicit `toolResolver` always wins.
  let knowledgeResolverPromise: Promise<ToolResolver | AsyncToolResolver> | null = null
  function resolveToolResolver(): Promise<ToolResolver | AsyncToolResolver> {
    if (config.toolResolver) {
      return Promise.resolve(config.toolResolver)
    }
    if (!config.knowledgeIndexPath) {
      return Promise.resolve(NOOP_TOOL_RESOLVER)
    }
    if (!knowledgeResolverPromise) {
      knowledgeResolverPromise = createBuiltinToolRegistryFromIndex({
        knowledgeIndexPath: config.knowledgeIndexPath,
      }).then((bundle) => bundle.toToolResolver() as ToolResolver)
    }
    return knowledgeResolverPromise
  }

  app.post('/compile', async (c) => {
    let body: CompileRequestBody
    try {
      body = await c.req.json<CompileRequestBody>()
    } catch {
      return c.json(
        failureBody([makeRouteDiagnostic(1, 'INVALID_REQUEST', 'Invalid JSON body')]),
        400,
      )
    }

    const oversizedField = getOversizedCompilePayloadField(body)
    if (oversizedField) {
      return c.json(
        failureBody([
          makeRouteDiagnostic(1, 'PAYLOAD_TOO_LARGE', `${oversizedField} too large (max 1 MiB)`),
        ]),
        413,
      )
    }

    const normalizedInput = normalizeCompileInput(body)
    if (!normalizedInput.ok) {
      return c.json(failureBody(normalizedInput.diagnostics), 400)
    }
    const { flowInput } = normalizedInput.value
    const runId = c.req.query('runId') ?? ''
    const invocationOptions = makeCompileInvocationOptions(body, normalizedInput.value, runId)

    let requestedTarget: CompilationTarget | undefined
    if (body.target !== undefined) {
      if (!isAllowedTarget(body.target)) {
        return c.json(
          failureBody([
            makeRouteDiagnostic(
              1,
              'INVALID_ENUM_VALUE',
              `target must be one of ${ALLOWED_TARGETS.join(', ')}`,
            ),
          ]),
          400,
        )
      }
      requestedTarget = body.target
    }

    // --- Content negotiation ---
    const acceptHeader = c.req.header('accept') ?? ''
    const wantsSse = acceptHeader.includes('text/event-stream')
    // The simpler `?stream=true` opt-in produces a stage-vocabulary SSE stream
    // (parse/validate/lower/codegen + result) regardless of Accept header.
    const wantsStageStream = c.req.query('stream') === 'true'

    // Subprocess SSE branch (?subprocess=true) — only honoured when the client
    // also requests SSE; falls through to the JSON branch otherwise.
    if (wantsSse && c.req.query('subprocess') === 'true') {
      return handleSubprocessCompile(c, flowInput, { eventGateway: config.eventGateway })
    }

    if (wantsStageStream) {
      return handleStageStreamCompile({
        c,
        flowInput,
        invocationOptions,
        requestedTarget,
        config,
        effectivePersonaResolver,
        resolveToolResolver,
      })
    }

    if (wantsSse) {
      return handleSseCompile({
        c,
        flowInput,
        invocationOptions,
        runId,
        config,
        effectivePersonaResolver,
        resolveToolResolver,
      })
    }

    return handleJsonCompile({
      c,
      flowInput,
      invocationOptions,
      requestedTarget,
      runId,
      body,
      config,
      effectivePersonaResolver,
      resolveToolResolver,
    })
  })

  return app
}
