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
  COORDINATION_ATTEMPT_EXECUTION_ATTESTATION_SCHEMA,
  COORDINATION_ATTEMPT_REPORT_JSON_SCHEMA,
  COORDINATION_EXECUTABLE_ROUTES,
  COORDINATION_RENDERER_PROFILES,
  composeCoordinationAttemptExecution,
  coordinationCanonicalDigest,
  coordinationSelfDigest,
  coordinationUnknownKeySegment,
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
  assignment.contextPack.profile.profileRef = coordinationSelfDigest(assignment.contextPack.profile, 'profileRef')
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

/** Re-point every copy of the source binding digest after the source changed. */
function rebindSource(assignment: Json): void {
  const digest = assignment.source.bindingDigest
  assignment.workIntent.claims[0].baseFingerprint = digest
  assignment.contextPack.sourceBindingDigest = digest
  for (const item of assignment.contextPack.items) item.sourceBindingDigest = digest
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

/** Decode a (re)sealed test assignment with its own canonical seal as the expected seal. */
function decode(assignment: Json): DecodedCoordinationExecutionAssignment {
  const result = decodeCoordinationExecutionAssignment(JSON.stringify(assignment), {
    expectedSeal: coordinationCanonicalDigest(assignment),
  })
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
    schema: 'dzupagent.coordinationExecutionBinding/v2',
    bindingId: 'execution-binding-1',
    providerId: 'claude',
    backend: 'sdk',
    agentHost: null,
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
    backendId: 'claude-agent-sdk',
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

function decodePaths(assignment: Json): string[] {
  const result = decodeCoordinationExecutionAssignment(JSON.stringify(assignment))
  expect(result.ok).toBe(false)
  return result.ok ? [] : result.diagnostics.map(({ code, path }) => `${code} ${path}`)
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
      'contextPack.profile.profileRef',
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

  it('never echoes an unknown key name and bounds JSON like the producer', () => {
    const keyed = fixture()
    keyed.contextPack[SECRET] = 1
    const paths = decodePaths(keyed)
    expect(paths).toContain(`COORD_ASSIGNMENT_FIELD_UNKNOWN $.contextPack.${coordinationUnknownKeySegment(SECRET)}`)
    expect(JSON.stringify(paths)).not.toContain(SECRET)
    const indexKey = resolvable((assignment) => {
      assignment.workIntent.claims[0].metadata = { b: 1, 2: 3, 10: 2 }
    })
    // Refused at the document bound: the two canonicalizers order such keys differently.
    expect(decodePaths(indexKey)).toEqual(['COORD_ASSIGNMENT_FIELD_INVALID $'])
    const infinite = JSON.stringify(fixture()).replace('"maxInputTokens":80000', '"maxInputTokens":1e400')
    expect(decodeCodes(infinite)).toEqual(['COORD_ASSIGNMENT_FIELD_INVALID'])
    const deep = resolvable((assignment) => {
      assignment.workIntent.claims[0].metadata = { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }
    })
    expect(decodePaths(deep)).toEqual(['COORD_ASSIGNMENT_FIELD_INVALID $.workIntent.claims.0.metadata'])
  })

  it('accepts producer-valid optional claim fields', () => {
    const extended = resolvable((assignment) => {
      assignment.workIntent.claims.push({
        schemaVersion: 'resource-claim/v1',
        claimId: 'claim-docs-read',
        taskId: 'task-scripts-adapter',
        resourceId: 'resource-docs',
        mode: 'immutable_read',
        scope: 'group',
        baseFingerprint: 'git:tree:abc123',
        semanticGroups: ['docs'],
        confidence: 'derived',
        enforcement: 'advisory',
        metadata: { note: 'read only', tags: ['a', 'b'] },
      })
    })
    expect(decode(extended).assignment.workIntent.claims).toHaveLength(2)
  })

  it.each([
    ['an integration grant', (a: Json) => {
      a.authorityBundle.grants.push({ ...a.authorityBundle.grants[0], factClass: 'integration', grantRef: 'grant:integration' })
    }, '$.authorityBundle.grants.4.factClass'],
    ['an allowed effect without an effect grant', (a: Json) => {
      a.allowedEffects = ['ref-push']
      a.sessionEnrollment.allowedEffects = ['ref-push']
    }, '$.allowedEffects.0'],
    ['assignment and session effects that differ', (a: Json) => {
      a.forbiddenEffects = ['publication', 'deployment']
    }, '$.forbiddenEffects'],
    ['an assignment outliving its session', (a: Json) => {
      a.sessionEnrollment.expiresAt = '2026-08-30T10:50:00Z'
    }, '$.notAfter'],
    ['an assignment outliving a grant', (a: Json) => {
      a.authorityBundle.grants[2].notAfter = '2026-08-30T10:50:00Z'
    }, '$.authorityBundle.grants.2.notAfter'],
    ['a missing required fact class', (a: Json) => {
      a.authorityBundle.grants[3].factClass = 'resource'
      a.workIntent.authorityRequirements = ['execution', 'placement', 'resource']
    }, '$.authorityBundle.grants'],
    ['a duplicate singleton grant', (a: Json) => {
      a.authorityBundle.grants.push({ ...a.authorityBundle.grants[0], grantRef: 'grant:execution-2' })
    }, '$.authorityBundle.grants.4.factClass'],
    ['a grant generation that differs from its bundle', (a: Json) => {
      a.authorityBundle.grants[1].generation = 6
    }, '$.authorityBundle.grants.1.generation'],
    ['a workspace binding to a non-placement grant', (a: Json) => {
      a.workspace.authorityBindingRef = 'grant:budget'
    }, '$.workspace.authorityBindingRef'],
    ['a read-only repository claim', (a: Json) => {
      a.workIntent.claims[0].mode = 'immutable_read'
    }, '$.workIntent.claims'],
    ['a claim for another task', (a: Json) => {
      a.workIntent.claims[0].taskId = 'task-other'
    }, '$.workIntent.claims.0.taskId'],
    ['a self-dependency', (a: Json) => {
      a.workIntent.dependencies = ['task-scripts-adapter']
    }, '$.workIntent.dependencies'],
    ['item requiredness that differs from the profile', (a: Json) => {
      a.contextPack.items[0].required = false
    }, '$.contextPack.items.0.required'],
    ['a profile that does not classify every role', (a: Json) => {
      a.contextPack.profile.optionalRoles.pop()
      a.contextPack.omissions.pop()
    }, '$.contextPack.profile'],
    ['an absent optional role without an omission', (a: Json) => {
      a.contextPack.omissions.shift()
    }, '$.contextPack.profile.optionalRoles.0'],
    ['privacy labels that do not cover the items', (a: Json) => {
      a.contextPack.privacyLabels = ['internal', 'restricted']
    }, '$.contextPack.privacyLabels'],
    ['clean source carrying overlay evidence', (a: Json) => {
      a.source.overlayScopeDigest = `sha256:${'5'.repeat(64)}`
      a.workspace.source.overlayScopeDigest = `sha256:${'5'.repeat(64)}`
      a.workspace.source.bindingDigest = coordinationSelfDigest(a.workspace.source, 'bindingDigest')
      a.source.bindingDigest = coordinationSelfDigest(a.source, 'bindingDigest')
      rebindSource(a)
    }, '$.source.overlayArtifact'],
    ['a workspace generation that differs from its source', (a: Json) => {
      a.workspace.generation = 8
    }, '$.workspace.generation'],
  ])('rejects %s like the producer', (_name, mutate, path) => {
    const paths = decodePaths(resolvable(mutate))
    expect(paths).toContain(`COORD_ASSIGNMENT_INCONSISTENT ${path}`)
  })

  it('rejects a profile reference that does not bind the role policy', () => {
    const drifted = fixture()
    drifted.contextPack.profile.limits.maxInputTokens = 90000
    expect(decodePaths(drifted)).toContain('COORD_ASSIGNMENT_DIGEST_MISMATCH $.contextPack.profile.profileRef')
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
    // The producer forbids an assignment outliving a grant, so both expire together.
    const decoded = decode(resolvable((assignment) => {
      assignment.authorityBundle.grants[2].notAfter = '2026-08-30T10:30:00Z'
      assignment.notAfter = '2026-08-30T10:30:00Z'
    }))
    const codes = await refusalCodes({ decoded })
    expect(codes).toContain('COORD_GRANT_EXPIRED')
    expect(codes.filter((code) => code === 'COORD_GRANT_EXPIRED')).toHaveLength(1)
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
      assignment.notAfter = '2026-08-30T10:20:00Z'
    }))
    expect(await refusalCodes({ decoded })).toContain('COORD_SESSION_EXPIRED')
  })

  it('refuses a grant generation that differs from the attempt', async () => {
    // Grants must bind their bundle generation, so the whole bundle is stale.
    const decoded = decode(resolvable((assignment) => {
      assignment.authorityBundle.generation = 6
      for (const grant of assignment.authorityBundle.grants) grant.generation = 6
    }))
    const codes = await refusalCodes({ decoded })
    expect(codes.filter((code) => code === 'COORD_GRANT_GENERATION_MISMATCH')).toHaveLength(4)
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

describe('3b. only sealed, decoder-issued assignments compose', () => {
  it('refuses an assignment decoded without a producer seal', async () => {
    const unsealed = decodeCoordinationExecutionAssignment(JSON.stringify(resolvable()))
    if (!unsealed.ok) throw new Error('did not decode')
    expect(unsealed.value.sealVerified).toBe(false)
    expect(await refusalCodes({ decoded: unsealed.value })).toEqual(['COORD_ASSIGNMENT_UNSEALED'])
  })

  it('refuses a frozen look-alike that the decoder did not issue, without throwing', async () => {
    const forged = Object.freeze({ ...decode(resolvable()) })
    expect(await refusalCodes({ decoded: forged })).toEqual(['COORD_ASSIGNMENT_NOT_DECODED'])
    const malformed = Object.freeze({ assignment: Object.freeze({}), sealVerified: true }) as never
    expect(await refusalCodes({ decoded: malformed })).toEqual(['COORD_ASSIGNMENT_NOT_DECODED'])
  })

  it('snapshots the binding once, so getters and later mutation cannot switch provider', async () => {
    const live = binding()
    let reads = 0
    Object.defineProperty(live, 'providerId', {
      enumerable: true,
      get: () => (reads++ === 0 ? 'claude' : 'codex'),
    })
    const resolveAndMutate: CoordinationArtifactResolver = async (request) => {
      live.model = 'model-swapped'
      live.capabilitySet.providerSession.descriptor.providerId = 'codex'
      return resolveTask(request)
    }
    const plan = await compose({ binding: live, resolveArtifact: resolveAndMutate })
    expect(plan.execution.providerId).toBe('claude')
    expect(plan.execution.model).toBe(MODEL)
    expect(reads).toBe(1)
  })

  it('refuses non-plain or malformed inputs without throwing', async () => {
    class BindingLike {}
    expect(await refusalCodes({ binding: new BindingLike() })).toEqual(['COORD_BINDING_INVALID'])
    expect(await refusalCodes({ modelCatalog: { providerId: 'claude' } as never })).toEqual(['COORD_CATALOG_INVALID'])
    expect(await refusalCodes({
      modelCatalog: catalog({ models: [{ id: MODEL, supportedReasoningEfforts: [1, null] }] as never }),
    })).toEqual(['COORD_REASONING_SUPPORT_UNKNOWN'])
    expect(await refusalCodes({ now: 'not-a-time' })).toEqual(['COORD_NOW_INVALID'])
    const result = await composeCoordinationAttemptExecution(null as never)
    expect(result.ok).toBe(false)
    const rendered = renderCoordinationAgentExecutionRequest(null as never)
    expect(rendered.ok).toBe(false)
  })

  it('hashes caller-chosen key names in binding refusals', async () => {
    const keyed = binding({ [SECRET]: true })
    keyed.capabilitySet.providerSession = { ...providerSession(), [SECRET]: 'x' }
    const result = await composeCoordinationAttemptExecution(input({ binding: keyed }))
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(SECRET)
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
    expect(altered.ok ? [] : altered.refusals.map(({ code }) => code)).toEqual(['COORD_PLAN_NOT_COMPOSED'])
    // A hand-built plan with a correctly recomputed digest is still not a composed plan.
    const { planDigest: _ignored, ...unsigned } = copy
    const forged = { ...unsigned, planDigest: coordinationCanonicalDigest(unsigned) }
    deepFreeze(forged)
    const rendered = renderCoordinationAgentExecutionRequest(forged as CoordinationAttemptExecutionPlan)
    expect(rendered.ok ? [] : rendered.refusals.map(({ code }) => code)).toEqual(['COORD_PLAN_NOT_COMPOSED'])
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

// ---------------------------------------------------------------------------
// 9. Binding axes (MVP-04-CP03)
// ---------------------------------------------------------------------------

describe('9. binding axes', () => {
  async function refusals(overrides: Record<string, unknown>): Promise<string[]> {
    const result = await composeCoordinationAttemptExecution(input({ binding: binding(overrides) }))
    expect(result.ok).toBe(false)
    return result.ok ? [] : result.refusals.map(({ code, path }) => `${code} ${path}`)
  }

  it('declares only own-host codex and claude routes as executable', () => {
    expect(COORDINATION_EXECUTABLE_ROUTES).toEqual([
      { providerId: 'codex', agentHost: null, backend: 'cli' },
      { providerId: 'codex', agentHost: null, backend: 'sdk' },
      { providerId: 'claude', agentHost: null, backend: 'cli' },
      { providerId: 'claude', agentHost: null, backend: 'sdk' },
    ])
    expect(isDeepFrozen(COORDINATION_EXECUTABLE_ROUTES)).toBe(true)
  })

  it('expresses Qwen through Crush on separate axes and refuses it as written', async () => {
    expect(await refusals({ providerId: 'qwen', agentHost: 'crush', backend: 'cli' })).toEqual([
      'COORD_BINDING_ROUTE_UNSUPPORTED $binding.agentHost',
    ])
  })

  it('refuses the flattened form and a wrapped own-host provider on their own axis', async () => {
    expect(await refusals({ providerId: 'crush', agentHost: null, backend: 'cli' })).toEqual([
      'COORD_BINDING_ROUTE_UNSUPPORTED $binding.providerId',
    ])
    expect(await refusals({ providerId: 'codex', agentHost: 'crush', backend: 'cli' })).toEqual([
      'COORD_BINDING_ROUTE_UNSUPPORTED $binding.agentHost',
    ])
  })

  it('never echoes a provider or host name in a route refusal', async () => {
    const result = await composeCoordinationAttemptExecution(
      input({ binding: binding({ providerId: 'qwen-sentinel', agentHost: 'crush-sentinel', backend: 'cli' }) }),
    )
    expect(JSON.stringify(result)).not.toMatch(/sentinel/u)
  })

  it('uses the canonical backend vocabulary: api is unexecutable, http is outside it', async () => {
    expect(await refusals({ backend: 'api' })).toEqual(['COORD_BINDING_ROUTE_UNSUPPORTED $binding.backend'])
    expect(await refusals({ backend: 'http' })).toEqual(['COORD_BINDING_FACT_INVALID $binding.backend'])
  })

  it('requires agentHost with no default and refuses a v1 binding', async () => {
    const missing = binding()
    delete missing.agentHost
    const result = await composeCoordinationAttemptExecution(input({ binding: missing }))
    expect(result.ok ? [] : result.refusals.map(({ code, path }) => `${code} ${path}`)).toEqual([
      'COORD_BINDING_FACT_MISSING $binding.agentHost',
    ])
    expect(await refusals({ agentHost: '' })).toEqual(['COORD_BINDING_FACT_INVALID $binding.agentHost'])
    expect(await refusals({ schema: 'dzupagent.coordinationExecutionBinding/v1' })).toEqual([
      'COORD_BINDING_FACT_INVALID $binding.schema',
    ])
  })

  it('requires the catalog to attest the backend the session binds', async () => {
    expect(await refusalCodes({ modelCatalog: catalog({ backendId: undefined }) })).toEqual([
      'COORD_CATALOG_BACKEND_UNATTESTED',
    ])
    expect(await refusalCodes({ modelCatalog: catalog({ backendId: 'claude-code-cli' }) })).toEqual([
      'COORD_CATALOG_BACKEND_MISMATCH',
    ])
  })

  it('refuses a required session operation the descriptor marks unsupported, without emulation', async () => {
    const session = providerSession()
    const unsupported = binding({
      capabilitySet: {
        providerSession: {
          ...session,
          descriptor: {
            ...session.descriptor,
            capabilities: {
              ...session.descriptor.capabilities,
              'goal-control': { status: 'unsupported', emulation: 'forbidden', reason: 'not offered by this backend' },
            },
          },
        },
        requiredCapabilities: ['execute', 'stream', 'goal-control'],
        effects: [],
      },
    })
    const result = await composeCoordinationAttemptExecution(input({ binding: unsupported }))
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.refusals.map(({ code }) => code)).toEqual(['COORD_BINDING_CAPABILITY_UNSUPPORTED'])
  })

  it('binds agent host and physical backend identity into the plan digest', async () => {
    const plan = await compose()
    expect(plan.schema).toBe('dzupagent.coordinationAttemptExecutionPlan/v3')
    expect(plan.execution.agentHost).toBeNull()
    expect(plan.execution.backendId).toBe('claude-agent-sdk')
    const { planDigest, ...unsigned } = plan
    expect(coordinationCanonicalDigest({ ...unsigned, execution: { ...unsigned.execution, agentHost: 'crush' } })).not.toBe(planDigest)
    expect(coordinationCanonicalDigest({ ...unsigned, execution: { ...unsigned.execution, backendId: 'other' } })).not.toBe(planDigest)
  })

  it('pins the rendered request bytes under renderer claude-sdk/v1', async () => {
    // Byte-identical from dzupagent 4d9f4abd8 (binding v1) through CP04; re-pinned
    // by MVP-04-CP05, whose renderer adds freshness, omission disclosure and the report section.
    const api = renderCoordinationAgentExecutionRequest(await compose())
    const subscription = renderCoordinationAgentExecutionRequest(
      await compose({ binding: binding({ auth: { mode: 'subscription_cli', sourceRef: AUTH_SOURCE_REF } }) }),
    )
    if (!api.ok || !subscription.ok) throw new Error('render refused')
    expect(api.request).not.toHaveProperty('agentHost')
    expect(api.attestation.requestDigest).toBe('sha256:dd2de9658ef0bc217c4630d3e1117ea80aec5e331684695c202ae6ada2b604ef')
    expect(subscription.attestation.requestDigest).toBe('sha256:d2dfae6951dff7f4140435eeedb3a8e6cd9fd36991351e62fec19bb02f73caba')
  })
})

// Context helpers shared by the context-pack (CP04) and renderer (CP05) blocks.

const MEMORY_CONTENT = 'curated memory: prefer the existing execution seam'

/** Adds an optional curated_memory item in place of its producer omission. */
function withMemory(mutate: (item: Json) => void = () => {}): (assignment: Json) => void {
  return (assignment) => {
    const item: Json = {
      role: 'curated_memory',
      required: false,
      artifact: {
        schema: 'datazup.orchestration.artifact-reference/v1',
        artifactId: 'artifact-memory',
        digest: sha256(MEMORY_CONTENT),
        mediaType: 'text/plain',
        sensitivity: 'internal',
        retained: true,
      },
      contentDigest: sha256(MEMORY_CONTENT),
      sourceBindingDigest: assignment.source.bindingDigest,
      freshness: 'current',
      privacyLabel: 'internal',
    }
    mutate(item)
    assignment.contextPack.items.push(item)
    assignment.contextPack.omissions = assignment.contextPack.omissions.filter(
      (omission: Json) => omission.role !== 'curated_memory',
    )
  }
}

const resolveBoth: CoordinationArtifactResolver = ({ digest }) => {
  if (digest === sha256(TASK_CONTENT)) return { content: TASK_CONTENT }
  if (digest === sha256(MEMORY_CONTENT)) return { content: MEMORY_CONTENT }
  return undefined
}

function codex(): Partial<ComposeCoordinationAttemptExecutionInput> {
  const session = providerSession()
  return {
    binding: binding({
      providerId: 'codex',
      backend: 'cli',
      capabilitySet: {
        providerSession: {
          ...session,
          descriptor: { ...session.descriptor, providerId: 'codex', backend: { id: 'codex-cli', kind: 'cli' } },
        },
        requiredCapabilities: ['execute', 'stream'],
        effects: [],
      },
    }),
    modelCatalog: catalog({
      providerId: 'codex',
      backendId: 'codex-cli',
      models: [{ providerId: 'codex', id: MODEL, displayName: 'Sentinel model', supportedReasoningEfforts: ['high'] }],
    }),
  }
}

// ---------------------------------------------------------------------------
// 10. Context pack (MVP-04-CP04)
// ---------------------------------------------------------------------------

describe('10. context pack', () => {
  it('carries requiredness, freshness and the producer omission receipt with its evidence', async () => {
    const plan = await compose()
    expect(plan.context.items).toEqual([
      expect.objectContaining({ role: 'task', required: true, freshness: 'current' }),
    ])
    expect(plan.context.omittedRoles).toHaveLength(13)
    expect(plan.context.omittedRoles[0]).toEqual({
      role: 'acceptance_spec',
      reasonCode: 'NOT_APPLICABLE',
      evidenceRef: 'evidence:acceptance-spec',
    })
    expect(plan.context.omittedRoles.at(-1)).toEqual({
      role: 'provider_transcript',
      reasonCode: 'REVIEWER_INDEPENDENCE',
      evidenceRef: 'policy:review-independent-v1',
    })
    expect(plan.context.receiverOmissions).toEqual([])
  })

  it('refuses an altered optional object; it never becomes an omission', async () => {
    const decoded = decode(resolvable(withMemory()))
    expect(await refusalCodes({
      decoded,
      resolveArtifact: (request) =>
        request.role === 'curated_memory' ? { content: `${MEMORY_CONTENT} ` } : resolveTask(request),
    })).toEqual(['COORD_CONTEXT_DIGEST_MISMATCH'])
  })

  it('omits a missing optional object with a reason code and never delivers it', async () => {
    const decoded = decode(resolvable(withMemory()))
    for (const resolveArtifact of [
      resolveTask,
      (async (request) => {
        if (request.role === 'curated_memory') throw new Error(`store down ${SECRET}`)
        return resolveTask(request)
      }) satisfies CoordinationArtifactResolver,
    ]) {
      const plan = await compose({ decoded, resolveArtifact })
      expect(plan.context.items.map(({ role }) => role)).toEqual(['task'])
      expect(plan.context.receiverOmissions).toEqual([
        {
          role: 'curated_memory',
          artifactId: 'artifact-memory',
          contentDigest: sha256(MEMORY_CONTENT),
          reasonCode: 'OBJECT_UNAVAILABLE',
        },
      ])
      const rendered = renderCoordinationAgentExecutionRequest(plan)
      if (!rendered.ok) throw new Error('render refused')
      expect(JSON.stringify(rendered.request)).not.toContain(MEMORY_CONTENT)
      expect(JSON.stringify(plan)).not.toContain(SECRET)
    }
    // A missing required object still refuses.
    expect(await refusalCodes({ decoded, resolveArtifact: () => undefined })).toEqual([
      'COORD_CONTEXT_REQUIRED_UNRESOLVED',
    ])
  })

  it('refuses a required object of unknown freshness without resolving it', async () => {
    const resolver = vi.fn(resolveTask)
    const decoded = decode(resolvable((assignment) => {
      assignment.contextPack.items[0].freshness = 'unknown'
    }))
    const result = await composeCoordinationAttemptExecution(input({ decoded, resolveArtifact: resolver }))
    expect(result.ok ? [] : result.refusals.map(({ code, path }) => `${code} ${path}`)).toEqual([
      'COORD_CONTEXT_REQUIRED_STALE $.contextPack.items.0.freshness',
    ])
    expect(resolver).not.toHaveBeenCalled()
  })

  it('omits an optional object of unknown freshness without resolving it', async () => {
    const resolver = vi.fn(resolveBoth)
    const decoded = decode(resolvable(withMemory((item) => {
      item.freshness = 'unknown'
    })))
    const plan = await compose({ decoded, resolveArtifact: resolver })
    expect(plan.context.receiverOmissions).toEqual([
      expect.objectContaining({ role: 'curated_memory', reasonCode: 'FRESHNESS_UNKNOWN' }),
    ])
    expect(resolver.mock.calls.map(([request]) => request.role)).toEqual(['task'])
  })

  it('delivers an admitted-stale object with its label', async () => {
    const decoded = decode(resolvable((assignment) => {
      assignment.contextPack.items[0].freshness = 'admitted-stale'
    }))
    const plan = await compose({ decoded })
    expect(plan.context.items).toEqual([
      expect.objectContaining({ role: 'task', freshness: 'admitted-stale', content: TASK_CONTENT }),
    ])
  })

  it('names the delivered pack with one provider-neutral, content-addressed digest', async () => {
    const decoded = decode(resolvable(withMemory()))
    const claude = await compose({ decoded, resolveArtifact: resolveBoth })
    const codexPlan = await compose({ decoded, resolveArtifact: resolveBoth, ...codex() })
    const later = await compose({ decoded, resolveArtifact: resolveBoth, now: '2026-08-30T10:31:00Z' })
    const bytes = await compose({
      decoded,
      resolveArtifact: (request) => {
        const resolved = resolveBoth(request) as { content: string } | undefined
        return resolved ? { content: new TextEncoder().encode(resolved.content) } : undefined
      },
    })
    expect(codexPlan.execution.providerId).toBe('codex')
    expect(new Set([claude, codexPlan, later, bytes].map((plan) => plan.context.packDigest)).size).toBe(1)
    expect(new Set([claude, codexPlan, later].map((plan) => plan.planDigest)).size).toBe(3)
    expect(claude.context.packDigest).not.toBe(claude.context.manifestDigest)

    // A different delivered set is a different pack.
    const partial = await compose({ decoded, resolveArtifact: resolveTask })
    expect(partial.context.manifestDigest).toBe(claude.context.manifestDigest)
    expect(partial.context.packDigest).not.toBe(claude.context.packDigest)
    const { planDigest, ...unsigned } = claude
    expect(coordinationCanonicalDigest({ ...unsigned, context: { ...unsigned.context, packDigest: partial.context.packDigest } })).not.toBe(planDigest)
  })
})

// ---------------------------------------------------------------------------
// 11. Renderers and reports (MVP-04-CP05)
// ---------------------------------------------------------------------------

describe('11. renderers and reports', () => {
  const REPORT_MARK = '\n\nReport: '

  function routed(providerId: 'codex' | 'claude', backend: 'cli' | 'sdk'): Partial<ComposeCoordinationAttemptExecutionInput> {
    const session = providerSession()
    const backendId = `${providerId}-${backend}`
    return {
      binding: binding({
        providerId,
        backend,
        auth: backend === 'cli'
          ? { mode: 'subscription_cli', sourceRef: AUTH_SOURCE_REF }
          : { mode: 'api_key', sourceRef: AUTH_SOURCE_REF },
        capabilitySet: {
          providerSession: {
            ...session,
            descriptor: { ...session.descriptor, providerId, backend: { id: backendId, kind: backend } },
          },
          requiredCapabilities: ['execute', 'stream'],
          effects: [],
        },
      }),
      modelCatalog: catalog({
        providerId,
        backendId,
        models: [{ providerId, id: MODEL, displayName: 'Sentinel model', supportedReasoningEfforts: ['high'] }],
      }),
    }
  }

  function split(prompt: string): { body: string; report: string } {
    const at = prompt.indexOf(REPORT_MARK)
    if (at < 0) throw new Error('prompt has no report section')
    return { body: prompt.slice(0, at), report: prompt.slice(at) }
  }

  it('has exactly one versioned profile per executable route', () => {
    const key = ({ providerId, agentHost, backend }: { providerId: string; agentHost: null; backend: string }) =>
      `${providerId}/${agentHost ?? 'own'}/${backend}`
    expect(COORDINATION_RENDERER_PROFILES.map(key)).toEqual(COORDINATION_EXECUTABLE_ROUTES.map(key))
    expect(new Set(COORDINATION_RENDERER_PROFILES.map(({ rendererId }) => rendererId)).size).toBe(4)
    expect(COORDINATION_RENDERER_PROFILES.every(({ rendererId }) => /\/v1$/.test(rendererId))).toBe(true)
    expect(Object.fromEntries(COORDINATION_RENDERER_PROFILES.map((profile) => [key(profile), profile.reportTransport]))).toEqual({
      'codex/own/cli': 'native_schema',
      'codex/own/sdk': 'native_schema',
      'claude/own/cli': 'native_schema',
      'claude/own/sdk': 'wrapper_capture',
    })
  })

  it('requests the report natively only where the adapter forwards outputSchema', async () => {
    for (const profile of COORDINATION_RENDERER_PROFILES) {
      const rendered = renderCoordinationAgentExecutionRequest(await compose(routed(profile.providerId, profile.backend)))
      if (!rendered.ok) throw new Error(`render refused: ${JSON.stringify(rendered.refusals)}`)
      expect(rendered.attestation).toMatchObject({
        schema: COORDINATION_ATTEMPT_EXECUTION_ATTESTATION_SCHEMA,
        rendererId: profile.rendererId,
        reportTransport: profile.reportTransport,
      })
      const { report } = split(rendered.request.prompt)
      if (profile.reportTransport === 'native_schema') {
        expect(rendered.request.outputSchema).toEqual(COORDINATION_ATTEMPT_REPORT_JSON_SCHEMA)
        expect(report).toContain('structured output requested by the attached schema')
      } else {
        expect(rendered.request).not.toHaveProperty('outputSchema')
        expect(report).toContain('exactly one fenced block tagged coordination-report')
      }
      expect(report).toContain('It grants no scope and no effect')
      expect(report).toContain('attemptId "attempt-scripts-critical"')
    }
    expect(COORDINATION_ATTEMPT_EXECUTION_ATTESTATION_SCHEMA).toBe('dzupagent.coordinationAttemptExecutionAttestation/v2')
  })

  it('renders every profile from the same canonical body', async () => {
    const decoded = decode(resolvable(withMemory()))
    const codexPlan = await compose({ decoded, resolveArtifact: resolveBoth, ...routed('codex', 'cli') })
    const claudePlan = await compose({ decoded, resolveArtifact: resolveBoth, ...routed('claude', 'sdk') })
    const codexRendered = renderCoordinationAgentExecutionRequest(codexPlan)
    const claudeRendered = renderCoordinationAgentExecutionRequest(claudePlan)
    if (!codexRendered.ok || !claudeRendered.ok) throw new Error('render refused')
    const codexPrompt = split(codexRendered.request.prompt)
    const claudePrompt = split(claudeRendered.request.prompt)
    expect(codexPrompt.body).toBe(claudePrompt.body)
    expect(codexPrompt.report).not.toBe(claudePrompt.report)
    expect(codexPlan.context.packDigest).toBe(claudePlan.context.packDigest)
    expect(codexPrompt.body).toContain(MEMORY_CONTENT)
  })

  it('discloses omissions and freshness without delivering omitted content', async () => {
    const decoded = decode(resolvable((assignment) => {
      withMemory()(assignment)
      assignment.contextPack.items[0].freshness = 'admitted-stale'
    }))
    const plan = await compose({ decoded, resolveArtifact: resolveTask })
    const rendered = renderCoordinationAgentExecutionRequest(plan)
    if (!rendered.ok) throw new Error('render refused')
    const { body } = split(rendered.request.prompt)
    expect(body).toContain('freshness="admitted-stale"')
    expect(body).toContain('Context omissions: the context pack is partial.')
    expect(body).toContain('- curated_memory: artifact artifact-memory not delivered to this attempt (OBJECT_UNAVAILABLE)')
    expect(body).toContain('- acceptance_spec: omitted by the issuer (NOT_APPLICABLE; evidence evidence:acceptance-spec)')
    expect(body).toContain('- provider_transcript: omitted by the issuer (REVIEWER_INDEPENDENCE; evidence policy:review-independent-v1)')
    expect(body).not.toContain(MEMORY_CONTENT)
    expect(body).not.toContain('the context pack is complete')
  })
})
