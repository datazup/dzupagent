/**
 * Branch coverage tests for playground routes.
 *
 * Covers: all MIME types, unknown extension fallback, index fallback when index.html missing,
 * SPA fallback with nested routes, empty path, explicit index request.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createPlaygroundRoutes } from '../routes/playground.js'

const testDir = resolve(tmpdir(), `pg-branch-test-${Date.now()}`)

beforeAll(async () => {
  await mkdir(resolve(testDir, 'assets'), { recursive: true })
  await writeFile(resolve(testDir, 'index.html'), '<!DOCTYPE html><html></html>')
  await writeFile(resolve(testDir, 'logo.png'), 'png')
  await writeFile(resolve(testDir, 'logo.jpg'), 'jpg')
  await writeFile(resolve(testDir, 'logo.svg'), '<svg/>')
  await writeFile(resolve(testDir, 'data.json'), '{}')
  await writeFile(resolve(testDir, 'font.woff'), 'woff')
  await writeFile(resolve(testDir, 'font.woff2'), 'woff2')
  await writeFile(resolve(testDir, 'font.ttf'), 'ttf')
  await writeFile(resolve(testDir, 'app.js.map'), '{}')
  await writeFile(resolve(testDir, 'mystery.bin'), 'unknown')
})

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function createTestApp(distDir: string): Hono {
  const app = new Hono()
  app.route('/pg', createPlaygroundRoutes({ distDir }))
  return app
}

describe('playground routes branch coverage', () => {
  it('returns correct MIME for .png', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/logo.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
  })

  it('returns correct MIME for .jpg', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/logo.jpg')
    expect(res.headers.get('content-type')).toContain('image/jpeg')
  })

  it('returns correct MIME for .svg', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/logo.svg')
    expect(res.headers.get('content-type')).toContain('image/svg+xml')
  })

  it('returns correct MIME for .json', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/data.json')
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('returns correct MIME for .woff', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/font.woff')
    expect(res.headers.get('content-type')).toContain('font/woff')
  })

  it('returns correct MIME for .woff2', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/font.woff2')
    expect(res.headers.get('content-type')).toContain('font/woff2')
  })

  it('returns correct MIME for .ttf', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/font.ttf')
    expect(res.headers.get('content-type')).toContain('font/ttf')
  })

  it('returns correct MIME for .map', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/app.js.map')
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/mystery.bin')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/octet-stream')
  })

  it('returns 404 for missing index.html in non-existent dist', async () => {
    const ghostDir = resolve(tmpdir(), `pg-ghost-${Date.now()}`)
    const app = createTestApp(ghostDir)
    const res = await app.request('/pg/any-spa-path')
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(text).toContain('/playground is a static asset host')
    expect(text).toContain('runtimeConfig.playground.distDir')
    expect(text).toContain("build the consuming app's playground assets")
    expect(text).not.toContain('yarn workspace @dzupagent/playground build')
  })

  it('SPA fallback serves index.html for multi-level routes', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/a/b/c/d')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('explicit .html request is treated as SPA fallback (not static)', async () => {
    const app = createTestApp(testDir)
    const res = await app.request('/pg/index.html')
    // isStaticAsset excludes .html → falls through to SPA fallback
    expect(res.status).toBe(200)
  })
})
