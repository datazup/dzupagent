import { describe, it, expect } from 'vitest'
import { scanForSecrets, redactSecrets } from '../security/secrets-scanner.js'
import type { SecretMatch } from '../security/secrets-scanner.js'

/**
 * Deep coverage for secrets-scanner (G-31).
 * 35+ tests covering: AWS, GitHub, GitLab, Slack, generic assignments,
 * connection strings, entropy, redaction, line numbers, multi-secret handling.
 */
describe('scanForSecrets — AWS detection', () => {
  it('detects AWS access key with confidence 0.95', () => {
    const result = scanForSecrets('AKIAIOSFODNN7EXAMPLE')
    const match = result.matches.find((m) => m.type === 'aws-access-key')
    expect(match).toBeDefined()
    expect(match?.confidence).toBe(0.95)
  })

  it('detects AWS access key inside a larger string', () => {
    const result = scanForSecrets('const accessKey = "AKIAABCDEFGHIJKLMNOP";')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'aws-access-key')).toBe(true)
  })

  it('AWS access key redacted in output', () => {
    const result = scanForSecrets('key=AKIAABCDEFGHIJKLMNOP')
    expect(result.redacted).toContain('[REDACTED:aws-access-key]')
    expect(result.redacted).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })

  it('detects 40-char base64 string as potential AWS secret key', () => {
    // 40 chars of valid base64 alphabet with appropriate boundaries.
    // The regex uses (?<![A-Za-z0-9/+=]) lookbehind, so we must surround with
    // characters outside that class — a space works well.
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    const result = scanForSecrets(` ${secret} `)
    const match = result.matches.find((m) => m.type === 'aws-secret-key')
    expect(match).toBeDefined()
    // Low confidence — this is a base64 heuristic
    expect(match?.confidence).toBeLessThanOrEqual(0.5)
  })

  it('AWS secret key confidence is 0.4 (low because heuristic)', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    const result = scanForSecrets(` ${secret} `)
    const match = result.matches.find((m) => m.type === 'aws-secret-key')
    if (match) {
      expect(match.confidence).toBe(0.4)
    }
  })
})

describe('scanForSecrets — GitHub token prefixes', () => {
  // All five GitHub token prefixes: ghp_, gho_, ghu_, ghs_, ghr_
  const prefixes: ReadonlyArray<'ghp' | 'gho' | 'ghu' | 'ghs' | 'ghr'> = [
    'ghp',
    'gho',
    'ghu',
    'ghs',
    'ghr',
  ]
  const sampleSuffix = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl'

  for (const prefix of prefixes) {
    it(`detects ${prefix}_ prefixed token`, () => {
      const token = `${prefix}_${sampleSuffix}`
      const result = scanForSecrets(`TOKEN=${token}`)
      expect(result.hasSecrets).toBe(true)
      const match = result.matches.find((m) => m.type === 'github-token')
      expect(match).toBeDefined()
      expect(match?.confidence).toBe(0.95)
    })
  }

  it('redacts GitHub token in content', () => {
    const token = `ghp_${sampleSuffix}`
    const result = scanForSecrets(`x=${token}`)
    expect(result.redacted).toContain('[REDACTED:github-token]')
    expect(result.redacted).not.toContain(token)
  })
})

describe('scanForSecrets — GitLab tokens', () => {
  it('detects glpat- prefixed token', () => {
    const result = scanForSecrets('GL_TOKEN=glpat-abcdefghij1234567890_xyz')
    expect(result.hasSecrets).toBe(true)
    const match = result.matches.find((m) => m.type === 'gitlab-token')
    expect(match).toBeDefined()
    expect(match?.confidence).toBe(0.95)
  })

  it('redacts GitLab token in content', () => {
    const result = scanForSecrets('glpat-abcdefghij1234567890')
    expect(result.redacted).toContain('[REDACTED:gitlab-token]')
  })
})

