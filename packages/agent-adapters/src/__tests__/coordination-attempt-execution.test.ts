/**
 * B3-CP-03 acceptance: the DZO v2 sealed coordination assignment decodes in
 * DzupAgent from the same bytes, and composes with a separate execution
 * binding into one immutable plan and one execution request.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type {
  CoordinationAttemptExecutionPlan,
  CoordinationExecutionBinding,
  DecodedCoordinationExecutionAssignment,
} from '@dzupagent/adapter-types'
import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_EFFECTS,
  type ProviderSessionAttemptBinding,
} from '@dzupagent/runtime-contracts/provider-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  composeCoordinationAttemptExecution,
  coordinationCanonicalDigest,
  coordinationSelfDigest,
  decodeCoordinationExecutionAssignment,
  renderCoordinationAgentExecutionRequest,
  type ComposeCoordinationAttemptExecutionInput,
  type CoordinationArtifactResolver,
} from '../integration/index.js'
import type { ProviderModelCatalog } from '../model-discovery-types.js'

// ---------------------------------------------------------------------------
// Pinned producer bytes (DZO 4e2d6c1b, fixtures/coordination-critical-path/v2)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = new URL('./fixtures/coordination-critical-path/v2/', import.meta.url)
const ASSIGNMENT_BYTES = readFileSync(new URL('execution-assignment.json', FIXTURE_DIR))
const MANIFEST_BYTES = readFileSync(new URL('manifest.json', FIXTURE_DIR))
const ASSIGNMENT_RAW_SHA256 = '2f9d71163f00d9fba968d1d6cad8432a53a9d9f8c39fb002dbbb4ba83fd4c5a9'
const MANIFEST_RAW_SHA256 = '051140f95065346c7ab63b88dc05db5d7a0495e2b4676b2fbfd1fa3cc1e1fc87'
const ASSIGNMENT_SEAL = 'sha256:988ef42f3c1e98ff3294b948beaddd022c2a25ba6515b7cb80157e6f59d5c139'
const MANIFEST_SEAL = 'sha256:625a00ba8f9896e00e12d5a43ac7356c985d336f53c4b14c62de056504eac7d5'

const NOW = '2026-08-30T10:30:00Z'
const SECRET = 'sk-ant-SECRET-VALUE-b3cp03-do-not-leak'
const TASK_CONTENT = '{"task":"task-scripts-adapter","goal":"implement the adapter"}'

// Distinct sentinels so each binding fact is countable in the plan.
const MODEL = 'model-sentinel-b3cp03'
const PROFILE_REF = 'profile-sentinel-b3cp03'
const AUTH_SOURCE_REF = 'auth-source-sentinel-b3cp03'
const TARIFF_REF = 'tariff-sentinel-b3cp03'
const SESSION_REF = 'session-ref-sentinel-b3cp03'
const DESCRIPTOR_ID = 'descriptor-sentinel-b3cp03'

type Json = Record<string, any>

function sha256(content: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function fixture(): Json {
  return JSON.parse(ASSIGNMENT_BYTES.toString('utf8')) as Json
}

/** Recompute every self-digest bottom-up with the producer rule. */
function reseal(assignment: Json): Json {
  assignment.source.bindingDigest = coordinationSelfDigest(assignment.source, 'bindingDigest')
  assignment.workspace.source.bindingDigest = coordinationSelfDigest(assignment.workspace.source, 'bindingDigest')
  assignment.workspace.workspaceDigest = coordinationSelfDigest(assignment.workspace, 'workspaceDigest')
  assignment.authorityBundle.bundleDigest = coordinationSelfDigest(assignment.authorityBundle, 'bundleDigest')
  assignment.contextPack.manifestDigest = coordinationSelfDigest(assignment.contextPack, 'manifestDigest')
  const session = assignment.sessionEnrollment
  session.workIntentDigest = coordinationCanonicalDigest(assignment.workIntent)
  session.contextPackDigest = assignment.contextPack.manifestDigest
  session.enrollmentDigest = coordinationSelfDigest(session, 'enrollmentDigest')
  assignment.assignmentDigest = coordinationSelfDigest(assignment, 'assignmentDigest')
  return assignment
}

/** The fixture with a real task digest so a resolver can satisfy it. */
function resolvable(mutate: (assignment: Json) => void = () => {}): Json {
  const assignment = fixture()
  const item = assignment.contextPack.items[0]
  item.artifact.digest = sha256(TASK_CONTENT)
  item.contentDigest = sha256(TASK_CONTENT)
  mutate(assignment)
  return reseal(assignment)
}

