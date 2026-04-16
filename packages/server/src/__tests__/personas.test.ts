/**
 * Tests for persona CRUD routes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createPersonaRoutes } from '../routes/personas.js'
import { InMemoryPersonaStore } from '../personas/persona-store.js'
import type { PersonaRecord } from '../personas/persona-store.js'

function createTestApp() {
  const store = new InMemoryPersonaStore()
  const routes = createPersonaRoutes({ personaStore: store })
  const app = new Hono()
  app.route('/api/personas', routes)
  return { app, store }
}

describe('Persona REST routes', () => {
  let app: Hono
  let store: InMemoryPersonaStore

  beforeEach(() => {
    const ctx = createTestApp()
    app = ctx.app
    store = ctx.store
  })

  it('POST /api/personas creates a persona', async () => {
    const res = await app.request('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Helpful Assistant',
        instructions: 'You are a helpful assistant.',
      }),
    })

    expect(res.status).toBe(201)
    const persona = (await res.json()) as PersonaRecord
    expect(persona.name).toBe('Helpful Assistant')
    expect(persona.instructions).toBe('You are a helpful assistant.')
    expect(persona.id).toBeTruthy()
  })

  it('POST /api/personas returns 400 for missing fields', async () => {
    const res = await app.request('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No instructions' }),
    })

    expect(res.status).toBe(400)
  })

  it('POST /api/personas accepts optional fields', async () => {
    const res = await app.request('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'custom-persona',
        name: 'Expert',
        instructions: 'You are an expert.',
        modelId: 'gpt-4',
        temperature: 0.7,
        metadata: { domain: 'engineering' },
      }),
    })

    expect(res.status).toBe(201)
    const persona = (await res.json()) as PersonaRecord
    expect(persona.id).toBe('custom-persona')
    expect(persona.modelId).toBe('gpt-4')
    expect(persona.temperature).toBe(0.7)
  })

  it('GET /api/personas lists all personas', async () => {
    await app.request('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P1', instructions: 'i1' }),
    })
    await app.request('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P2', instructions: 'i2' }),
    })

    const res = await app.request('/api/personas')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { personas: PersonaRecord[] }
    expect(body.personas).toHaveLength(2)
  })

  it('GET /api/personas/:id returns a single persona', async () => {
    const createRes = await app.request('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fetch', instructions: 'fetched' }),
    })
    const created = (await createRes.json()) as PersonaRecord

    const res = await app.request(`/api/personas/${created.id}`)
    expect(res.status).toBe(200)
    const persona = (await res.json()) as PersonaRecord
    expect(persona.id).toBe(created.id)
    expect(persona.name).toBe('Fetch')
  })

  it('GET /api/personas/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/personas/nonexistent')
    expect(res.status).toBe(404)
  })

  it('PUT /api/personas/:id updates a persona', async () => {
    const createRes = await app.request('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Original', instructions: 'old instructions' }),
    })
    const created = (await createRes.json()) as PersonaRecord

    const updateRes = await app.request(`/api/personas/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated', instructions: 'new instructions', temperature: 0.5 }),
    })
    expect(updateRes.status).toBe(200)
    const updated = (await updateRes.json()) as PersonaRecord
    expect(updated.name).toBe('Updated')
    expect(updated.instructions).toBe('new instructions')
    expect(updated.temperature).toBe(0.5)
  })

  it('PUT /api/personas/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/personas/nonexistent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /api/personas/:id removes a persona', async () => {
    const createRes = await app.request('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ToDelete', instructions: 'bye' }),
    })
    const created = (await createRes.json()) as PersonaRecord

    const delRes = await app.request(`/api/personas/${created.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    const body = await delRes.json()
    expect(body).toEqual({ deleted: true })

    const getRes = await app.request(`/api/personas/${created.id}`)
    expect(getRes.status).toBe(404)
  })

  it('DELETE /api/personas/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/personas/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
