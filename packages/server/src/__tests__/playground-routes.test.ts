/**
 * Tests for playground serving routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createPlaygroundRoutes } from '../routes/playground.js'

const testDir = resolve(tmpdir(), `pg-test-${Date.now()}`)

beforeAll(async () => {
  // Create a fake dist directory
  await mkdir(resolve(testDir, 'assets'), { recursive: true })
  await writeFile(resolve(testDir, 'index.html'), '<!DOCTYPE html><html><body>Playground</body></html>')
  await writeFile(resolve(testDir, 'assets', 'main.js'), 'console.log("app")')
  await writeFile(resolve(testDir, 'assets', 'style.css'), 'body { color: red; }')
  await writeFile(resolve(testDir, 'favicon.ico'), 'icon-data')
})

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function createTestApp(): Hono {
  const app = new Hono()
  app.route('/playground', createPlaygroundRoutes({ distDir: testDir }))
  return app
}

describe('playground routes', () => {
  it('serves index.html for the root path', async () => {
    const app = createTestApp()
    const res = await app.request('/playground/')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Playground')
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('serves static JS assets with correct MIME and cache headers', async () => {
    const app = createTestApp()
    const res = await app.request('/playground/assets/main.js')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('console.log')
    expect(res.headers.get('content-type')).toContain('application/javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  it('serves static CSS assets with correct MIME type', async () => {
    const app = createTestApp()
    const res = await app.request('/playground/assets/style.css')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('body')
    expect(res.headers.get('content-type')).toContain('text/css')
  })

  it('returns 404 for non-existent assets', async () => {
    const app = createTestApp()
    const res = await app.request('/playground/assets/nonexistent.js')
    expect(res.status).toBe(404)
  })

  it('SPA fallback: serves index.html for arbitrary non-asset routes', async () => {
    const app = createTestApp()
    const res = await app.request('/playground/some/deep/route')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Playground')
  })

  it('serves favicon.ico as a static asset', async () => {
    const app = createTestApp()
    const res = await app.request('/playground/favicon.ico')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/x-icon')
  })
})