function decode(assignment: Json): DecodedCoordinationExecutionAssignment {
  const result = decodeCoordinationExecutionAssignment(JSON.stringify(assignment))
  if (!result.ok) throw new Error(`fixture did not decode: ${JSON.stringify(result.diagnostics)}`)
  return result.value
}

function providerSession(overrides: Partial<ProviderSessionAttemptBinding> = {}): ProviderSessionAttemptBinding {
  return {
    schema: PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
    bindingId: 'provider-session-binding-1',
    executionAttemptId: 'attempt-scripts-critical',
    authSourceRef: AUTH_SOURCE_REF,
    descriptor: {
      schema: PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
      descriptorId: DESCRIPTOR_ID,
      providerId: 'claude',
      backend: { id: 'claude-agent-sdk', kind: 'sdk' },
      capabilities: Object.fromEntries(
        PROVIDER_SESSION_CAPABILITIES.map((capability) => [
          capability,
          { status: 'native', emulation: 'forbidden' },
        ]),
      ) as ProviderSessionAttemptBinding['descriptor']['capabilities'],
      observedAt: '2026-08-30T09:59:00.000Z',
    },
    effectAuthorities: Object.fromEntries(
      PROVIDER_SESSION_EFFECTS.map((effect) => [
        effect,
        {
          effect,
          retryAuthorityId: 'retry-authority',
          fallbackAuthorityId: 'fallback-authority',
          maxRetries: 0,
          fallback: 'none',
        },
      ]),
    ) as ProviderSessionAttemptBinding['effectAuthorities'],
    boundAt: '2026-08-30T10:00:00.000Z',
    ...overrides,
  }
}

function binding(overrides: Record<string, unknown> = {}): Json {
  return {
    schema: 'dzupagent.coordinationExecutionBinding/v1',
    bindingId: 'execution-binding-1',
    providerId: 'claude',
    backend: 'sdk',
    model: MODEL,
    profileRef: PROFILE_REF,
    auth: { mode: 'api_key', sourceRef: AUTH_SOURCE_REF },
    capabilitySet: {
      providerSession: providerSession(),
      requiredCapabilities: ['execute', 'stream'],
      effects: [],
    },
    tariffRef: TARIFF_REF,
    sessionRef: SESSION_REF,
    reasoning: 'high',
    ...overrides,
  } satisfies Record<keyof CoordinationExecutionBinding, unknown>
}

function catalog(overrides: Partial<ProviderModelCatalog> = {}, efforts: string[] | null = ['low', 'medium', 'high']): ProviderModelCatalog {
  return {
    schemaVersion: 'dzupagent/provider-model-catalog/v1',
    providerId: 'claude',
    source: 'anthropic-models-api',
    completeness: 'account-catalog',
    discoveredAt: '2026-08-30T09:00:00.000Z',
    authenticated: true,
    models: [
      {
        providerId: 'claude',
        id: MODEL,
        displayName: 'Sentinel model',
        ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
      },
    ],
    warnings: [],
    fingerprint: 'catalog-fingerprint-1',
    ...overrides,
  }
}

const resolveTask: CoordinationArtifactResolver = ({ digest }) =>
  digest === sha256(TASK_CONTENT) ? { content: TASK_CONTENT } : undefined

function input(overrides: Partial<ComposeCoordinationAttemptExecutionInput> = {}): ComposeCoordinationAttemptExecutionInput {
  return {
    decoded: decode(resolvable()),
    binding: binding(),
    now: NOW,
    modelCatalog: catalog(),
    resolveArtifact: resolveTask,
    ...overrides,
  }
}

async function compose(overrides: Partial<ComposeCoordinationAttemptExecutionInput> = {}): Promise<CoordinationAttemptExecutionPlan> {
  const result = await composeCoordinationAttemptExecution(input(overrides))
  if (!result.ok) throw new Error(`composition refused: ${JSON.stringify(result.refusals)}`)
  return result.plan
}

async function refusalCodes(overrides: Partial<ComposeCoordinationAttemptExecutionInput> = {}): Promise<string[]> {
  const result = await composeCoordinationAttemptExecution(input(overrides))
  expect(result.ok).toBe(false)
  return result.ok ? [] : result.refusals.map(({ code }) => code)
}

