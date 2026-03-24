import { describe, it, expect } from 'vitest'
import { scanForSecrets, redactSecrets } from '../security/secrets-scanner.js'

describe('scanForSecrets', () => {
  it('detects AWS access key IDs', () => {
    const result = scanForSecrets('const key = "AKIAIOSFODNN7EXAMPLE"')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'aws-access-key')).toBe(true)
    expect(result.redacted).toContain('[REDACTED:')
  })

  it('detects GitHub tokens', () => {
    const result = scanForSecrets('token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl"')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'github-token')).toBe(true)
  })

  it('detects GitLab tokens', () => {
    const result = scanForSecrets('token: "glpat-abcdefghij1234567890"')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'gitlab-token')).toBe(true)
  })

  it('detects Slack tokens', () => {
    const result = scanForSecrets('SLACK_TOKEN=xoxb-1234567890-abcdefghij')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'slack-token')).toBe(true)
  })

  it('detects generic API keys in assignments', () => {
    const result = scanForSecrets('api_key = "sk-1234567890abcdef"')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'generic-api-key')).toBe(true)
  })

  it('detects generic passwords', () => {
    const result = scanForSecrets('password = "SuperSecret123!"')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'generic-password')).toBe(true)
  })

  it('detects generic secrets/tokens', () => {
    const result = scanForSecrets('secret = "abcdefgh12345678"')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'generic-secret')).toBe(true)
  })

  it('detects connection strings', () => {
    const result = scanForSecrets('DATABASE_URL=postgresql://user:pass@localhost:5432/mydb')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'connection-string')).toBe(true)
  })

  it('detects JWT tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const result = scanForSecrets(`const token = "${jwt}"`)
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'jwt-token')).toBe(true)
  })

  it('detects private keys', () => {
    const result = scanForSecrets(
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
    )
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'private-key')).toBe(true)
    expect(result.matches[0]?.confidence).toBeGreaterThanOrEqual(0.99)
  })

  it('detects Bearer tokens', () => {
    const result = scanForSecrets(
      'headers: { "Authorization": "Bearer sk_live_abcdefghij1234567890" }',
    )
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'bearer-token')).toBe(true)
  })

  it('returns clean result for safe content', () => {
    const result = scanForSecrets('const x = 42; console.log("hello world");')
    expect(result.hasSecrets).toBe(false)
    expect(result.matches).toHaveLength(0)
    expect(result.redacted).toBe('const x = 42; console.log("hello world");')
  })

  it('includes line numbers for multi-line content', () => {
    const content = 'line one\nline two\npassword = "mysecretpass123"\nline four'
    const result = scanForSecrets(content)
    expect(result.hasSecrets).toBe(true)
    expect(result.matches[0]?.line).toBe(3)
  })

  it('redacts secrets in output', () => {
    const result = scanForSecrets('key = AKIAIOSFODNN7EXAMPLE')
    expect(result.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(result.redacted).toContain('[REDACTED:aws-access-key]')
  })

  it('detects high-entropy strings in assignments', () => {
    // A clearly high-entropy random string
    const result = scanForSecrets('config= "aB3xK9mQ2wR7vL5pN8jH4tY6uC0eI1oSfG"')
    const entropyMatch = result.matches.find((m) => m.type === 'generic-high-entropy')
    if (entropyMatch) {
      expect(entropyMatch.confidence).toBe(0.6)
    }
    // Either caught by pattern or entropy — just ensure it is flagged
    expect(result.hasSecrets).toBe(true)
  })

  it('handles multiple secrets in one content block', () => {
    const content = [
      'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
      'password = "hunter2isnotgood"',
      'DB=postgresql://admin:pass@db.example.com:5432/prod',
    ].join('\n')
    const result = scanForSecrets(content)
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.length).toBeGreaterThanOrEqual(3)
  })
})

describe('redactSecrets', () => {
  it('returns redacted text directly', () => {
    const redacted = redactSecrets('key = AKIAIOSFODNN7EXAMPLE')
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(redacted).toContain('[REDACTED:')
  })

  it('passes through clean content unchanged', () => {
    const clean = 'const answer = 42'
    expect(redactSecrets(clean)).toBe(clean)
  })
})
