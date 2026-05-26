import { describe, it, expect } from 'vitest'
import {
  sanitizeRunMetadataForPersistence,
  sanitizeRunForResponse,
} from '../security/run-metadata-secrets.js'
import type { Run } from '@dzupagent/core/persistence'

describe('sanitizeRunMetadataForPersistence', () => {
  it('returns undefined for null or undefined input', () => {
    expect(sanitizeRunMetadataForPersistence(null)).toBeUndefined()
    expect(sanitizeRunMetadataForPersistence(undefined)).toBeUndefined()
  })

  it('removes top-level secret keys', () => {
    const result = sanitizeRunMetadataForPersistence({
      githubToken: 'gh_token',
      slackToken: 'xoxb-xxx',
      httpHeaders: { Authorization: 'Bearer abc' },
      httpAuthorization: 'Bearer abc',
      httpBearerToken: 'tok',
      mcpEnv: { SECRET: 'val' },
      mcpHeaders: { 'x-api-key': 'key' },
      safe: 'value',
    })
    expect(result).not.toHaveProperty('githubToken')
    expect(result).not.toHaveProperty('slackToken')
    expect(result).not.toHaveProperty('httpHeaders')
    expect(result).not.toHaveProperty('httpAuthorization')
    expect(result).not.toHaveProperty('httpBearerToken')
    expect(result).not.toHaveProperty('mcpEnv')
    expect(result).not.toHaveProperty('mcpHeaders')
    expect(result?.safe).toBe('value')
  })

  it('strips env and headers from mcpServers entries', () => {
    const result = sanitizeRunMetadataForPersistence({
      mcpServers: [
        { name: 'my-server', env: { SECRET: 'val' }, headers: { Authorization: 'tok' } },
      ],
    })
    const server = (result?.mcpServers as unknown[])?.[0] as Record<string, unknown>
    expect(server).not.toHaveProperty('env')
    expect(server).not.toHaveProperty('headers')
    expect(server.name).toBe('my-server')
  })

  it('redacts nested password strings (depth-2)', () => {
    const result = sanitizeRunMetadataForPersistence({
      db: { password: 'secret123', host: 'localhost' },
    }) as Record<string, Record<string, unknown>>
    expect(result?.db?.password).toBe('[REDACTED]')
    expect(result?.db?.host).toBe('localhost')
  })

  it('redacts nested token strings', () => {
    const result = sanitizeRunMetadataForPersistence({
      auth: { token: 'some-jwt-value', userId: '42' },
    }) as Record<string, Record<string, unknown>>
    expect(result?.auth?.token).toBe('[REDACTED]')
    expect(result?.auth?.userId).toBe('42')
  })

  it('redacts credential strings inside arrays', () => {
    const result = sanitizeRunMetadataForPersistence({
      envVars: ['password=abc123', 'HOST=example.com', 'apikey=xyz'],
    }) as Record<string, string[]>
    expect(result?.envVars?.[0]).toBe('[REDACTED]')
    expect(result?.envVars?.[1]).toBe('HOST=example.com')
    expect(result?.envVars?.[2]).toBe('[REDACTED]')
  })

  it('preserves non-credential string values unchanged', () => {
    const result = sanitizeRunMetadataForPersistence({
      repo: 'my-org/my-repo',
      branch: 'main',
      tags: ['ci', 'deploy'],
    })
    expect(result?.repo).toBe('my-org/my-repo')
    expect(result?.branch).toBe('main')
    expect(result?.tags).toEqual(['ci', 'deploy'])
  })

  it('preserves numeric and boolean values unchanged', () => {
    const result = sanitizeRunMetadataForPersistence({
      retryCount: 3,
      enabled: true,
    })
    expect(result?.retryCount).toBe(3)
    expect(result?.enabled).toBe(true)
  })

  it('handles deeply nested credential strings', () => {
    const result = sanitizeRunMetadataForPersistence({
      config: { nested: { deep: { secret: 'topsecret' } } },
    }) as Record<string, Record<string, Record<string, Record<string, unknown>>>>
    expect(result?.config?.nested?.deep?.secret).toBe('[REDACTED]')
  })
})

describe('sanitizeRunForResponse', () => {
  it('sanitizes the metadata on a Run and keeps other fields intact', () => {
    const run = {
      id: 'run-1',
      tenantId: 't1',
      agentId: 'a1',
      status: 'completed',
      metadata: { db: { password: 'secret' }, label: 'ok' },
    } as unknown as Run

    const result = sanitizeRunForResponse(run) as typeof run & { metadata: Record<string, unknown> }
    expect(result.id).toBe('run-1')
    const db = result.metadata?.['db'] as Record<string, unknown>
    expect(db?.['password']).toBe('[REDACTED]')
    expect(result.metadata?.['label']).toBe('ok')
  })
})