function decodeCodes(bytes: string, expectedSeal?: string): string[] {
  const result = decodeCoordinationExecutionAssignment(bytes, { expectedSeal })
  expect(result.ok).toBe(false)
  return result.ok ? [] : result.diagnostics.map(({ code }) => code)
}

function occurrences(haystack: string, value: string): number {
  return haystack.split(JSON.stringify(value)).length - 1
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// 1. Same bytes
// ---------------------------------------------------------------------------

describe('1. same bytes', () => {
  it('vendors the pinned producer bytes', () => {
    expect(createHash('sha256').update(ASSIGNMENT_BYTES).digest('hex')).toBe(ASSIGNMENT_RAW_SHA256)
    expect(createHash('sha256').update(MANIFEST_BYTES).digest('hex')).toBe(MANIFEST_RAW_SHA256)
    const manifest = JSON.parse(MANIFEST_BYTES.toString('utf8')) as Json
    expect(coordinationCanonicalDigest(manifest)).toBe(MANIFEST_SEAL)
    expect(manifest.fixtures.find((entry: Json) => entry.id === 'execution-assignment').canonicalSha256).toBe(ASSIGNMENT_SEAL)
  })

  it('decodes the sealed bytes, verifies the seal and every embedded digest', () => {
    const result = decodeCoordinationExecutionAssignment(ASSIGNMENT_BYTES, { expectedSeal: ASSIGNMENT_SEAL })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.canonicalSeal).toBe(ASSIGNMENT_SEAL)
    expect(result.value.sealVerified).toBe(true)
    expect([...result.value.verifiedDigests].sort()).toEqual([
      'assignmentDigest',
      'authorityBundle.bundleDigest',
      'contextPack.manifestDigest',
      'sessionEnrollment.contextPackDigest',
      'sessionEnrollment.enrollmentDigest',
      'sessionEnrollment.workIntentDigest',
      'source.bindingDigest',
      'workspace.source.bindingDigest',
      'workspace.workspaceDigest',
    ])
    expect(isDeepFrozen(result.value)).toBe(true)
    expect(result.value.assignment.assignmentId).toBe('assignment-scripts-critical')
  })

  it('accepts only execution-assignment/v2', () => {
    const v1 = fixture()
    v1.schema = 'datazup.coordination.execution-assignment/v1'
    expect(decodeCodes(JSON.stringify(v1))).toEqual(['COORD_ASSIGNMENT_SCHEMA_UNSUPPORTED'])
  })

  it('rejects unknown and missing fields at every level without throwing', () => {
    const unknown = fixture()
    unknown.contextPack.items[0].extra = true
    expect(decodeCodes(JSON.stringify(unknown))).toContain('COORD_ASSIGNMENT_FIELD_UNKNOWN')
    const missing = fixture()
    delete missing.authorityBundle.grants[0].fenceRef
    expect(decodeCodes(JSON.stringify(missing))).toContain('COORD_ASSIGNMENT_FIELD_MISSING')
    expect(decodeCodes('{not json')).toEqual(['COORD_ASSIGNMENT_NOT_JSON'])
    expect(decodeCodes('[]')).toEqual(['COORD_ASSIGNMENT_NOT_OBJECT'])
    expect(decodeCodes(new Uint8Array([0xff, 0xfe]) as unknown as string)).toEqual(['COORD_ASSIGNMENT_NOT_JSON'])
  })

  it('rejects an embedded digest that does not match its canonical bytes', () => {
    const tampered = fixture()
    tampered.authorityBundle.grants[0].fenceRef = 'fence:other'
    expect(decodeCodes(JSON.stringify(tampered))).toContain('COORD_ASSIGNMENT_DIGEST_MISMATCH')
  })
})

// ---------------------------------------------------------------------------
// 2. Separation
// ---------------------------------------------------------------------------