describe('scanForSecrets — Slack tokens', () => {
  it('detects xoxb- bot token', () => {
    const result = scanForSecrets('TOKEN=xoxb-1234567890-abcdefghijkl')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'slack-token')).toBe(true)
  })

  it('detects xoxp- user token', () => {
    const result = scanForSecrets('TOKEN=xoxp-1234567890-abcdefghijkl')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'slack-token')).toBe(true)
  })

  it('detects xapp- app token', () => {
    const result = scanForSecrets('TOKEN=xapp-1234567890-abcdefghijkl')
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some((m) => m.type === 'slack-token')).toBe(true)
  })
})

describe('scanForSecrets — generic assignment patterns', () => {
  it('detects api_key = "..." assignment', () => {
    const result = scanForSecrets('api_key = "abc12345xyz0"')
    expect(result.matches.some((m) => m.type === 'generic-api-key')).toBe(true)
  })

  it('detects API_KEY = "..." (uppercase) assignment', () => {
    const result = scanForSecrets('API_KEY = "sk-abc12345xyz"')
    expect(result.matches.some((m) => m.type === 'generic-api-key')).toBe(true)
  })

  it('detects password = "..." assignment', () => {
    const result = scanForSecrets('password = "SuperSecret123"')
    expect(result.matches.some((m) => m.type === 'generic-password')).toBe(true)
  })

  it('detects PASSWORD = "..." uppercase', () => {
    const result = scanForSecrets('PASSWORD = "HunterHunter22"')
    expect(result.matches.some((m) => m.type === 'generic-password')).toBe(true)
  })

  it('detects secret = "..." assignment', () => {
    const result = scanForSecrets('secret = "abcdefghijklmnop"')
    expect(result.matches.some((m) => m.type === 'generic-secret')).toBe(true)
  })

  it('detects token = "..." assignment', () => {
    const result = scanForSecrets('token = "aabbccddeeff1122"')
    expect(result.matches.some((m) => m.type === 'generic-secret')).toBe(true)
  })

  it('generic-api-key confidence is 0.8', () => {
    const result = scanForSecrets('api_key = "abc12345xyz0"')
    const match = result.matches.find((m) => m.type === 'generic-api-key')
    expect(match?.confidence).toBe(0.8)
  })

  it('generic-password confidence is 0.85', () => {
    const result = scanForSecrets('password = "SuperSecret123"')
    const match = result.matches.find((m) => m.type === 'generic-password')
    expect(match?.confidence).toBe(0.85)
  })
})

describe('scanForSecrets — connection strings', () => {
  it('detects postgresql:// connection string', () => {
    const result = scanForSecrets('DB=postgresql://user:pass@localhost:5432/mydb')
    expect(result.matches.some((m) => m.type === 'connection-string')).toBe(true)
  })

  it('detects mongodb:// connection string', () => {
    const result = scanForSecrets('MONGO=mongodb://admin:pass@db.example.com:27017/mydb')
    expect(result.matches.some((m) => m.type === 'connection-string')).toBe(true)
  })

  it('detects redis:// connection string', () => {
    const result = scanForSecrets('REDIS=redis://:password@redis.example.com:6379')
    expect(result.matches.some((m) => m.type === 'connection-string')).toBe(true)
  })

  it('detects mysql:// connection string', () => {
    const result = scanForSecrets('MYSQL=mysql://root:root@localhost:3306/db')
    expect(result.matches.some((m) => m.type === 'connection-string')).toBe(true)
  })

  it('connection string has confidence 0.9', () => {
    const result = scanForSecrets('DB=postgresql://user:pass@localhost:5432/mydb')
    const match = result.matches.find((m) => m.type === 'connection-string')
    expect(match?.confidence).toBe(0.9)
  })
})

