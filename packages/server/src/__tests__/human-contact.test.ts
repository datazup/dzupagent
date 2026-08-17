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
import { recordPendingContact } from '../runtime/pending-contacts.js'

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

/**
 * Create a suspended run with `contactIds` registered as outstanding human
 * contact requests.
 *
 * Registration is mandatory since DZUPAGENT-AGENT-H-14: the respond route
 * now 404s on any `:contactId` the server never issued for the run, so a
 * fixture that skips this step is testing the rejection path, not the happy
 * path. (These tests previously posted arbitrary ids and expected 200 —
 * i.e. they asserted the bypass.)
 */
async function createSuspendedRun(
  config: ForgeServerConfig,
  status: Run['status'] = 'suspended',
  contactIds: string[] = [],
): Promise<Run> {
  const run = await config.runStore.create({
    agentId: 'agent-1',
    input: 'test input',
  })
  await config.runStore.update(run.id, { status })
  for (const contactId of contactIds) {
    await recordPendingContact(config.runStore, run.id, contactId)
  }
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
      const contactId = 'contact-001'
      const run = await createSuspendedRun(config, 'suspended', [contactId])

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
      const contactId = 'contact-002'
      const run = await createSuspendedRun(config, 'suspended', [contactId])

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, contactId, {
        type: 'approval',
        approved: true,
      })

      await vi.waitFor(() =>
        expect(events.find((e) => e['type'] === 'human_contact:responded')).toBeDefined(),
      )

      const contactEvent = events.find((e) => e['type'] === 'human_contact:responded')
      expect(contactEvent).toBeDefined()
      expect(contactEvent!['runId']).toBe(run.id)
      expect(contactEvent!['contactId']).toBe(contactId)

      const grantedEvent = events.find((e) => e['type'] === 'approval:granted')
      expect(grantedEvent).toBeDefined()
      expect(grantedEvent!['runId']).toBe(run.id)
      // DZUPAGENT-AGENT-H-14: the grant must name the contact it answers so a
      // consumer waiting on a different contact of this run will not take it.
      expect(grantedEvent!['contactId']).toBe(contactId)
    })
  })

  // -----------------------------------------------------------------------
  // 1b. DZUPAGENT-AGENT-H-14 — unknown contactId must not be laundered
  // -----------------------------------------------------------------------
  describe('POST — 404 when contactId is not outstanding for the run', () => {
    it('returns 404 for a contactId the server never issued', async () => {
      const run = await createSuspendedRun(config, 'suspended', ['contact-real'])

      const res = await postRespond(app, run.id, 'contact-forged', {
        type: 'approval',
        approved: true,
      })

      expect(res.status).toBe(404)
      const json = (await res.json()) as { error: { code: string; message: string } }
      expect(json.error.code).toBe('NOT_FOUND')
      expect(json.error.message).toContain('contact-forged')
    })

    it('emits no approval:granted for an unknown contactId', async () => {
      const run = await createSuspendedRun(config, 'suspended', ['contact-real2'])

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, 'contact-forged2', {
        type: 'approval',
        approved: true,
      })
      // No sleep needed: eventBus.emit() runs its handlers synchronously and the
      // route emits before responding, so awaiting postRespond above is already a
      // full ordering barrier. Any event would be in `events` by now.
      expect(events.find((e) => e['type'] === 'approval:granted')).toBeUndefined()
      expect(events.find((e) => e['type'] === 'human_contact:responded')).toBeUndefined()

      // The run must stay suspended -- a forged id cannot resume it.
      const updated = await config.runStore.get(run.id)
      expect(updated!.status).toBe('suspended')
    })

    it('returns 404 when the run has no outstanding contacts at all', async () => {
      const run = await createSuspendedRun(config)

      const res = await postRespond(app, run.id, 'contact-anything', {
        type: 'approval',
        approved: true,
      })

      expect(res.status).toBe(404)
    })

    it('a contactId outstanding on run A does not work on run B', async () => {
      const runA = await createSuspendedRun(config, 'suspended', ['contact-A'])
      const runB = await createSuspendedRun(config, 'suspended', ['contact-B'])

      const res = await postRespond(app, runB.id, 'contact-A', {
        type: 'approval',
        approved: true,
      })

      expect(res.status).toBe(404)
      // run A is untouched
      expect((await config.runStore.get(runA.id))!.status).toBe('suspended')
    })

    it('a responded contactId cannot be replayed', async () => {
      const run = await createSuspendedRun(config, 'suspended', ['contact-once'])

      const first = await postRespond(app, run.id, 'contact-once', {
        type: 'approval',
        approved: true,
      })
      expect(first.status).toBe(200)

      // Put the run back into a respondable state; the contact itself is spent.
      await config.runStore.update(run.id, { status: 'suspended' })

      const second = await postRespond(app, run.id, 'contact-once', {
        type: 'approval',
        approved: true,
      })
      expect(second.status).toBe(404)
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
      const run = await createSuspendedRun(config, 'awaiting_approval', ['contact-a'])

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
      const contactId = 'contact-reject-1'
      const run = await createSuspendedRun(config, 'suspended', [contactId])

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      const res = await postRespond(app, run.id, contactId, {
        type: 'approval',
        approved: false,
        comment: 'Not ready yet',
      })

      expect(res.status).toBe(200)

      await vi.waitFor(() =>
        expect(events.find((e) => e['type'] === 'approval:rejected')).toBeDefined(),
      )

      const rejectedEvent = events.find((e) => e['type'] === 'approval:rejected')
      expect(rejectedEvent).toBeDefined()
      expect(rejectedEvent!['runId']).toBe(run.id)
      expect(rejectedEvent!['reason']).toBe('Not ready yet')
    })

    it('uses default rejection reason when comment not provided', async () => {
      const run = await createSuspendedRun(config, 'suspended', ['contact-r2'])

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, 'contact-r2', {
        type: 'approval',
        approved: false,
      })

      await vi.waitFor(() =>
        expect(events.find((e) => e['type'] === 'approval:rejected')).toBeDefined(),
      )

      const rejectedEvent = events.find((e) => e['type'] === 'approval:rejected')
      expect(rejectedEvent).toBeDefined()
      expect(rejectedEvent!['reason']).toBe('Rejected via human contact')
    })

    it('does not emit approval:granted when rejected', async () => {
      const run = await createSuspendedRun(config, 'suspended', ['contact-r3'])

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, 'contact-r3', {
        type: 'approval',
        approved: false,
      })

      // Wait for the rejection to actually land, then assert no grant accompanied
      // it. Sentinel-then-absence is stricter than sleeping and hoping.
      await vi.waitFor(() =>
        expect(events.find((e) => e['type'] === 'approval:rejected')).toBeDefined(),
      )

      const grantedEvent = events.find((e) => e['type'] === 'approval:granted')
      expect(grantedEvent).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // 5. Clarification response
  // -----------------------------------------------------------------------
  describe('POST — clarification response', () => {
    it('stores the clarification answer in run metadata', async () => {
      const contactId = 'contact-clarify-1'
      const run = await createSuspendedRun(config, 'suspended', [contactId])

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
      const run = await createSuspendedRun(config, 'suspended', ['contact-c2'])

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, 'contact-c2', {
        type: 'clarification',
        answer: 'Something',
      })

      // Sentinel: the clarification response is delivered, and only then do we
      // assert that no approval-shaped event tagged along.
      await vi.waitFor(() =>
        expect(events.find((e) => e['type'] === 'human_contact:responded')).toBeDefined(),
      )

      const approvalEvents = events.filter(
        (e) =>
          e['type'] === 'approval:granted' || e['type'] === 'approval:rejected',
      )
      expect(approvalEvents).toHaveLength(0)
    })

    it('emits human_contact:responded event for clarification', async () => {
      const run = await createSuspendedRun(config, 'suspended', ['contact-c3'])

      const events: Array<Record<string, unknown>> = []
      config.eventBus.onAny((e) => events.push(e as unknown as Record<string, unknown>))

      await postRespond(app, run.id, 'contact-c3', {
        type: 'clarification',
        answer: 'Answer here',
      })

      await vi.waitFor(() =>
        expect(events.find((e) => e['type'] === 'human_contact:responded')).toBeDefined(),
      )

      const contactEvent = events.find((e) => e['type'] === 'human_contact:responded')
      expect(contactEvent).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // Validation edge cases
  // -----------------------------------------------------------------------
  describe('validation', () => {
    it('returns 400 for non-JSON body', async () => {
      const run = await createSuspendedRun(config, 'suspended', ['contact-x'])

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
