/**
 * Human contact response route.
 *
 * POST /api/runs/:id/human-contact/:contactId/respond
 *
 * Runtime-bound contacts require an opaque resume token. The server retains
 * only its digest, consumes the contact once, and returns an idempotent receipt
 * for exact-token retries. Legacy string-only contacts remain compatible.
 */
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../types.js'
import type { ForgeServerConfig } from '../composition/types.js'
import { isAtomicRunStore } from '@dzupagent/core/persistence'
import { requireOwnedRun } from './run-guard.js'
import {
  consumePendingContact,
  HUMAN_CONTACT_RESUME_TOKEN_HEADER,
  isPendingContact,
  matchesResumeToken,
  markContactPublicationPublished,
  readPendingContactBinding,
  readResolvedContact,
  resolvedContactReceipt,
  withResolvedContact,
  withoutPendingContact,
} from '../runtime/pending-contacts.js'

function notFoundMessage(contactId: string): {
  error: { code: 'NOT_FOUND'; message: string }
} {
  return {
    error: {
      code: 'NOT_FOUND',
      message: `No outstanding human contact request "${contactId}" for this run`,
    },
  }
}

export function createHumanContactRoutes(config: ForgeServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const { runStore, eventBus } = config
  const contactLocks = new Map<string, Promise<void>>()

  async function withContactLock<T>(
    key: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = contactLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => gate)
    contactLocks.set(key, queued)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (contactLocks.get(key) === queued) contactLocks.delete(key)
    }
  }

  app.post('/:id/human-contact/:contactId/respond', async (c) => {
    const runId = c.req.param('id')
    const contactId = c.req.param('contactId')

    let body: Record<string, unknown>
    try {
      body = await c.req.json<Record<string, unknown>>()
    } catch {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' } },
        400,
      )
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Request body must be a JSON object' } },
        400,
      )
    }

    // A body field with this name is never a credential source and must not be
    // copied into metadata or events. Runtime-bound credentials arrive only in
    // the dedicated header.
    const safeBody = { ...body }
    delete safeBody['resumeToken']
    const resumeToken = c.req.header(HUMAN_CONTACT_RESUME_TOKEN_HEADER)

    const respond = async () => {
      const run = await requireOwnedRun(c, runId, runStore)
      if (run instanceof Response) return run
      const tenantId = run.tenantId ?? 'default'

      const responseType = typeof safeBody['type'] === 'string'
        ? safeBody['type']
        : 'unknown'

      if (isAtomicRunStore(runStore)) {
        const publicationClaimId = randomUUID()
        const publicationNow = new Date()
        const consumed = await consumePendingContact(runStore, {
          runId,
          tenantId,
          contactId,
          resumeToken,
          response: safeBody,
          responseType,
          respondedAt: publicationNow.toISOString(),
          publicationClaimId,
          publicationLeaseExpiresAt: new Date(
            publicationNow.getTime() + 30_000,
          ).toISOString(),
        })
        if (consumed.status === 'not_found') {
          return c.json(notFoundMessage(contactId), 404)
        }
        if (consumed.status === 'run_conflict') {
          return c.json(
            {
              error: {
                code: 'CONFLICT',
                message: `Run is in "${consumed.run.status}" state; expected "suspended" or "awaiting_approval"`,
              },
            },
            409,
          )
        }
        if (consumed.status === 'contention') {
          return c.json(
            {
              error: {
                code: 'CONFLICT',
                message: 'Human contact response is being processed; retry safely',
              },
            },
            409,
          )
        }
        if (consumed.status === 'already_consumed' && !consumed.publication) {
          return c.json({
            data: { runId, contactId, status: 'already_resumed' },
          })
        }

        const publication = consumed.publication
        if (!publication) {
          await publishResponse(runId, contactId, responseType, safeBody)
          return c.json({
            data: { runId, contactId, status: 'resumed' },
          })
        }
        await publishResponse(
          runId,
          contactId,
          publication.responseType,
          consumed.publicationResponse ?? safeBody,
          publication.publicationId,
        )
        const published = await markContactPublicationPublished(runStore, {
          runId,
          contactId,
          publicationClaimId,
          publishedAt: new Date().toISOString(),
        })
        if (!published) {
          throw new Error('HUMAN_CONTACT_PUBLICATION_COMMIT_FAILED')
        }
        return c.json({
          data: {
            runId,
            contactId,
            status: consumed.status === 'consumed' ? 'resumed' : 'already_resumed',
          },
        })
      }

      const resolved = readResolvedContact(run, contactId)
      if (resolved) {
        if (
          resolved.runId !== runId
          || resolved.tenantId !== tenantId
          || !matchesResumeToken(resolved.resumeTokenHash, resumeToken)
        ) {
          return c.json(notFoundMessage(contactId), 404)
        }
        return c.json({
          data: { runId, contactId, status: 'already_resumed' },
        })
      }

      if (run.status !== 'suspended' && run.status !== 'awaiting_approval') {
        return c.json(
          {
            error: {
              code: 'CONFLICT',
              message: `Run is in "${run.status}" state; expected "suspended" or "awaiting_approval"`,
            },
          },
          409,
        )
      }

      const binding = readPendingContactBinding(run, contactId)
      if (
        !isPendingContact(run, contactId)
        || (binding !== null && (
          binding.runId !== runId
          || binding.tenantId !== tenantId
          || !matchesResumeToken(binding.resumeTokenHash, resumeToken)
        ))
      ) {
        return c.json(notFoundMessage(contactId), 404)
      }

      let nextMetadata = withoutPendingContact(
        (run.metadata as Record<string, unknown> | undefined) ?? {},
        contactId,
      )
      if (binding) {
        nextMetadata = withResolvedContact(
          nextMetadata,
          resolvedContactReceipt(binding, responseType),
        )
      }

      await runStore.update(runId, {
        status: 'running',
        metadata: {
          ...nextMetadata,
          humanContactResponse: {
            contactId,
            respondedAt: new Date().toISOString(),
            ...safeBody,
          },
        },
      })

      await publishResponse(runId, contactId, responseType, safeBody)

      return c.json({
        data: { runId, contactId, status: 'resumed' },
      })
    }

    async function publishResponse(
      publishedRunId: string,
      publishedContactId: string,
      responseType: string,
      response: Record<string, unknown>,
      publicationId?: string,
    ): Promise<void> {
      await runStore.addLog(publishedRunId, {
        level: 'info',
        phase: 'human_contact',
        message: `Human contact response received for ${publishedContactId}`,
        data: { contactId: publishedContactId, responseType, publicationId },
      })

      eventBus.emit({
        type: 'human_contact:responded',
        runId: publishedRunId,
        contactId: publishedContactId,
        response,
        ...(publicationId === undefined ? {} : { publicationId }),
      })

      if (response['type'] === 'approval') {
        const approved = response['approved'] === true
        if (approved) {
          eventBus.emit({
            type: 'approval:granted',
            runId: publishedRunId,
            contactId: publishedContactId,
          })
        } else {
          eventBus.emit({
            type: 'approval:rejected',
            runId: publishedRunId,
            reason: typeof response['comment'] === 'string'
              ? response['comment']
              : 'Rejected via human contact',
          })
        }
      }
    }

    return isAtomicRunStore(runStore)
      ? respond()
      : withContactLock(`${runId}\0${contactId}`, respond)
  })

  return app
}