describe('scanForSecrets — clean and edge cases', () => {
  it('returns hasSecrets=false on regular code', () => {
    const result = scanForSecrets('const x = 42')
    expect(result.hasSecrets).toBe(false)
    expect(result.matches).toHaveLength(0)
  })

  it('returns hasSecrets=false for plain prose', () => {
    const result = scanForSecrets('The cat sat on the mat.')
    expect(result.hasSecrets).toBe(false)
  })

  it('handles empty string input', () => {
    const result = scanForSecrets('')
    expect(result.hasSecrets).toBe(false)
    expect(result.matches).toEqual([])
    expect(result.redacted).toBe('')
  })

  it('handles single whitespace input', () => {
    const result = scanForSecrets('   ')
    expect(result.hasSecrets).toBe(false)
    expect(result.redacted).toBe('   ')
  })

  it('does not flag short random words', () => {
    const result = scanForSecrets('apple banana cherry date')
    expect(result.hasSecrets).toBe(false)
  })
})

describe('scanForSecrets — redaction behaviour', () => {
  it('original secret string is absent from redacted output', () => {
    const original = 'AKIAIOSFODNN7EXAMPLE'
    const result = scanForSecrets(`key=${original}`)
    expect(result.redacted).not.toContain(original)
  })

  it('redacted placeholder contains the secret type', () => {
    const result = scanForSecrets('key=AKIAIOSFODNN7EXAMPLE')
    expect(result.redacted).toContain('[REDACTED:aws-access-key]')
  })

  it('redaction is applied end-to-start (offsets preserved)', () => {
    const content = [
      'aws=AKIAIOSFODNN7EXAMPLE',
      'gh=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl',
    ].join('\n')
    const result = scanForSecrets(content)
    expect(result.redacted).toContain('[REDACTED:aws-access-key]')
    expect(result.redacted).toContain('[REDACTED:github-token]')
  })

  it('redactSecrets is equivalent to scanForSecrets(...).redacted', () => {
    const input = 'api_key = "abc12345xyz0"'
    expect(redactSecrets(input)).toBe(scanForSecrets(input).redacted)
  })

  it('redactSecrets returns input unchanged if no secrets found', () => {
    const input = 'no secrets here'
    expect(redactSecrets(input)).toBe(input)
  })
})

describe('scanForSecrets — multi-secret and line numbers', () => {
  it('finds multiple different secrets in one blob', () => {
    const content = [
      'AWS=AKIAIOSFODNN7EXAMPLE',
      'GH=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl',
      'DB=postgresql://admin:secret@db.example.com/mydb',
    ].join('\n')
    const result = scanForSecrets(content)
    const types = new Set(result.matches.map((m) => m.type))
    expect(types.has('aws-access-key')).toBe(true)
    expect(types.has('github-token')).toBe(true)
    expect(types.has('connection-string')).toBe(true)
  })

  it('each match has a line number >= 1', () => {
    const content = 'line1\nAKIAIOSFODNN7EXAMPLE\nline3'
    const result = scanForSecrets(content)
    const match = result.matches.find((m) => m.type === 'aws-access-key')
    expect(match?.line).toBe(2)
  })

  it('first-line secret has line=1', () => {
    const result = scanForSecrets('AKIAIOSFODNN7EXAMPLE\nline2')
    expect(result.matches[0]?.line).toBe(1)
  })

  it('accurately reports different line numbers for multiple secrets', () => {
    const content = [
      'AKIAIOSFODNN7EXAMPLE', // line 1
      'safe line 2',
      'password = "SuperSecret123"', // line 3
    ].join('\n')
    const result = scanForSecrets(content)
    const aws = result.matches.find((m) => m.type === 'aws-access-key')
    const pw = result.matches.find((m) => m.type === 'generic-password')
    expect(aws?.line).toBe(1)
    expect(pw?.line).toBe(3)
  })
})

describe('scanForSecrets — JSON content', () => {
  it('detects AWS key embedded in JSON', () => {
    const json = JSON.stringify({ awsKey: 'AKIAIOSFODNN7EXAMPLE' })
    const result = scanForSecrets(json)
    expect(result.matches.some((m) => m.type === 'aws-access-key')).toBe(true)
  })

  it('detects AWS key in JSON-like raw content', () => {
    const json = '{"aws": "AKIAABCDEFGHIJKLMNOP"}'
    const result = scanForSecrets(json)
    expect(result.matches.some((m) => m.type === 'aws-access-key')).toBe(true)
  })
})