describe('2. separation', () => {
  it('places each binding fact in exactly one plan field', async () => {
    const plan = await compose()
    const text = JSON.stringify(plan)
    for (const value of [MODEL, PROFILE_REF, AUTH_SOURCE_REF, TARIFF_REF, SESSION_REF, DESCRIPTOR_ID, 'claude', 'sdk', 'api_key', 'high']) {
      expect({ value, count: occurrences(text, value) }).toEqual({ value, count: 1 })
    }
    expect(plan.execution).toMatchObject({
      providerId: 'claude',
      backend: 'sdk',
      model: MODEL,
      profileRef: PROFILE_REF,
      authMode: 'api_key',
      authSourceRef: AUTH_SOURCE_REF,
      capabilityDescriptorId: DESCRIPTOR_ID,
      tariffRef: TARIFF_REF,
      sessionRef: SESSION_REF,
      reasoning: 'high',
    })
  })

  it('keeps issuer, generation, validity and scope per fact', async () => {
    const plan = await compose()
    expect(plan.assignment.provenance).toEqual({
      issuerRef: 'controller:coordination',
      generation: 7,
      validFrom: '2026-08-30T10:00:00Z',
      notAfter: '2026-08-30T11:00:00Z',
      scope: 'attempt-scripts-critical',
    })
    expect(plan.authority.grants.map(({ provenance }) => provenance.issuerRef)).toEqual([
      'fence:execution',
      'fence:placement',
      'fence:resource',
      'fence:budget',
    ])
    expect(plan.execution.provenance).toMatchObject({ issuerRef: 'execution-binding-1', generation: null })
  })

  it.each([
    ['providerId', '$binding.providerId'],
    ['backend', '$binding.backend'],
    ['model', '$binding.model'],
  ])('refuses a binding without %s; there is no default', async (field, path) => {
    const partial = binding()
    delete partial[field]
    const result = await composeCoordinationAttemptExecution(input({ binding: partial }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusals).toContainEqual(expect.objectContaining({ code: 'COORD_BINDING_FACT_MISSING', path }))
  })

  it('refuses a binding without an auth mode; there is no default', async () => {
    const result = await composeCoordinationAttemptExecution(
      input({ binding: binding({ auth: { sourceRef: AUTH_SOURCE_REF } }) }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusals).toContainEqual(
      expect.objectContaining({ code: 'COORD_BINDING_FACT_MISSING', path: '$binding.auth.mode' }),
    )
  })

  it('never lets an authority grant satisfy a missing binding fact', async () => {
    const granted = resolvable((assignment) => {
      assignment.authorityBundle.grants[0].grantRef = `model:${MODEL}`
      assignment.authorityBundle.grants[0].coveredAuthorityRequirements = ['execution', 'model', 'provider']
    })
    for (const field of ['providerId', 'backend', 'model', 'auth']) {
      const partial = binding()
      delete partial[field]
      const codes = await refusalCodes({ decoded: decode(granted), binding: partial })
      expect(codes).toContain('COORD_BINDING_FACT_MISSING')
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Authority
// ---------------------------------------------------------------------------

describe('3. authority', () => {
  it('composes inside every validity window', async () => {
    await expect(compose()).resolves.toMatchObject({ composedAt: NOW })
  })

  it('refuses at or after the assignment notAfter', async () => {
    expect(await refusalCodes({ now: '2026-08-30T11:00:00Z' })).toContain('COORD_ASSIGNMENT_EXPIRED')
  })

  it('refuses at or after any grant notAfter', async () => {
    const decoded = decode(resolvable((assignment) => {
      assignment.authorityBundle.grants[2].notAfter = '2026-08-30T10:30:00Z'
    }))
    expect(await refusalCodes({ decoded })).toEqual(['COORD_GRANT_EXPIRED'])
  })

  it('refuses a session enrollment that is not enrolled', async () => {
    const decoded = decode(resolvable((assignment) => {
      assignment.sessionEnrollment.state = 'renewal_due'
    }))
    expect(await refusalCodes({ decoded })).toEqual(['COORD_SESSION_NOT_ENROLLED'])
  })

  it('refuses an expired session enrollment', async () => {
    const decoded = decode(resolvable((assignment) => {
      assignment.sessionEnrollment.expiresAt = '2026-08-30T10:20:00Z'
    }))
    expect(await refusalCodes({ decoded })).toEqual(['COORD_SESSION_EXPIRED'])
  })

  it('refuses a grant generation that differs from the attempt', async () => {
    const decoded = decode(resolvable((assignment) => {
      assignment.authorityBundle.grants[1].generation = 6
    }))
    expect(await refusalCodes({ decoded })).toEqual(['COORD_GRANT_GENERATION_MISMATCH'])
  })

  it('refuses an assignment generation that differs from the attempt', async () => {
    const decoded = decode(resolvable((assignment) => {
      assignment.generation = 8
    }))
    expect(await refusalCodes({ decoded })).toEqual(['COORD_ASSIGNMENT_GENERATION_MISMATCH'])
  })

  it('refuses an authority requirement no grant covers', async () => {
    const decoded = decode(resolvable((assignment) => {
      assignment.workIntent.authorityRequirements.push('integration')
    }))
    expect(await refusalCodes({ decoded })).toEqual(['COORD_AUTHORITY_REQUIREMENT_UNCOVERED'])
  })

  it('refuses a binding for a different attempt', async () => {
    const other = binding()
    other.capabilitySet.providerSession = providerSession({ executionAttemptId: 'attempt-other' })
    expect(await refusalCodes({ binding: other })).toEqual(['COORD_BINDING_ATTEMPT_MISMATCH'])
  })

  it('refuses a changed byte under a supplied seal', () => {
    const text = ASSIGNMENT_BYTES.toString('utf8')
    const changed = text.replace('"issuerRef": "controller:coordination"', '"issuerRef": "controller:coordinatioN"')
    expect(changed).not.toBe(text)
    expect(decodeCodes(changed, ASSIGNMENT_SEAL)).toContain('COORD_ASSIGNMENT_SEAL_MISMATCH')
    // A resealed document still fails the producer seal.
    const resealed = reseal(JSON.parse(changed) as Json)
    expect(decodeCodes(JSON.stringify(resealed), ASSIGNMENT_SEAL)).toEqual(['COORD_ASSIGNMENT_SEAL_MISMATCH'])
    // Whitespace is not a changed byte of the canonical form.
    expect(decodeCoordinationExecutionAssignment(JSON.stringify(fixture()), { expectedSeal: ASSIGNMENT_SEAL }).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Effort
// ---------------------------------------------------------------------------

describe('4. effort', () => {
  it('keeps a supported effort exactly', async () => {
    const plan = await compose()
    expect(plan.execution.reasoning).toBe('high')
    expect(plan.execution.reasoningCatalogFingerprint).toBe('catalog-fingerprint-1')
  })

  it('refuses an unsupported effort instead of downgrading it', async () => {
    expect(await refusalCodes({ binding: binding({ reasoning: 'max' }) })).toEqual(['COORD_REASONING_UNSUPPORTED'])
  })

  it('refuses when the catalog does not attest efforts for the model', async () => {
    expect(await refusalCodes({ modelCatalog: catalog({}, null) })).toEqual(['COORD_REASONING_SUPPORT_UNKNOWN'])
  })

  it('refuses a model or provider the catalog does not cover', async () => {
    expect(await refusalCodes({ binding: binding({ model: 'model-absent' }) })).toEqual(['COORD_MODEL_NOT_IN_CATALOG'])
    expect(await refusalCodes({ modelCatalog: catalog({ providerId: 'codex' }) })).toEqual(['COORD_CATALOG_PROVIDER_MISMATCH'])
  })
})

// ---------------------------------------------------------------------------
// 5. No provider switch
// ---------------------------------------------------------------------------

describe('5. no provider switch', () => {
  it('refuses ordered-compatible fallback in any effect authority', async () => {
    const session = providerSession()
    const fallback = binding()
    fallback.capabilitySet.providerSession = {
      ...session,
      effectAuthorities: {
        ...session.effectAuthorities,
        execute: { ...session.effectAuthorities.execute, fallback: 'ordered-compatible' },
      },
    }
    expect(await refusalCodes({ binding: fallback })).toEqual(['COORD_BINDING_FALLBACK_FORBIDDEN'])
  })

  it('refuses a binding carrying approvedFallbackProviders', async () => {
    expect(await refusalCodes({ binding: binding({ approvedFallbackProviders: ['codex'] }) })).toEqual([
      'COORD_BINDING_FALLBACK_FORBIDDEN',
    ])
    expect(await refusalCodes({ binding: binding({ approvedFallbackProviders: [] }) })).toEqual([
      'COORD_BINDING_FALLBACK_FORBIDDEN',
    ])
  })

  it('refuses a binding whose session descriptor names a different provider', async () => {
    const mismatched = binding()
    const session = providerSession()
    mismatched.capabilitySet.providerSession = {
      ...session,
      descriptor: { ...session.descriptor, providerId: 'codex' },
    }
    expect(await refusalCodes({ binding: mismatched })).toEqual(['COORD_BINDING_PROVIDER_MISMATCH'])
  })

  it('renders exactly one request with no fallback providers', async () => {
    const rendered = renderCoordinationAgentExecutionRequest(await compose())
    expect(rendered.ok).toBe(true)
    if (!rendered.ok) return
    expect(rendered.request.approvedFallbackProviders).toEqual([])
    expect(rendered.request).toEqual({
      providerId: 'claude',
      backend: 'sdk',
      authMode: 'api_key',
      profileRef: PROFILE_REF,
      secretRef: AUTH_SOURCE_REF,
      approvedFallbackProviders: [],
      prompt: expect.stringContaining(TASK_CONTENT),
      model: MODEL,
      reasoning: 'high',
      correlationId: 'assignment-scripts-critical',
      runId: 'attempt-scripts-critical',
    })
  })

  it('keeps the tariff in the attestation and out of the request', async () => {
    const rendered = renderCoordinationAgentExecutionRequest(await compose())
    if (!rendered.ok) throw new Error('render refused')
    expect(JSON.stringify(rendered.request)).not.toContain(TARIFF_REF)
    expect(rendered.attestation.tariffRef).toBe(TARIFF_REF)
  })

  it('omits secretRef for subscription auth', async () => {
    const plan = await compose({ binding: binding({ auth: { mode: 'subscription_cli', sourceRef: AUTH_SOURCE_REF } }) })
    const rendered = renderCoordinationAgentExecutionRequest(plan)
    if (!rendered.ok) throw new Error('render refused')
    expect(rendered.request).not.toHaveProperty('secretRef')
    expect(rendered.request.authMode).toBe('subscription_cli')
  })
})

// ---------------------------------------------------------------------------
// 6. Immutability
// ---------------------------------------------------------------------------

describe('6. immutability', () => {
  it('freezes the plan, request and attestation', async () => {
    const plan = await compose()
    const rendered = renderCoordinationAgentExecutionRequest(plan)
    if (!rendered.ok) throw new Error('render refused')
    expect(isDeepFrozen(plan)).toBe(true)
    expect(isDeepFrozen(rendered.request)).toBe(true)
    expect(isDeepFrozen(rendered.attestation)).toBe(true)
    expect(() => {
      ;(plan.execution as { model: string }).model = 'other'
    }).toThrow(TypeError)
  })

  it('renders byte-identical canonical output with a stable digest', async () => {
    const first = await compose()
    const second = await compose()
    expect(coordinationCanonicalDigest(first)).toBe(coordinationCanonicalDigest(second))
    const { planDigest, ...unsigned } = first
    expect(planDigest).toBe(coordinationCanonicalDigest(unsigned))
    const a = renderCoordinationAgentExecutionRequest(first)
    const b = renderCoordinationAgentExecutionRequest(second)
    if (!a.ok || !b.ok) throw new Error('render refused')
    expect(coordinationCanonicalDigest(a.request)).toBe(coordinationCanonicalDigest(b.request))
    expect(a.attestation).toEqual(b.attestation)
    expect(a.attestation.requestDigest).toBe(coordinationCanonicalDigest(a.request))
  })

  it('refuses to render an unfrozen or altered plan', async () => {
    const plan = await compose()
    const copy = structuredClone(plan) as Json
    const unfrozen = renderCoordinationAgentExecutionRequest(copy as CoordinationAttemptExecutionPlan)
    expect(unfrozen.ok ? [] : unfrozen.refusals.map(({ code }) => code)).toEqual(['COORD_PLAN_INVALID'])
    copy.execution.model = 'model-swapped'
    const deepFreeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze)
        Object.freeze(value)
      }
    }
    deepFreeze(copy)
    const altered = renderCoordinationAgentExecutionRequest(copy as CoordinationAttemptExecutionPlan)
    expect(altered.ok ? [] : altered.refusals.map(({ code }) => code)).toEqual(['COORD_PLAN_DIGEST_MISMATCH'])
  })
})

// ---------------------------------------------------------------------------
// 7. Context
// ---------------------------------------------------------------------------

describe('7. context', () => {
  it('refuses a required role without a resolved item', async () => {
    expect(await refusalCodes({ resolveArtifact: () => undefined })).toEqual(['COORD_CONTEXT_REQUIRED_UNRESOLVED'])
    expect(await refusalCodes({
      resolveArtifact: async () => {
        throw new Error('storage unavailable')
      },
    })).toEqual(['COORD_CONTEXT_REQUIRED_UNRESOLVED'])
  })

  it('refuses resolved content whose sha256 differs from its digest', async () => {
    expect(await refusalCodes({ resolveArtifact: () => ({ content: `${TASK_CONTENT} ` }) })).toEqual([
      'COORD_CONTEXT_DIGEST_MISMATCH',
    ])
    // The pinned fixture's placeholder digest can never be satisfied.
    expect(await refusalCodes({
      decoded: decode(fixture()),
      resolveArtifact: () => ({ content: TASK_CONTENT }),
    })).toEqual(['COORD_CONTEXT_DIGEST_MISMATCH'])
  })

  it('resolves byte content by digest', async () => {
    const plan = await compose({ resolveArtifact: () => ({ content: new TextEncoder().encode(TASK_CONTENT) }) })
    expect(plan.context.items).toEqual([
      expect.objectContaining({ role: 'task', contentDigest: sha256(TASK_CONTENT), content: TASK_CONTENT }),
    ])
  })

  it('refuses a forbidden effect the binding capabilities would allow', async () => {
    const effectful = binding()
    effectful.capabilitySet.effects = ['publication']
    expect(await refusalCodes({ binding: effectful })).toEqual(['COORD_BINDING_FORBIDDEN_EFFECT'])
  })

  it('refuses a provider_transcript item the assignment withholds for reviewer independence', () => {
    const transcript = 'provider transcript'
    const withheld = resolvable((assignment) => {
      assignment.contextPack.items.push({
        role: 'provider_transcript',
        required: false,
        artifact: {
          schema: 'datazup.orchestration.artifact-reference/v1',
          artifactId: 'artifact-transcript',
          digest: sha256(transcript),
          mediaType: 'text/plain',
          sensitivity: 'internal',
          retained: true,
        },
        contentDigest: sha256(transcript),
        sourceBindingDigest: assignment.source.bindingDigest,
        freshness: 'current',
        privacyLabel: 'internal',
      })
    })
    expect(withheld.contextPack.omissions.at(-1)).toMatchObject({
      role: 'provider_transcript',
      reasonCode: 'REVIEWER_INDEPENDENCE',
    })
    expect(decodeCodes(JSON.stringify(withheld))).toEqual(['COORD_CONTEXT_TRANSCRIPT_WITHHELD'])
  })
})

// ---------------------------------------------------------------------------
// 8. No secrets
// ---------------------------------------------------------------------------

describe('8. no secrets', () => {
  it('keeps resolver and environment credentials out of the plan, request and attestation', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', SECRET)
    vi.stubEnv('OPENAI_API_KEY', SECRET)
    const leakyResolver = (() => ({
      content: TASK_CONTENT,
      apiKey: SECRET,
      token: SECRET,
    })) as CoordinationArtifactResolver
    const plan = await compose({ resolveArtifact: leakyResolver })
    const rendered = renderCoordinationAgentExecutionRequest(plan)
    if (!rendered.ok) throw new Error('render refused')
    for (const output of [plan, rendered.request, rendered.attestation]) {
      expect(JSON.stringify(output)).not.toContain(SECRET)
    }
  })

  it('keeps credential values out of refusals', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', SECRET)
    const failing = await composeCoordinationAttemptExecution(input({
      resolveArtifact: () => {
        throw new Error(`auth failed for ${SECRET}`)
      },
    }))
    expect(failing.ok).toBe(false)
    expect(JSON.stringify(failing)).not.toContain(SECRET)

    const credentialBinding = binding()
    credentialBinding.capabilitySet.providerSession = { ...providerSession(), apiKey: SECRET }
    credentialBinding.auth = { mode: 'api_key', sourceRef: AUTH_SOURCE_REF, value: SECRET }
    const refused = await composeCoordinationAttemptExecution(input({ binding: credentialBinding }))
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused)).not.toContain(SECRET)
    if (!refused.ok) {
      expect(refused.refusals.map(({ code }) => code)).toEqual(
        expect.arrayContaining(['COORD_BINDING_SESSION_INVALID', 'COORD_BINDING_FACT_INVALID']),
      )
    }

    const decoded = decodeCoordinationExecutionAssignment(
      JSON.stringify({ ...fixture(), issuerRef: SECRET, secret: SECRET }),
    )
    expect(decoded.ok).toBe(false)
    expect(JSON.stringify(decoded)).not.toContain(SECRET)
  })
})
