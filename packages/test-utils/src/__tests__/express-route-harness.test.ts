import express, { type Request, type Response } from 'express'
import { describe, expect, it } from 'vitest'
import { createExpressRouteHarness } from '../express-route-harness.js'

describe('createExpressRouteHarness', () => {
  it('dispatches mounted Express routes and captures payloads', async () => {
    const harness = createExpressRouteHarness(() => {
      const app = express()
      app.get('/health', (_req: Request, res: Response) => {
        res.json({ ok: true })
      })
      return app
    })

    const res = await harness.dispatch({
      method: 'GET',
      url: '/health',
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toEqual({ ok: true })
  })

  it('times out with a concrete route message when a response never finishes', async () => {
    const harness = createExpressRouteHarness(() => {
      const app = express()
      app.get('/hang', (_req: Request, _res: Response) => {
        // Intentionally never resolves.
      })
      return app
    })

    await expect(harness.dispatch({
      method: 'GET',
      url: '/hang',
      timeoutMs: 20,
    })).rejects.toThrow('Timed out waiting for GET /hang to finish')
  })
})