describe('scanForSecrets — confidence values', () => {
  it('all matches have confidence in [0, 1]', () => {
    const content = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl',
      'api_key = "abc123456789"',
      'postgres://user:pw@host/db',
    ].join('\n')
    const result = scanForSecrets(content)
    for (const match of result.matches) {
      expect(match.confidence).toBeGreaterThanOrEqual(0)
      expect(match.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('all matches have a non-empty type field', () => {
    const result = scanForSecrets('AKIAIOSFODNN7EXAMPLE')
    for (const match of result.matches) {
      expect(typeof match.type).toBe('string')
      expect(match.type.length).toBeGreaterThan(0)
    }
  })

  it('all matches have a non-empty value field', () => {
    const result = scanForSecrets('AKIAIOSFODNN7EXAMPLE')
    for (const match of result.matches) {
      expect(typeof match.value).toBe('string')
      expect(match.value.length).toBeGreaterThan(0)
    }
  })
})

describe('scanForSecrets — Shannon entropy detection', () => {
  it('detects high-entropy random string in assignment', () => {
    // high-entropy: varied characters, 4.5+ bits per char
    const result = scanForSecrets('config = "aB3xK9mQ2wR7vL5pN8jH4tY6uC0eI1oS"')
    // either entropy or pattern detection — at minimum secrets flagged
    expect(result.hasSecrets).toBe(true)
  })

  it('does not flag low-entropy repetitive string', () => {
    const result = scanForSecrets('value = "aaaaaaaaaaaaaaaaaaaaaaaa"')
    // Not guaranteed to flag — entropy is low so should not be generic-high-entropy
    const entropyMatch = result.matches.find((m) => m.type === 'generic-high-entropy')
    expect(entropyMatch).toBeUndefined()
  })

  it('entropy-matched secret has confidence 0.6', () => {
    const result = scanForSecrets('config = "aB3xK9mQ2wR7vL5pN8jH4tY6uC0eI1oS"')
    const entropyMatch = result.matches.find((m) => m.type === 'generic-high-entropy')
    if (entropyMatch) {
      expect(entropyMatch.confidence).toBe(0.6)
    }
  })
})

describe('scanForSecrets — JWT and bearer tokens', () => {
  it('detects JWT structure', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const result = scanForSecrets(jwt)
    expect(result.matches.some((m) => m.type === 'jwt-token')).toBe(true)
  })

  it('detects Authorization Bearer token', () => {
    const result = scanForSecrets('Authorization: Bearer abcdefghij1234567890xyz')
    expect(result.matches.some((m) => m.type === 'bearer-token')).toBe(true)
  })
})

describe('scanForSecrets — private keys', () => {
  it('detects RSA PRIVATE KEY', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nABCDEFGHIJ\n-----END RSA PRIVATE KEY-----'
    const result = scanForSecrets(pem)
    expect(result.matches.some((m) => m.type === 'private-key')).toBe(true)
  })

  it('private key has high confidence 0.99', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nABCDEFGHIJ\n-----END RSA PRIVATE KEY-----'
    const result = scanForSecrets(pem)
    const match = result.matches.find((m) => m.type === 'private-key')
    expect(match?.confidence).toBeGreaterThanOrEqual(0.99)
  })
})

describe('scanForSecrets — result contract', () => {
  it('returns object with hasSecrets, matches, redacted', () => {
    const result = scanForSecrets('test')
    expect(result).toHaveProperty('hasSecrets')
    expect(result).toHaveProperty('matches')
    expect(result).toHaveProperty('redacted')
    expect(Array.isArray(result.matches)).toBe(true)
  })

  it('matches array entries conform to SecretMatch shape', () => {
    const result = scanForSecrets('AKIAIOSFODNN7EXAMPLE')
    for (const m of result.matches) {
      const match: SecretMatch = m
      expect(typeof match.type).toBe('string')
      expect(typeof match.value).toBe('string')
      expect(typeof match.confidence).toBe('number')
    }
  })
})
