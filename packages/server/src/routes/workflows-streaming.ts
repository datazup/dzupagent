/**
 * Compiled-flow execution branch (JSON + SSE) for POST /execute.
 *
 * Pipeline:
 *   1. Validate the compile input; a failure gets the /compile `failureBody` envelope.
 *   2. Compile via `createFlowCompiler` with the configured tool/persona resolvers,
 *      through the same `compileNormalizedInput` path as POST /compile (DSL
 *      reaches `compileDsl`), projecting failure diagnostics like /compile.
 *   3. Enforce skill-chain target (only skill-chain artifacts are executable here).
 *   4. Hand the lowered `SkillChain` to `SkillChainExecutor.execute` (JSON branch)
 *      or `SkillChainExecutor.stream` (SSE branch — selected by Accept header).
 */
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { secureLogger } from '@dzupagent/core/utils'
import type { SkillChain } from '@dzupagent/core/pipeline'
import { SkillChainExecutor } from '@dzupagent/agent/workflow'
import { createFlowCompiler, type CompileResult } from '@dzupagent/flow-compiler'
import { sanitizeError } from './route-error.js'
import {
  compileNormalizedInput,
  makeCompileInvocationOptions,
  normalizeCompileInput,
} from './compile-input.js'
import {
  failureBody,
  logInternalCompileDiagnostics,
  toPublicCompileDiagnostic,
} from './compile/shared.js'
import {
  type ExecuteWorkflowBody,
  type WorkflowRouteConfig,
  ALLOWED_TARGETS,
  NOOP_TOOL_RESOLVER,
  isAllowedTarget,
} from './workflows-types.js'
import { resolveCompilePersonaResolver } from './workflows-validation.js'

/**
 * Handles the compiled-flow branch of POST /execute.
 *
 * `target` in the body is optional; when provided it must be `"skill-chain"`.
 * Any other target is rejected before compilation to fail fast.
 */
export async function executeCompiledFlow(
  // Narrowed to the Hono Context surface this helper actually consumes
  // (`json`, `req.header`, and pass-through into `streamSSE`).
  c: Context,
  body: ExecuteWorkflowBody,
  config: WorkflowRouteConfig,
): Promise<Response> {
  const normalizedInput = normalizeCompileInput(body)
  if (!normalizedInput.ok) {
    return c.json(failureBody(normalizedInput.diagnostics), 400)
  }
  const { flowInput } = normalizedInput.value

  // --- Validate body.target (optional) ---
  if (body.target !== undefined && !isAllowedTarget(body.target)) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: `target must be one of ${ALLOWED_TARGETS.join(', ')}`,
        },
      },
      400,
    )
  }

  // The execute route can only run skill-chain artifacts — reject up-front
  // if the caller requested a non-executable target.
  if (body.target !== undefined && body.target !== 'skill-chain') {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Only target="skill-chain" is supported for execute',
        },
      },
      400,
    )
  }

  // --- Compile the flow ---
  const effectivePersonaResolver = resolveCompilePersonaResolver(config.compile)
  const compiler = createFlowCompiler({
    toolResolver: config.compile?.toolResolver ?? NOOP_TOOL_RESOLVER,
    ...(effectivePersonaResolver ? { personaResolver: effectivePersonaResolver } : {}),
  })

  // Same input path as POST /compile: DSL goes to `compileDsl` with the raw
  // source so the dzupflow/v2 retry, catch and policy gates apply. Execute
  // carries no run correlation, hence the empty runId.
  let compileResult: CompileResult
  try {
    compileResult = await compileNormalizedInput(
      compiler,
      flowInput,
      makeCompileInvocationOptions(body, normalizedInput.value, ''),
    )
  } catch (err) {
    const { safe, internal } = sanitizeError(err)
    secureLogger.error(`[workflows] execute compile: ${internal}`)
    return c.json(
      { error: { code: 'COMPILE_ERROR', message: safe } },
      500,
    )
  }

  if ('errors' in compileResult) {
    // DZUPAGENT-ERR-H-02 (shared with /compile): infrastructure diagnostics
    // are logged with their original text, redacted in the response and
    // reported as 500; authored-flow diagnostics stay 400.
    const infrastructure = logInternalCompileDiagnostics(
      compileResult.errors,
      compileResult.compileId,
    )
    const errors = compileResult.errors.map(toPublicCompileDiagnostic)
    const firstStage = errors[0]?.stage ?? 1
    return c.json(
      {
        error: {
          code: 'COMPILE_ERROR',
          message: errors.map((e) => e.message).join('; '),
          stage: firstStage,
          compileId: compileResult.compileId,
          errors,
        },
      },
      infrastructure ? 500 : 400,
    )
  }

  // Only skill-chain artifacts can be executed by this route.
  if (compileResult.target !== 'skill-chain') {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: `Compiled target "${compileResult.target}" is not executable here — only skill-chain is supported`,
          compileId: compileResult.compileId,
        },
      },
      400,
    )
  }

  const chain = compileResult.artifact as SkillChain

  // --- Content negotiation: SSE vs JSON ---
  const acceptHeader = c.req.header('accept') ?? ''
  const wantsSse = acceptHeader.includes('text/event-stream')

  const executor = new SkillChainExecutor({
    resolver: config.resolver!,
    registry: config.skillRegistry!,
    eventBus: config.eventBus,
  })

  if (wantsSse) {
    return streamSSE(c, async (stream) => {
      let closed = false
      stream.onAbort(() => {
        closed = true
      })

      try {
        // Emit a synthetic header event so SSE consumers can correlate with
        // the compile lifecycle before any execution events fire.
        await stream.writeSSE({
          event: 'compile:completed',
          data: JSON.stringify({
            compileId: compileResult.compileId,
            target: compileResult.target,
            warnings: compileResult.warnings,
          }),
        })

        const events = executor.stream(chain, body.initialState ?? {})
        for await (const event of events) {
          if (closed) break
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }

        if (!closed) {
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({ ok: true, compileId: compileResult.compileId }),
          })
        }
      } catch (err) {
        if (!closed) {
          const { safe } = sanitizeError(err)
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: safe }),
          })
        }
      }
    })
  }

  // --- JSON branch ---
  try {
    const result = await executor.execute(chain, body.initialState ?? {})
    return c.json({
      result,
      compileId: compileResult.compileId,
      target: compileResult.target,
      warnings: compileResult.warnings,
    })
  } catch (err) {
    const { safe, internal } = sanitizeError(err)
    secureLogger.error(`[workflows] execute compiled: ${internal}`)
    return c.json(
      { error: { code: 'EXECUTION_ERROR', message: safe } },
      500,
    )
  }
}
