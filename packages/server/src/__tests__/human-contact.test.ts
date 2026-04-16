import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  type DzupEventBus,
  type Run,
} from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(): ForgeServerConfig & { eventBus: DzupEventBus } {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  }
}

async function createSuspendedRun(
  config: ForgeServerConfig,
  status: Run['status'] = 'suspended',
): Promise<Run> {
  const run = await config.runStore.create({
    agentId: 'agent-1',
    input: 'test input',
  })
  await config.runStore.update(run.id, { status })
  return { ...run, status }
}

async function postRespond(
  app: ReturnType<typeof createForgeApp>,
  runId: string,
  contactId: string,
  body: unknown,
): Promise<Response> {
  return app.request(
    `/api/runs/${runId}/human-contact/${contactId}/respond`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Human contact respond route', () => {
  let config: ReturnType<typeof createTestConfig>
  let app: ReturnType<typeof createForgeApp>

  beforeEach(() => {
    config = createTestConfig()
    app = createForgeApp(config)
  })

  // -----------------------------------------------------------------------
  // 1. Happy path: approval granted
  // -----------------------------------------------------------------------
  describe('POST /:id/human-contact/:contactId/respond — approval granted', () => {
    it('resumes the run and returns status resumed', async () => {
      const run = await createSuspendedRun(config)
      const contactId = 'contact-001'

      const res = await postRespond(app, run.id, contactId, {
        type: 'approval',
        approved: true,
        comment: 'LGTM',
      })

      expect(res.status).toBe(200)
      const json = (await res.json()) as { data: Record<string, unknown> }
      expect(json.data['runId']).toBe(run.id)
      expect(json.data['contactId']).toBe(contactId)
      expect(json.data['status']).toBe('resumed')

      // Verify run state updated
      const updated = await config.runStore.get(run.id)
      expect(updated!.status).toBe('running')
      const metadata = updated!.metadata as Record<string, unknown>
      const contactResp = metadata['humanContactResponse'] as Record<string, unknown>
      expect(contactResp['contactId']).toBe(contactId)
      expect(contactResp['approved']).toBe(true)
    })

    it('emits human_contact:responded and approval:granted events', async () => {
      const run = await createSuspendedRun(config)
      const contactId = 'contact-002'

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, contactId, {
        type: 'approval',
        approved: true,
      })

      // Give async event handlers time to fire
      await new Promise((r) => setTimeout(r, 50))

      const contactEvent = events.find((e) => e['type'] === 'human_contact:responded')
      expect(contactEvent).toBeDefined()
      expect(contactEvent!['runId']).toBe(run.id)
      expect(contactEvent!['contactId']).toBe(contactId)

      const grantedEvent = events.find((e) => e['type'] === 'approval:granted')
      expect(grantedEvent).toBeDefined()
      expect(grantedEvent!['runId']).toBe(run.id)
    })
  })

  // -----------------------------------------------------------------------
  // 2. 404 — run not found
  // -----------------------------------------------------------------------
  describe('POST — 404 when run not found', () => {
    it('returns 404 with NOT_FOUND error code', async () => {
      const res = await postRespond(app, 'nonexistent-run', 'contact-x', {
        type: 'approval',
        approved: true,
      })

      expect(res.status).toBe(404)
      const json = (await res.json()) as { error: { code: string; message: string } }
      expect(json.error.code).toBe('NOT_FOUND')
      expect(json.error.message).toContain('Run not found')
    })
  })

  // -----------------------------------------------------------------------
  // 3. 409 — wrong run state
  // -----------------------------------------------------------------------
  describe('POST — 409 when run not in suspended/awaiting_approval state', () => {
    it('returns 409 for a running run', async () => {
      const run = await config.runStore.create({
        agentId: 'agent-1',
        input: 'test',
      })
      await config.runStore.update(run.id, { status: 'running' })

      const res = await postRespond(app, run.id, 'contact-x', {
        type: 'approval',
        approved: true,
      })

      expect(res.status).toBe(409)
      const json = (await res.json()) as { error: { code: string; message: string } }
      expect(json.error.code).toBe('CONFLICT')
      expect(json.error.message).toContain('running')
    })

    it('returns 409 for a completed run', async () => {
      const run = await config.runStore.create({
        agentId: 'agent-1',
        input: 'test',
      })
      await config.runStore.update(run.id, { status: 'completed' })

      const res = await postRespond(app, run.id, 'contact-x', {
        type: 'approval',
        approved: true,
      })

      expect(res.status).toBe(409)
      const json = (await res.json()) as { error: { code: string; message: string } }
      expect(json.error.code).toBe('CONFLICT')
    })

    it('accepts awaiting_approval as a valid state', async () => {
      const run = await createSuspendedRun(config, 'awaiting_approval')

      const res = await postRespond(app, run.id, 'contact-a', {
        type: 'clarification',
        answer: 'Use PostgreSQL',
      })

      expect(res.status).toBe(200)
    })
  })

  // -----------------------------------------------------------------------
  // 4. Approval rejected flow
  // -----------------------------------------------------------------------
  describe('POST — approval rejected', () => {
    it('resumes the run and emits approval:rejected event', async () => {
      const run = await createSuspendedRun(config)
      const contactId = 'contact-reject-1'

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      const res = await postRespond(app, run.id, contactId, {
        type: 'approval',
        approved: false,
        comment: 'Not ready yet',
      })

      expect(res.status).toBe(200)

      // Give async event handlers time to fire
      await new Promise((r) => setTimeout(r, 50))

      const rejectedEvent = events.find((e) => e['type'] === 'approval:rejected')
      expect(rejectedEvent).toBeDefined()
      expect(rejectedEvent!['runId']).toBe(run.id)
      expect(rejectedEvent!['reason']).toBe('Not ready yet')
    })

    it('uses default rejection reason when comment not provided', async () => {
      const run = await createSuspendedRun(config)

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, 'contact-r2', {
        type: 'approval',
        approved: false,
      })

      await new Promise((r) => setTimeout(r, 50))

      const rejectedEvent = events.find((e) => e['type'] === 'approval:rejected')
      expect(rejectedEvent).toBeDefined()
      expect(rejectedEvent!['reason']).toBe('Rejected via human contact')
    })

    it('does not emit approval:granted when rejected', async () => {
      const run = await createSuspendedRun(config)

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, 'contact-r3', {
        type: 'approval',
        approved: false,
      })

      await new Promise((r) => setTimeout(r, 50))

      const grantedEvent = events.find((e) => e['type'] === 'approval:granted')
      expect(grantedEvent).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // 5. Clarification response
  // -----------------------------------------------------------------------
  describe('POST — clarification response', () => {
    it('stores the clarification answer in run metadata', async () => {
      const run = await createSuspendedRun(config)
      const contactId = 'contact-clarify-1'

      const res = await postRespond(app, run.id, contactId, {
        type: 'clarification',
        answer: 'Use the production database',
      })

      expect(res.status).toBe(200)

      const updated = await config.runStore.get(run.id)
      expect(updated!.status).toBe('running')
      const metadata = updated!.metadata as Record<string, unknown>
      const contactResp = metadata['humanContactResponse'] as Record<string, unknown>
      expect(contactResp['contactId']).toBe(contactId)
      expect(contactResp['answer']).toBe('Use the production database')
      expect(contactResp['type']).toBe('clarification')
    })

    it('does not emit approval events for clarification type', async () => {
      const run = await createSuspendedRun(config)

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, 'contact-c2', {
        type: 'clarification',
        answer: 'Something',
      })

      await new Promise((r) => setTimeout(r, 50))

      const approvalEvents = events.filter(
        (e) =>
          e['type'] === 'approval:granted' || e['type'] === 'approval:rejected',
      )
      expect(approvalEvents).toHaveLength(0)
    })

    it('emits human_contact:responded event for clarification', async () => {
      const run = await createSuspendedRun(config)

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, 'contact-c3', {
        type: 'clarification',
        answer: 'Answer here',
      })

      await new Promise((r) => setTimeout(r, 50))

      const contactEvent = events.find((e) => e['type'] === 'human_contact:responded')
      expect(contactEvent).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // Validation edge cases
  // -----------------------------------------------------------------------
  describe('validation', () => {
    it('returns 400 for non-JSON body', async () => {
      const run = await createSuspendedRun(config)

      const res = await app.request(
        `/api/runs/${run.id}/human-contact/contact-x/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not json',
        },
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
    })
  })
})
