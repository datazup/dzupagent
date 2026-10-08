import { test, expect } from 'vitest'
import { validateProviderCatalogSnapshotV2, validateProviderInstallationIdentityV2, validateSessionContinuationDecision, validateProviderSessionObservationV2, getProviderCatalogFreshnessV2, isProviderCatalogSnapshotSelectableV2, PROVIDER_CATALOG_SCHEMA_VERSION, type ProviderCatalogSnapshotV2 } from '../provider-session-explorer.js'
import { composeValidators, passingResult, failingResult } from '../contracts/validation.js'

const now = new Date('2026-10-07T12:00:00Z')
const identity = { providerId: 'codex', installationId: 'fixture', backendId: 'local' }
const catalog = (): ProviderCatalogSnapshotV2 => ({ ...identity, schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION, source: 'fixture', observedAt: '2026-10-07T11:59:00Z', expiresAt: '2026-10-07T12:30:00Z', fingerprint: 'sha256:' + 'a'.repeat(64), authenticated: true, completeness: 'runtime', confidence: 'authoritative', warnings: [], models: [{ modelId: 'model', displayName: 'Model', isDefault: true, efforts: [{ effortId: 'high', displayName: 'High', nativeValue: 'high', source: 'fixture', confidence: 'authoritative' }], defaultEffortId: 'high' }], capabilities: { modelCatalog: { support: 'supported', source: 'fixture', observedAt: '2026-10-07T11:59:00Z', expiresAt: '2026-10-07T12:30:00Z' } } })

test('catalog selection requires valid fresh authenticated evidence and usable models', () => {
  expect(isProviderCatalogSnapshotSelectableV2(catalog(), now)).toBe(true)
  expect(getProviderCatalogFreshnessV2({ ...catalog(), expiresAt: now.toISOString() }, now)).toBe('stale')
  expect(getProviderCatalogFreshnessV2({ ...catalog(), observedAt: 'invalid' }, now)).toBe('unknown')
  expect(getProviderCatalogFreshnessV2(catalog(), new Date(NaN))).toBe('unknown')
  expect(getProviderCatalogFreshnessV2({ ...catalog(), observedAt: '2026-10-07T13:00:00Z' }, now)).toBe('unknown')
  for (const extra of [{ confidence: 'unverified' }, { models: [] }, { models: [{ ...catalog().models[0], hidden: true }] }, { models: [{ ...catalog().models[0], deprecated: true }] }, { capabilities: {} }]) {
    expect(isProviderCatalogSnapshotSelectableV2({ ...catalog(), ...extra }, now)).toBe(false)
  }
})

test('public catalog boundaries reject malformed identity, timestamps, constraints and duplicate advertisements', () => {
  for (const input of [null, [], new Date(), { ...identity, providerId: ' bad ' }, { ...identity, backendId: '/fixture/private' }]) expect(validateProviderInstallationIdentityV2(input).valid).toBe(false)
  for (const extra of [
    { unknown: true }, { schemaVersion: 'wrong' }, { source: '/fixture/private' }, { sourceRevision: ' file:///fixture ' }, { fingerprint: null }, { observedAt: 'invalid' }, { expiresAt: 'invalid' }, { expiresAt: '2026-10-07T11:00:00Z' }, { authenticated: 'yes' }, { completeness: 'wrong' }, { confidence: 'wrong' }, { models: null }, { models: Array(1001).fill(null) }, { capabilities: [] }, { warnings: ['authorization=fixture'] }, { authenticated: false },
  ]) expect(validateProviderCatalogSnapshotV2({ ...catalog(), ...extra }).valid).toBe(false)
  const model = catalog().models[0]!
  for (const extra of [{ unknown: 1 }, { modelId: '' }, { displayName: 'cookie=fixture' }, { isDefault: 'yes' }, { hidden: 'yes' }, { deprecated: 'yes' }, { maxInputTokens: 0 }, { maxOutputTokens: 1.5 }, { capabilityConstraints: { token: 'fixture' } }, { efforts: null }, { efforts: Array(101).fill(null) }, { defaultEffortId: 'missing' }, { efforts: [null] }, { efforts: [{ ...model.efforts[0], confidence: 'wrong' }] }, { efforts: [model.efforts[0], model.efforts[0]] }]) {
    expect(validateProviderCatalogSnapshotV2({ ...catalog(), models: [{ ...model, ...extra }] }).valid).toBe(false)
  }
  expect(validateProviderCatalogSnapshotV2({ ...catalog(), models: [model, model] }).valid).toBe(false)
  for (const evidence of [null, { support: 'wrong', source: '', observedAt: 'invalid', expiresAt: 'invalid', qualifiedVersion: '/fixture', constraints: { password: 'fixture' }, unexpected: true }, { support: 'supported', source: 'fixture', observedAt: now.toISOString(), expiresAt: now.toISOString() }]) {
    expect(validateProviderCatalogSnapshotV2({ ...catalog(), capabilities: { modelCatalog: evidence } }).valid).toBe(false)
  }
})

test('native continuation requires fresh authority, capability evidence, version and binding', () => {
  const decision = { mode: 'native_resume', reasonCode: 'qualified', explanation: 'fixture', providerCapabilitySource: 'fixture', qualifiedVersion: '1', bindingGeneration: 0, requiresClaim: true, requiresFreshAuthorization: true }
  expect(validateSessionContinuationDecision(decision).valid).toBe(true)
  for (const extra of [{ unknown: true }, { mode: 'wrong' }, { reasonCode: '' }, { explanation: 'bearer fixture' }, { providerCapabilitySource: undefined }, { qualifiedVersion: undefined }, { bindingGeneration: -1 }, { requiresClaim: 'yes' }, { requiresFreshAuthorization: false }]) expect(validateSessionContinuationDecision({ ...decision, ...extra }).valid).toBe(false)
  expect(validateSessionContinuationDecision(null).valid).toBe(false)
  const observation = { canonicalIdentity: { ...identity, sessionId: 'session', nativeSessionId: 'native', sourceObservationIds: ['first'] }, observedAt: now.toISOString(), continuation: decision }
  expect(validateProviderSessionObservationV2(observation).valid).toBe(true)
  expect(validateProviderSessionObservationV2(null).valid).toBe(false)
  expect(validateProviderSessionObservationV2({ ...observation, canonicalIdentity: { ...observation.canonicalIdentity, sourceObservationIds: ['first', 'first'] } }).valid).toBe(false)
})

test('composed preflight checks retain every issue while preventing execution on any failure', async () => {
  const warning = { code: 'warning', message: 'fixture', severity: 'warning' as const }
  const result = await composeValidators('all', { name: 'first', validate: () => passingResult(warning) }, { name: 'second', validate: async () => failingResult(warning) }).validate({ prompt: 'fixture' }, { providerId: 'codex' })
  expect(result.ok).toBe(false)
  expect(result.issues.map(issue => issue.severity)).toEqual(['warning', 'error'])
})
