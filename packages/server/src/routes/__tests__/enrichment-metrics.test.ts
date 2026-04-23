import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { InMemoryRunStore } from '@dzupagent/core'
import { EnrichmentPipeline } from '@dzupagent/agent-adapters'
import { createEnrichmentMetricsRoute } from '../enrichment-metrics.js'

async function request(
  app: Hono,
  method: string,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
  })
  const json = (await response.json()) as Record<string, unknown>
  return { status: response.status, json }
}

describe('Enrichment metrics route', () => {
  let runStore: InMemoryRunStore
  let app: Hono
  let runId: string

  beforeEach(async () => {
    runStore = new InMemoryRunStore()
    const run = await runStore.create({ agentId: 'agent-1', input: 'hello' })
    runId = run.id

    const routes = createEnrichmentMetricsRoute({ runStore })
    app = new Hono()
    app.route('/api/v1/runs', routes)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 200 with metrics data for a valid run', async () => {
    vi.spyOn(EnrichmentPipeline, 'metrics').mockReturnValue({
      skills: { durationMs: 12 },
      memory: { durationMs: 5 },
      promptShaping: { durationMs: 3 },
    })

    const { status, json } = await request(app, 'GET', `/api/v1/runs/${runId}/enrichment-metrics`)

    expect(status).toBe(200)
    expect(json['data']).toBeDefined()
    const data = json['data'] as Record<string, unknown>
    expect((data['skills'] as { durationMs: number }).durationMs).toBe(12)
  })

  it('returns all three phase fields (skills, memory, promptShaping)', async () => {
    vi.spyOn(EnrichmentPipeline, 'metrics').mockReturnValue({
      skills: { durationMs: 7 },
      memory: { durationMs: 11 },
      promptShaping: { durationMs: 4 },
    })

    const { status, json } = await request(app, 'GET', `/api/v1/runs/${runId}/enrichment-metrics`)

    expect(status).toBe(200)
    const data = json['data'] as Record<string, unknown>
    expect(data['skills']).toEqual({ durationMs: 7 })
    expect(data['memory']).toEqual({ durationMs: 11 })
    expect(data['promptShaping']).toEqual({ durationMs: 4 })
  })

  it('returns 404 for unknown run id', async () => {
    const { status, json } = await request(
      app,
      'GET',
      '/api/v1/runs/does-not-exist/enrichment-metrics',
    )

    expect(status).toBe(404)
    const error = json['error'] as Record<string, unknown>
    expect(error['code']).toBe('RUN_NOT_FOUND')
    expect(typeof error['message']).toBe('string')
    expect(error['message']).toContain('does-not-exist')
  })

  it('handles metrics with missing/undefined phases gracefully', async () => {
    vi.spyOn(EnrichmentPipeline, 'metrics').mockReturnValue({
      skills: { durationMs: 2 },
      // memory and promptShaping intentionally omitted (phases skipped)
    })

    const { status, json } = await request(app, 'GET', `/api/v1/runs/${runId}/enrichment-metrics`)

    expect(status).toBe(200)
    const data = json['data'] as Record<string, unknown>
    expect(data['skills']).toEqual({ durationMs: 2 })
    expect(data['memory']).toBeUndefined()
    expect(data['promptShaping']).toBeUndefined()
  })
})
