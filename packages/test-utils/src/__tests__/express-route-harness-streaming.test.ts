import { test, expect } from 'vitest'
import express from 'express'
import { createExpressRouteHarness } from '../express-route-harness.js'

test('Express harness captures streamed headers and handles route errors', async () => {
  const harness = createExpressRouteHarness(() => {
    const app = express()
    app.get('/stream', (_req, res) => {
      res.writeHead(201, { 'X-Fixture': 'value' })
      res.setHeader('X-List', ['a', 'b'])
      res.write(Buffer.from('first'))
      res.end('last')
    })
    return app
  }, { originalUrl: url => '/prefix' + url })
  const response = await harness.dispatch({ method: 'GET', url: '/stream', headers: { 'X-Fixture': 'input' } })
  expect(response.statusCode).toBe(201)
  expect(response.getHeader('X-List')).toBe('a,b')
  expect(response.getHeaders()).toMatchObject({ 'x-fixture': 'value' })
  expect(response.writableEnded).toBe(true)
  expect(response.headersSent).toBe(true)
  expect(response.state.chunks).toEqual(['first', 'last'])
})
