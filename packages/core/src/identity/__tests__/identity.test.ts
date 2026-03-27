import { describe, it, expect } from 'vitest'
import {
  ForgeCapabilitySchema,
  ForgeIdentitySchema,
  ForgeIdentityRefSchema,
  ForgeCredentialSchema,
} from '../identity-schemas.js'
import { toIdentityRef } from '../identity-types.js'
import type { ForgeIdentity } from '../identity-types.js'
import {
  parseForgeUri,
  buildForgeUri,
  isForgeUri,
  toAgentUri,
  fromAgentUri,
  createUriResolver,
  ForgeUriSchema,
} from '../forge-uri.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdentity(overrides?: Partial<ForgeIdentity>): ForgeIdentity {
  return {
    id: 'id-001',
    uri: 'forge://acme/reviewer',
    displayName: 'Code Reviewer',
    organization: 'acme',
    capabilities: [
      {
        name: 'code.review',
        version: '1.0.0',
        description: 'Reviews code for quality',
      },
    ],
    credentials: [
      {
        type: 'api-key',
        issuedAt: new Date('2025-01-01'),
      },
    ],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ForgeCapabilitySchema
// ---------------------------------------------------------------------------

describe('ForgeCapabilitySchema', () => {
  it('validates a minimal capability', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: 'code.review',
      version: '1.0.0',
      description: 'Reviews code',
    })
    expect(result.success).toBe(true)
  })

  it('validates capability with all optional fields', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: 'code.review.security',
      version: '2.3.1',
      description: 'Security-focused code review',
      inputSchema: { type: 'object', properties: { file: { type: 'string' } } },
      outputSchema: { type: 'object' },
      tags: ['security', 'review'],
      sla: { maxLatencyMs: 5000, maxCostCents: 10 },
    })
    expect(result.success).toBe(true)
  })

  it('allows hyphens in capability name (C2)', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: 'code-gen.type-script',
      version: '1.0.0',
      description: 'TypeScript code generation',
    })
    expect(result.success).toBe(true)
  })

  it('rejects uppercase in capability name', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: 'Code.Review',
      version: '1.0.0',
      description: 'Reviews code',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty capability name', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: '',
      version: '1.0.0',
      description: 'Reviews code',
    })
    expect(result.success).toBe(false)
  })

  it('rejects capability name starting with dot', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: '.code.review',
      version: '1.0.0',
      description: 'Reviews code',
    })
    expect(result.success).toBe(false)
  })

  it('rejects capability name ending with dot', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: 'code.review.',
      version: '1.0.0',
      description: 'Reviews code',
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing description', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: 'code.review',
      version: '1.0.0',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty description', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: 'code.review',
      version: '1.0.0',
      description: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid semver version', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: 'code.review',
      version: '1.0',
      description: 'Reviews code',
    })
    expect(result.success).toBe(false)
  })

  it('allows single-segment capability name', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: 'review',
      version: '1.0.0',
      description: 'Generic review',
    })
    expect(result.success).toBe(true)
  })

  it('allows name with digits', () => {
    const result = ForgeCapabilitySchema.safeParse({
      name: 'code2.review3',
      version: '1.0.0',
      description: 'Numbered capability',
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ForgeCredentialSchema
// ---------------------------------------------------------------------------

describe('ForgeCredentialSchema', () => {
  it('validates a minimal credential', () => {
    const result = ForgeCredentialSchema.safeParse({
      type: 'api-key',
      issuedAt: new Date(),
    })
    expect(result.success).toBe(true)
  })

  it('validates all credential types', () => {
    const types = ['api-key', 'oauth2', 'did-vc', 'mtls', 'delegation', 'custom'] as const
    for (const type of types) {
      const result = ForgeCredentialSchema.safeParse({
        type,
        issuedAt: new Date(),
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects unknown credential type', () => {
    const result = ForgeCredentialSchema.safeParse({
      type: 'bearer',
      issuedAt: new Date(),
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ForgeIdentitySchema
// ---------------------------------------------------------------------------

describe('ForgeIdentitySchema', () => {
  it('validates a full identity', () => {
    const identity = makeIdentity()
    const result = ForgeIdentitySchema.safeParse(identity)
    expect(result.success).toBe(true)
  })

  it('rejects identity with empty id', () => {
    const identity = makeIdentity({ id: '' })
    const result = ForgeIdentitySchema.safeParse(identity)
    expect(result.success).toBe(false)
  })

  it('rejects identity with empty organization', () => {
    const identity = makeIdentity({ organization: '' })
    const result = ForgeIdentitySchema.safeParse(identity)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// toIdentityRef
// ---------------------------------------------------------------------------

describe('toIdentityRef', () => {
  it('extracts ref from full identity', () => {
    const identity = makeIdentity()
    const ref = toIdentityRef(identity)
    expect(ref).toEqual({
      id: 'id-001',
      uri: 'forge://acme/reviewer',
      displayName: 'Code Reviewer',
    })
  })

  it('ref validates against ForgeIdentityRefSchema', () => {
    const identity = makeIdentity()
    const ref = toIdentityRef(identity)
    const result = ForgeIdentityRefSchema.safeParse(ref)
    expect(result.success).toBe(true)
  })

  it('does not include extra fields', () => {
    const identity = makeIdentity()
    const ref = toIdentityRef(identity)
    expect(Object.keys(ref)).toEqual(['id', 'uri', 'displayName'])
  })
})

// ---------------------------------------------------------------------------
// ForgeUriSchema
// ---------------------------------------------------------------------------

describe('ForgeUriSchema', () => {
  it('accepts valid URI without version', () => {
    const result = ForgeUriSchema.safeParse('forge://acme/code-reviewer')
    expect(result.success).toBe(true)
  })

  it('accepts valid URI with version', () => {
    const result = ForgeUriSchema.safeParse('forge://acme/code-reviewer@1.2.3')
    expect(result.success).toBe(true)
  })

  it('accepts URI with underscores and hyphens', () => {
    const result = ForgeUriSchema.safeParse('forge://my_org/my-agent')
    expect(result.success).toBe(true)
  })

  it('rejects URI missing scheme', () => {
    const result = ForgeUriSchema.safeParse('acme/code-reviewer')
    expect(result.success).toBe(false)
  })

  it('rejects URI with wrong scheme', () => {
    const result = ForgeUriSchema.safeParse('http://acme/code-reviewer')
    expect(result.success).toBe(false)
  })

  it('rejects URI without agent name', () => {
    const result = ForgeUriSchema.safeParse('forge://acme')
    expect(result.success).toBe(false)
  })

  it('rejects URI with uppercase', () => {
    const result = ForgeUriSchema.safeParse('forge://Acme/Reviewer')
    expect(result.success).toBe(false)
  })

  it('rejects empty string', () => {
    const result = ForgeUriSchema.safeParse('')
    expect(result.success).toBe(false)
  })

  it('rejects URI with bad version format', () => {
    const result = ForgeUriSchema.safeParse('forge://acme/agent@1.2')
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseForgeUri / buildForgeUri round-trip
// ---------------------------------------------------------------------------

describe('parseForgeUri', () => {
  it('parses URI without version', () => {
    const parsed = parseForgeUri('forge://acme/code-reviewer')
    expect(parsed).toEqual({
      organization: 'acme',
      agentName: 'code-reviewer',
    })
  })

  it('parses URI with version', () => {
    const parsed = parseForgeUri('forge://acme/code-reviewer@2.1.0')
    expect(parsed).toEqual({
      organization: 'acme',
      agentName: 'code-reviewer',
      version: '2.1.0',
    })
  })

  it('throws on invalid URI', () => {
    expect(() => parseForgeUri('not-a-uri')).toThrow()
  })
})

describe('buildForgeUri', () => {
  it('builds URI without version', () => {
    expect(buildForgeUri('acme', 'code-reviewer')).toBe('forge://acme/code-reviewer')
  })

  it('builds URI with version', () => {
    expect(buildForgeUri('acme', 'code-reviewer', '1.0.0')).toBe(
      'forge://acme/code-reviewer@1.0.0',
    )
  })

  it('throws if result would be invalid', () => {
    expect(() => buildForgeUri('ACME', 'Bad Name')).toThrow()
  })
})

describe('parseForgeUri / buildForgeUri round-trip', () => {
  it('round-trips URI without version', () => {
    const uri = 'forge://acme/my-agent'
    const parsed = parseForgeUri(uri)
    const rebuilt = buildForgeUri(parsed.organization, parsed.agentName, parsed.version)
    expect(rebuilt).toBe(uri)
  })

  it('round-trips URI with version', () => {
    const uri = 'forge://acme/my-agent@3.2.1'
    const parsed = parseForgeUri(uri)
    const rebuilt = buildForgeUri(parsed.organization, parsed.agentName, parsed.version)
    expect(rebuilt).toBe(uri)
  })
})

// ---------------------------------------------------------------------------
// isForgeUri
// ---------------------------------------------------------------------------

describe('isForgeUri', () => {
  it('returns true for valid URI', () => {
    expect(isForgeUri('forge://acme/agent')).toBe(true)
  })

  it('returns true for versioned URI', () => {
    expect(isForgeUri('forge://acme/agent@1.0.0')).toBe(true)
  })

  it('returns false for agent:// URI', () => {
    expect(isForgeUri('agent://acme/agent')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isForgeUri('')).toBe(false)
  })

  it('returns false for random string', () => {
    expect(isForgeUri('hello world')).toBe(false)
  })

  it('never throws', () => {
    expect(() => isForgeUri(undefined as unknown as string)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// toAgentUri / fromAgentUri
// ---------------------------------------------------------------------------

describe('toAgentUri', () => {
  it('converts forge:// to agent://', () => {
    expect(toAgentUri('forge://acme/reviewer')).toBe('agent://acme/reviewer')
  })

  it('converts versioned URI', () => {
    expect(toAgentUri('forge://acme/reviewer@1.0.0')).toBe('agent://acme/reviewer@1.0.0')
  })

  it('throws on invalid forge URI', () => {
    expect(() => toAgentUri('http://bad/uri')).toThrow()
  })
})

describe('fromAgentUri', () => {
  it('converts agent:// to forge://', () => {
    expect(fromAgentUri('agent://acme/reviewer')).toBe('forge://acme/reviewer')
  })

  it('converts versioned URI', () => {
    expect(fromAgentUri('agent://acme/reviewer@1.0.0')).toBe('forge://acme/reviewer@1.0.0')
  })

  it('throws on non-agent:// URI', () => {
    expect(() => fromAgentUri('forge://acme/reviewer')).toThrow()
  })

  it('throws on invalid agent URI content', () => {
    expect(() => fromAgentUri('agent://BAD/URI')).toThrow()
  })
})

describe('toAgentUri / fromAgentUri round-trip', () => {
  it('round-trips forge -> agent -> forge', () => {
    const original = 'forge://acme/my-agent@1.2.3'
    expect(fromAgentUri(toAgentUri(original))).toBe(original)
  })
})

// ---------------------------------------------------------------------------
// createUriResolver
// ---------------------------------------------------------------------------

describe('createUriResolver', () => {
  it('static resolver returns mapped URL', async () => {
    const resolver = createUriResolver('static', {
      staticMap: { 'forge://acme/agent': 'https://acme.example.com/agent' },
    })
    const url = await resolver.resolve('forge://acme/agent')
    expect(url).toBe('https://acme.example.com/agent')
  })

  it('static resolver returns null for unknown URI', async () => {
    const resolver = createUriResolver('static', { staticMap: {} })
    const url = await resolver.resolve('forge://acme/unknown')
    expect(url).toBeNull()
  })

  it('convention resolver interpolates template', async () => {
    const resolver = createUriResolver('convention', {
      urlTemplate: 'https://{org}.agents.dev/{name}',
    })
    const url = await resolver.resolve('forge://acme/reviewer')
    expect(url).toBe('https://acme.agents.dev/reviewer')
  })

  it('convention resolver returns null for non-forge URI', async () => {
    const resolver = createUriResolver('convention')
    const url = await resolver.resolve('http://not-forge')
    expect(url).toBeNull()
  })

  it('registry resolver builds lookup URL', async () => {
    const resolver = createUriResolver('registry', {
      registryUrl: 'https://reg.forge.dev',
    })
    const url = await resolver.resolve('forge://acme/reviewer@1.0.0')
    expect(url).toBe('https://reg.forge.dev/agents/acme/reviewer?version=1.0.0')
  })

  it('registry resolver without version omits query param', async () => {
    const resolver = createUriResolver('registry', {
      registryUrl: 'https://reg.forge.dev',
    })
    const url = await resolver.resolve('forge://acme/reviewer')
    expect(url).toBe('https://reg.forge.dev/agents/acme/reviewer')
  })
})
