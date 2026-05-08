/**
 * HTTP handlers for workflow execution routes (textual + dry-run + stream + list).
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../types.js'
import { createSkillChain, WorkflowCommandParser } from '@dzupagent/core/pipeline'
import { secureLogger } from '@dzupagent/core/utils'
import {
  executeTextualWorkflow,
  streamTextualWorkflow,
  SkillChainExecutor,
} from '@dzupagent/agent'
import type { DryRunResult } from '@dzupagent/agent'
import { sanitizeError } from './route-error.js'
import {
  type DryRunBody,
  type ExecuteWorkflowBody,
  type WorkflowRouteConfig,
} from './workflows-types.js'
import { executeCompiledFlow } from './workflows-streaming.js'

export function createWorkflowRoutes(config: WorkflowRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

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
    let body: ExecuteWorkflowBody
    try {
      body = await c.req.json<ExecuteWorkflowBody>()
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
      secureLogger.error(`[workflows] execute: ${internal}`)
      return c.json(
        { error: { code: 'EXECUTION_ERROR', message: safe } },
        500,
      )
    }
  })

  // POST /dry-run — validate a workflow without executing
  app.post('/dry-run', async (c) => {
    let body: DryRunBody
    try {
      body = await c.req.json<DryRunBody>()
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
      secureLogger.error(`[workflows] dry-run: ${internal}`)
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
