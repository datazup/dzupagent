/**
 * Workflow execution routes.
 *
 * POST /execute          — Execute a workflow. Two mutually-exclusive modes:
 *                          * { text: "..." }          — parse text → skill chain → result
 *                          * { flow: <FlowNode> }     — compile flow → skill chain → result
 *                          When Accept: text/event-stream is negotiated with a
 *                          flow body, execution events are streamed as SSE.
 * POST /dry-run          — Validate a workflow without executing (dry-run check)
 * GET  /stream           — SSE stream of textual workflow execution events
 * GET  /                 — List named workflows from WorkflowRegistry
 */
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createSkillChain, WorkflowCommandParser } from '@dzupagent/core'
import type { SkillRegistry, WorkflowRegistry, SkillChain } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import {
  executeTextualWorkflow,
  streamTextualWorkflow,
  SkillChainExecutor,
} from '@dzupagent/agent'
import type { SkillStepResolver, DryRunResult } from '@dzupagent/agent'
import { createFlowCompiler } from '@dzupagent/flow-compiler'
import type { CompilationTarget } from '@dzupagent/flow-compiler'
import type { ToolResolver, AsyncToolResolver } from '@dzupagent/flow-ast'
import type { PersonaResolver, AsyncPersonaResolver } from '@dzupagent/flow-compiler'
import { sanitizeError } from './route-error.js'
import type { PersonaStore } from '../personas/persona-store.js'
import { createPersonaStoreResolver } from '../personas/persona-resolver.js'
import { normalizeCompileInput } from './compile-input.js'

/** Sync no-op resolver used when the host has not wired a domain catalog yet. */
const NOOP_TOOL_RESOLVER: ToolResolver = {
  resolve: () => null,
  listAvailable: () => [],
}

export interface WorkflowRouteConfig {
  /** Core SkillRegistry used for chain validation and resolver lookups. */
  skillRegistry?: SkillRegistry
  /** Optional WorkflowRegistry for named workflow lookup. */
  workflowRegistry?: WorkflowRegistry
  /** Skill step resolver that turns skill IDs into executable WorkflowSteps. */
  resolver?: SkillStepResolver
  /** EventBus for workflow event bridging. */
  eventBus?: DzupEventBus
  /**
   * Optional flow-compiler resolvers used by the compiled-flow execution path.
   * Mirrors the shape of `CompileRouteConfig` — when omitted, a no-op tool
   * resolver is used (and tool refs surface as stage-3 errors). When
   * `personaResolver` is omitted but `personaStore` is provided, the route
   * derives a resolver from the store.
   */
  compile?: {
    toolResolver?: ToolResolver | AsyncToolResolver
    personaResolver?: PersonaResolver | AsyncPersonaResolver
    personaStore?: PersonaStore
  }
}

function resolveCompilePersonaResolver(
  compile: WorkflowRouteConfig['compile'],
): PersonaResolver | AsyncPersonaResolver | undefined {
  return compile?.personaResolver
    ?? (compile?.personaStore ? createPersonaStoreResolver(compile.personaStore) : undefined)
}

