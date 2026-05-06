/**
 * Cluster Workspace routes for multi-role agent teams.
 *
 * POST   /api/clusters                      — Create a cluster
 * GET    /api/clusters/:id                   — Get cluster info
 * DELETE /api/clusters/:id                   — Disband cluster
 * POST   /api/clusters/:id/roles             — Add role
 * DELETE /api/clusters/:id/roles/:roleId     — Remove role
 * POST   /api/clusters/:id/mail              — Route mail (or broadcast with to: "*")
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { randomUUID } from 'node:crypto'
import type { MailboxStore, MailMessage } from '@dzupagent/agent'
import type { ClusterStore } from '../persistence/drizzle-cluster-store.js'
import {
  ClusterCreateSchema,
  ClusterMailSchema,
  ClusterRoleCreateSchema,
  validateBodyCompat,
} from './schemas.js'
import { getRequestingTenantId } from './tenant-scope.js'

export interface ClusterRouteConfig {
  clusterStore: ClusterStore
  mailboxStore: MailboxStore
}

export function createClusterRoutes(config: ClusterRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const { clusterStore, mailboxStore } = config

  // POST / — Create a cluster
  app.post('/', async (c) => {
    const tenantId = getRequestingTenantId(c)
    const parsed = await validateBodyCompat(c, ClusterCreateSchema)
    if (parsed instanceof Response) return parsed
    const body = parsed

    const clusterId = body.clusterId ?? randomUUID()

    try {
      const record = await clusterStore.create({
        id: clusterId,
        workspaceType: body.workspaceType,
        workspaceOptions: body.workspaceOptions,
        tenantId,
      })

      return c.json(record, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('Conflict:')) {
        return c.json({ error: { code: 'CONFLICT', message } }, 409)
      }
      throw err
    }
  })

  // GET /:id — Get cluster info
  app.get('/:id', async (c) => {
    const id = c.req.param('id')
    const record = await clusterStore.findById(id, getRequestingTenantId(c))

    if (!record) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `Cluster "${id}" not found` } },
        404,
      )
    }

    return c.json(record)
  })

  // DELETE /:id — Disband cluster
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const deleted = await clusterStore.delete(id, getRequestingTenantId(c))

    if (!deleted) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `Cluster "${id}" not found` } },
        404,
      )
    }

    return c.body(null, 204)
  })

  // POST /:id/roles — Add role
  app.post('/:id/roles', async (c) => {
    const clusterId = c.req.param('id')
    const tenantId = getRequestingTenantId(c)
    const parsed = await validateBodyCompat(c, ClusterRoleCreateSchema)
    if (parsed instanceof Response) return parsed
    const body = parsed

    try {
      await clusterStore.addRole(
        clusterId,
        {
          roleId: body.roleId,
          agentId: body.agentId,
          capabilities: body.capabilities,
        },
        tenantId,
      )

      return c.json({ roleId: body.roleId, agentId: body.agentId, capabilities: body.capabilities ?? [] }, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('NotFound:')) {
        return c.json({ error: { code: 'NOT_FOUND', message } }, 404)
      }
      if (message.startsWith('Conflict:')) {
        return c.json({ error: { code: 'CONFLICT', message } }, 409)
      }
      throw err
    }
  })

  // DELETE /:id/roles/:roleId — Remove role
  app.delete('/:id/roles/:roleId', async (c) => {
    const clusterId = c.req.param('id')
    const roleId = c.req.param('roleId')
    const tenantId = getRequestingTenantId(c)

    try {
      const removed = await clusterStore.removeRole(clusterId, roleId, tenantId)

      if (!removed) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: `Role "${roleId}" not found in cluster "${clusterId}"` } },
          404,
        )
      }

      return c.body(null, 204)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('NotFound:')) {
        return c.json({ error: { code: 'NOT_FOUND', message } }, 404)
      }
      throw err
    }
  })

  // POST /:id/mail — Route mail (or broadcast with to: "*")
  app.post('/:id/mail', async (c) => {
    const clusterId = c.req.param('id')
    const tenantId = getRequestingTenantId(c)
    const parsed = await validateBodyCompat(c, ClusterMailSchema)
    if (parsed instanceof Response) return parsed
    const body = parsed

    // Look up the cluster and roles
    const cluster = await clusterStore.findById(clusterId, tenantId)
    if (!cluster) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `Cluster "${clusterId}" not found` } },
        404,
      )
    }

    const roleMap = new Map(cluster.roles.map((r) => [r.roleId, r]))

    const fromRole = roleMap.get(body.from)
    if (!fromRole) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `Sender role "${body.from}" not found in cluster "${clusterId}"` } },
        404,
      )
    }

    if (body.to === '*') {
      // Broadcast
      const targets = cluster.roles.filter((r) => r.roleId !== body.from)
      const messages: MailMessage[] = []

      for (const target of targets) {
        const msg: MailMessage = {
          id: randomUUID(),
          from: fromRole.agentId,
          to: target.agentId,
          subject: body.message.subject,
          body: body.message.body,
          createdAt: Date.now(),
          ttl: body.message.ttl,
        }
        await mailboxStore.save(msg)
        messages.push(msg)
      }

      return c.json({ delivered: messages.length, messages })
    } else {
      // Point-to-point
      const toRole = roleMap.get(body.to)
      if (!toRole) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: `Recipient role "${body.to}" not found in cluster "${clusterId}"` } },
          404,
        )
      }

      const msg: MailMessage = {
        id: randomUUID(),
        from: fromRole.agentId,
        to: toRole.agentId,
        subject: body.message.subject,
        body: body.message.body,
        createdAt: Date.now(),
        ttl: body.message.ttl,
      }
      await mailboxStore.save(msg)

      return c.json(msg)
    }
  })

  return app
}
