import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import { validateBody, validateQuery } from '../route-validator.js'
import type { ValidationErrorResponse } from '../route-validator.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Hono app that exercises validateBody / validateQuery. */
function createTestApp() {
  const app = new Hono()

  const BodySchema = z.object({
    name: z.string(),
    age: z.number().int().min(0),
  })

  const QuerySchema = z.object({
    page: z.string(),
    limit: z.string().optional(),
  })

  app.post('/body', async (c) => {
    const data = await validateBody(c, BodySchema)
    if (data instanceof Response) return data
    return c.json({ ok: true, data })
  })

  app.get('/query', (c) => {
    const data = validateQuery(c, QuerySchema)
    if (data instanceof Response) return data
    return c.json({ ok: true, data })
  })

  return app
}

// ---------------------------------------------------------------------------
// validateBody
// ---------------------------------------------------------------------------

describe('validateBody', () => {
  const app = createTestApp()

  it('returns parsed data on valid input', async () => {
    const res = await app.request('/body', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', age: 30 }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; data: { name: string; age: number } }
    expect(json.ok).toBe(true)
    expect(json.data).toEqual({ name: 'Alice', age: 30 })
  })

  it('returns 400 with VALIDATION_ERROR for invalid body', async () => {
    const res = await app.request('/body', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 123, age: 'not-a-number' }),
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as ValidationErrorResponse
    expect(json.error).toBe('VALIDATION_ERROR')
    expect(Array.isArray(json.issues)).toBe(true)
    expect(json.issues.length).toBeGreaterThan(0)
    // Each issue should have the expected shape
    for (const issue of json.issues) {
      expect(issue).toHaveProperty('code')
      expect(issue).toHaveProperty('path')
      expect(issue).toHaveProperty('message')
    }
  })

  it('returns 400 when body is not valid JSON', async () => {
    const res = await app.request('/body', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as ValidationErrorResponse
    expect(json.error).toBe('VALIDATION_ERROR')
    expect(json.issues[0]?.code).toBe('invalid_json')
    expect(json.issues[0]?.message).toMatch(/not valid JSON/)
  })

  it('returns 400 when required field is missing', async () => {
    const res = await app.request('/body', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as ValidationErrorResponse
    expect(json.error).toBe('VALIDATION_ERROR')
    // The age field should appear in the issue path
    const ageIssue = json.issues.find((i) => i.path.includes('age'))
    expect(ageIssue).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// validateQuery
// ---------------------------------------------------------------------------

describe('validateQuery', () => {
  const app = createTestApp()

  it('returns parsed query params on valid input', async () => {
    const res = await app.request('/query?page=1&limit=20')

    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; data: { page: string; limit: string } }
    expect(json.ok).toBe(true)
    expect(json.data).toEqual({ page: '1', limit: '20' })
  })

  it('returns parsed query with optional params omitted', async () => {
    const res = await app.request('/query?page=1')

    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; data: { page: string } }
    expect(json.ok).toBe(true)
    expect(json.data.page).toBe('1')
  })

  it('returns 400 with VALIDATION_ERROR for missing required query param', async () => {
    const res = await app.request('/query')

    expect(res.status).toBe(400)
    const json = (await res.json()) as ValidationErrorResponse
    expect(json.error).toBe('VALIDATION_ERROR')
    expect(json.issues.length).toBeGreaterThan(0)
    const pageIssue = json.issues.find((i) => i.path.includes('page'))
    expect(pageIssue).toBeDefined()
  })
})
