import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  generateDockerfile,
  generateDockerCompose,
  generateDockerignore,
} from '../deploy/docker-generator.js'
import { checkHealth } from '../deploy/health-checker.js'

describe('generateDockerfile', () => {
  it('generates a multi-stage Dockerfile', () => {
    const result = generateDockerfile({ projectName: 'my-app' })
    expect(result).toContain('FROM node:20-alpine AS builder')
    expect(result).toContain('FROM node:20-alpine AS runner')
  })

  it('uses specified Node version', () => {
    const result = generateDockerfile({ projectName: 'app', nodeVersion: '22' })
    expect(result).toContain('FROM node:22-alpine AS builder')
    expect(result).toContain('FROM node:22-alpine AS runner')
  })

  it('uses default port 4000', () => {
    const result = generateDockerfile({ projectName: 'app' })
    expect(result).toContain('EXPOSE 4000')
  })

  it('uses specified port', () => {
    const result = generateDockerfile({ projectName: 'app', port: 8080 })
    expect(result).toContain('EXPOSE 8080')
  })

  it('creates a non-root user', () => {
    const result = generateDockerfile({ projectName: 'app' })
    expect(result).toContain('adduser')
    expect(result).toContain('appuser')
    expect(result).toContain('USER appuser')
  })

  it('includes build and run commands', () => {
    const result = generateDockerfile({ projectName: 'app' })
    expect(result).toContain('npm run build')
    expect(result).toContain('CMD ["node", "dist/index.js"]')
  })
})

describe('generateDockerCompose', () => {
  it('generates compose with app service', () => {
    const result = generateDockerCompose({ projectName: 'my-app' })
    expect(result).toContain('services:')
    expect(result).toContain('app:')
    expect(result).toContain('container_name: my-app')
  })

  it('uses default port 4000', () => {
    const result = generateDockerCompose({ projectName: 'app' })
    expect(result).toContain('"4000:4000"')
  })

  it('includes postgres when requested', () => {
    const result = generateDockerCompose({
      projectName: 'my-app',
      includePostgres: true,
    })
    expect(result).toContain('postgres:')
    expect(result).toContain('POSTGRES_USER=forge')
    expect(result).toContain('POSTGRES_DB=my-app')
    expect(result).toContain('depends_on:')
    expect(result).toContain('pgdata:')
  })

  it('excludes postgres by default', () => {
    const result = generateDockerCompose({ projectName: 'app' })
    expect(result).not.toContain('postgres:')
    expect(result).not.toContain('POSTGRES_USER')
  })
})

describe('generateDockerignore', () => {
  it('includes standard patterns', () => {
    const result = generateDockerignore()
    expect(result).toContain('node_modules')
    expect(result).toContain('.git')
    expect(result).toContain('dist')
    expect(result).toContain('.env')
  })
})

describe('checkHealth', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns healthy for 200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('OK', { status: 200 }),
    )

    const result = await checkHealth('http://localhost:4000/api/health')
    expect(result.healthy).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.error).toBeUndefined()
  })

  it('returns unhealthy for 500 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Error', { status: 500 }),
    )

    const result = await checkHealth('http://localhost:4000/api/health')
    expect(result.healthy).toBe(false)
    expect(result.statusCode).toBe(500)
    expect(result.error).toContain('Unexpected status')
  })

  it('returns unhealthy on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Connection refused'),
    )

    const result = await checkHealth('http://localhost:4000/api/health')
    expect(result.healthy).toBe(false)
    expect(result.error).toContain('Connection refused')
  })

  it('returns unhealthy on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new DOMException('The operation was aborted', 'AbortError')),
    )

    const result = await checkHealth('http://localhost:4000/api/health', 100)
    expect(result.healthy).toBe(false)
    expect(result.error).toContain('Timeout')
  })
})
