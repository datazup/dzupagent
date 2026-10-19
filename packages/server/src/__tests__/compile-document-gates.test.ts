/**
 * Document bodies go through the document gates on both routes.
 *
 * A `document` with `durability.resume.requireResumePoint: true` and no
 * reachable resume point is refused by `compileDocument` (RESUME_POINT_REQUIRED).
 * POST /compile and POST /execute must give that one verdict whatever
 * `?subprocess` says: the in-process path may not compile the root alone and
 * skip the document-level gate.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { SkillRegistry } from '@dzupagent/core'
import type { SkillStepResolver } from '@dzupagent/agent'
import { createCompileRoutes } from '../routes/compile.js'
import { createWorkflowRoutes } from '../routes/workflows-handlers.js'

const document = {
  dsl: 'dzupflow/v1',
  id: 'requires_resume',
  version: 1,
  durability: { resume: { requireResumePoint: true } },
  root: {
    type: 'sequence',
    id: 'root',
    nodes: [{ type: 'complete', id: 'done', result: 'ok' }],
  },
}

function buildApp(): Hono {
  const app = new Hono()
  app.route('/api/workflows', createCompileRoutes({}))
  const resolver: SkillStepResolver = {
    resolve: async (skillId) => ({ id: skillId, execute: async () => ({}) }),
    canResolve: () => true,
  }
  app.route('/api/workflows', createWorkflowRoutes({ skillRegistry: new SkillRegistry(), resolver }))
  return app
}

interface DiagnosticBody {
  errors?: Array<{ code?: string }>
  error?: { errors?: Array<{ code?: string }> }
}

function codesOf(body: DiagnosticBody): string[] {
  const errors = body.errors ?? body.error?.errors ?? []
  return errors.map((e) => e.code ?? '')
}

describe('document bodies run through the document gates', () => {
  const cases = [
    { route: 'compile', subprocess: false },
    { route: 'compile', subprocess: true },
    { route: 'execute', subprocess: false },
    { route: 'execute', subprocess: true },
  ] as const

  it.each(cases)(
    'POST /$route (subprocess=$subprocess) refuses requireResumePoint without a resume point',
    async ({ route, subprocess }) => {
      const app = buildApp()
      const query = subprocess ? '?subprocess=true' : ''
      const res = await app.request(`/api/workflows/${route}${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document }),
      })

      expect(res.status).toBe(400)
      expect(codesOf((await res.json()) as DiagnosticBody)).toContain('RESUME_POINT_REQUIRED')
    },
  )
})
