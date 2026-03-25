import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ForgeEvent } from '@forgeagent/core'
import type { EventGateway, EventSubscriptionFilter } from '../events/event-gateway.js'

export interface EventRouteConfig {
  eventGateway: EventGateway
}

function parseEventTypes(param: string | undefined): ForgeEvent['type'][] | undefined {
  if (!param) return undefined
  const parsed = param
    .split(',')
    .map((p) => p.trim())
    .filter((p): p is ForgeEvent['type'] => p.length > 0)
  return parsed.length > 0 ? parsed : undefined
}

export function createEventRoutes(config: EventRouteConfig): Hono {
  const app = new Hono()

  app.get('/stream', async (c) => {
    const filter: EventSubscriptionFilter = {
      runId: c.req.query('runId') ?? undefined,
      agentId: c.req.query('agentId') ?? undefined,
      eventTypes: parseEventTypes(c.req.query('types')),
    }

    return streamSSE(c, async (stream) => {
      let closed = false
      const subscription = config.eventGateway.subscribe(filter, (event) => {
        if (closed) return false
        stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        }).catch(() => {
          closed = true
        })
        return true
      }, { maxQueueSize: 1024, overflowStrategy: 'drop_oldest' })

      await stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({ ok: true }),
      })

      const heartbeat = setInterval(() => {
        if (closed) return
        stream.writeSSE({
          event: 'heartbeat',
          data: JSON.stringify({ ts: new Date().toISOString() }),
        }).catch(() => {
          closed = true
        })
      }, 15000)

      stream.onAbort(() => {
        closed = true
        clearInterval(heartbeat)
        subscription.unsubscribe()
      })

      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })
  })

  return app
}