export function createWorkflowRoutes(config: WorkflowRouteConfig): Hono {
  const app = new Hono()

  // Guard: return 503 if required dependencies are not configured
  app.use('*', async (c, next) => {
    if (!config.skillRegistry || !config.resolver) {
      return c.json(
        { error: { code: 'SERVICE_UNAVAILABLE', message: 'Workflow execution not configured (missing skillRegistry or resolver)' } },
        503,
      )
    }
    return next()
  })

  // POST /execute — execute a workflow (text or compiled-flow mode)
  app.post('/execute', async (c) => {
    let body: {
      text?: string
      flow?: unknown
      document?: unknown
      dsl?: unknown
      target?: unknown
      initialState?: Record<string, unknown>
    }
    try {
      body = await c.req.json<{
        text?: string
        flow?: unknown
        document?: unknown
        dsl?: unknown
        target?: unknown
        initialState?: Record<string, unknown>
      }>()
    } catch {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } },
        400,
      )
    }

    const hasFlow = body.flow !== undefined && body.flow !== null
    const hasDocument = body.document !== undefined && body.document !== null
    const hasDsl = body.dsl !== undefined && body.dsl !== null
    const hasCompileInput = hasFlow || hasDocument || hasDsl
    const hasText = typeof body.text === 'string' && body.text.trim().length > 0

    // Mutually exclusive branches — presence of flow wins
    if (hasCompileInput && hasText) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Provide either "text" or one compile input ("flow", "document", or "dsl"), not both',
          },
        },
        400,
      )
    }

    // --- Compiled-flow branch -------------------------------------------------
    if (hasCompileInput) {
      return executeCompiledFlow(c, body, config)
    }

    // --- Textual branch -------------------------------------------------------
    if (!hasText) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Either "text" (non-empty string) or one compile input ("flow", "document", or "dsl") is required',
          },
        },
        400,
      )
    }

    try {
      const result = await executeTextualWorkflow(
        body.text!,
        config.resolver!,
        body.initialState ?? {},
        {
          eventBus: config.eventBus,
          skillRegistry: config.skillRegistry!,
          registry: config.workflowRegistry,
        },
      )
      return c.json({ result })
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[workflows] execute: ${internal}`)
      return c.json(
        { error: { code: 'EXECUTION_ERROR', message: safe } },
        500,
      )
    }
  })

  // POST /dry-run — validate a workflow without executing
  app.post('/dry-run', async (c) => {
    let body: { steps?: string[]; text?: string }
    try {
      body = await c.req.json<{ steps?: string[]; text?: string }>()
    } catch {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } },
        400,
      )
    }

    // Resolve steps from body.steps or body.text
    let steps: string[]
    if (body.steps && Array.isArray(body.steps) && body.steps.length > 0) {
      steps = body.steps
    } else if (body.text && typeof body.text === 'string' && body.text.trim().length > 0) {
      // Parse text into steps
      const parser = new WorkflowCommandParser()
      const parseResult = await parser.parseAsync(body.text)
      if (!parseResult.ok) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: `Cannot parse workflow text: ${parseResult.reason}` } },
          400,
        )
      }
      steps = parseResult.steps.map(s => s.normalized)
    } else {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Either steps (string[]) or text (string) is required' } },
        400,
      )
    }

    try {
      const chain = createSkillChain(
        steps.join(' -> '),
        steps.map(skillName => ({ skillName })),
      )

      const executor = new SkillChainExecutor({
        resolver: config.resolver!,
        registry: config.skillRegistry!,
        eventBus: config.eventBus,
      })

      const dryRunResult: DryRunResult = executor.dryRun(chain)
      return c.json(dryRunResult)
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[workflows] dry-run: ${internal}`)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: safe } },
        400,
      )
    }
  })

  // GET /stream — SSE stream of workflow execution events
  app.get('/stream', async (c) => {
    const text = c.req.query('text')
    if (!text || text.trim().length === 0) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'text query parameter is required' } },
        400,
      )
    }

    let initialState: Record<string, unknown> = {}
    const initialStateParam = c.req.query('initialState')
    if (initialStateParam) {
      try {
        initialState = JSON.parse(initialStateParam) as Record<string, unknown>
      } catch {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: 'initialState must be valid JSON' } },
          400,
        )
      }
    }

    return streamSSE(c, async (stream) => {
      let closed = false

      stream.onAbort(() => {
        closed = true
      })

      try {
        const events = streamTextualWorkflow(
          text,
          config.resolver!,
          initialState,
          {
            eventBus: config.eventBus,
            skillRegistry: config.skillRegistry!,
            registry: config.workflowRegistry,
          },
        )

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
            data: JSON.stringify({ ok: true }),
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
  })

  // GET / — list named workflows from WorkflowRegistry
  app.get('/', async (c) => {
    if (!config.workflowRegistry) {
      return c.json({ workflows: [] })
    }

    try {
      const entries = config.workflowRegistry.list()
      return c.json({
        workflows: entries.map(e => ({
          name: e.name,
          description: e.description,
          tags: e.tags,
          stepCount: e.stepCount,
        })),
      })
    } catch {
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
        500,
      )
    }
  })

  return app
}

// ---------------------------------------------------------------------------
// Compiled-flow helpers
// ---------------------------------------------------------------------------

const ALLOWED_TARGETS: readonly CompilationTarget[] = [
  'skill-chain',
  'workflow-builder',
  'pipeline',
] as const

function isAllowedTarget(v: unknown): v is CompilationTarget {
  return typeof v === 'string' && (ALLOWED_TARGETS as readonly string[]).includes(v)
}

/**
 * Handles the compiled-flow branch of POST /execute.
 *
 * Pipeline:
 *   1. Validate `flow` is a JSON-parseable string or object.
 *   2. Compile via `createFlowCompiler` with the configured tool/persona resolvers.
 *   3. Enforce skill-chain target (only skill-chain artifacts are executable here).
 *   4. Hand the lowered `SkillChain` to `SkillChainExecutor.execute` (JSON branch)
 *      or `SkillChainExecutor.stream` (SSE branch — selected by Accept header).
 *
 * `target` in the body is optional; when provided it must be `"skill-chain"`.
 * Any other target is rejected before compilation to fail fast.
 */
async function executeCompiledFlow(
  // Narrowed to the Hono Context surface this helper actually consumes
  // (`json`, `req.header`, and pass-through into `streamSSE`).
  c: Context,
  body: {
    flow?: unknown
    document?: unknown
    dsl?: unknown
    target?: unknown
    initialState?: Record<string, unknown>
  },
  config: WorkflowRouteConfig,
): Promise<Response> {
  const normalizedInput = normalizeCompileInput(body)
  if (!normalizedInput.ok) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: normalizedInput.diagnostics.map((d) => d.message).join('; '),
          stage: normalizedInput.diagnostics[0]?.stage ?? 1,
          errors: normalizedInput.diagnostics,
        },
      },
      400,
    )
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

  let compileResult: Awaited<ReturnType<typeof compiler.compile>>
  try {
    compileResult = await compiler.compile(flowInput)
  } catch (err) {
    const { safe, internal } = sanitizeError(err)
    console.error(`[workflows] execute compile: ${internal}`)
    return c.json(
      { error: { code: 'COMPILE_ERROR', message: safe } },
      500,
    )
  }

  if ('errors' in compileResult) {
    const firstStage = compileResult.errors[0]?.stage ?? 1
    return c.json(
      {
        error: {
          code: 'COMPILE_ERROR',
          message: compileResult.errors.map((e) => e.message).join('; '),
          stage: firstStage,
          compileId: compileResult.compileId,
          errors: compileResult.errors,
        },
      },
      400,
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
    console.error(`[workflows] execute compiled: ${internal}`)
    return c.json(
      { error: { code: 'EXECUTION_ERROR', message: safe } },
      500,
    )
  }
}
