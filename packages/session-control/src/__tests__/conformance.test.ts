import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  scanPortableSessionControlValue,
  validateSessionControlConformanceFixture,
} from '../index.js'

const fixturePath = fileURLToPath(
  new URL('../../fixtures/session-control-conformance-v1.json', import.meta.url),
)

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
}

describe('provider-free session-control conformance fixture', () => {
  it('validates the checked-in profiles, manifest, commands, and event trace', () => {
    const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'))
    expect(validateSessionControlConformanceFixture(fixture)).toEqual({
      ok: true,
      summary: {
        qualificationScope: 'provider_free',
        profiles: 2,
        commands: 2,
        events: 5,
        terminalStatus: 'completed',
      },
    })
  })

  it('contains no vendor, product-entity, credential, transcript, or host-path data', () => {
    const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'))
    expect(scanPortableSessionControlValue(fixture)).toEqual({ portable: true, issues: [] })

    const text = JSON.stringify(fixture).toLowerCase()
    expect(text).not.toMatch(/codex|claude|gemini|qwen|goose|crush/)
    expect(text).not.toMatch(/tenantid|projectid|workspaceid/)
  })

  it('fails closed on credential-shaped extensions', () => {
    expect(
      scanPortableSessionControlValue({
        safe: true,
        apiToken: 'must-not-cross-boundary',
      }),
    ).toMatchObject({
      portable: false,
      issues: [expect.objectContaining({ code: 'forbidden_key', path: '$.apiToken' })],
    })
    expect(
      scanPortableSessionControlValue({
        privateKey: 'opaque',
        transcript: 'provider output',
      }),
    ).toMatchObject({
      portable: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'forbidden_key', path: '$.privateKey' }),
        expect.objectContaining({ code: 'forbidden_key', path: '$.transcript' }),
      ]),
    })
  })

  it('rejects fields outside the exact fixture and session schemas', () => {
    expect(
      validateSessionControlConformanceFixture({
        ...fixture(),
        refreshToken: 'must-not-cross-boundary',
      }),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'invalid_fixture_fields', path: '$' })],
    })

    const withSessionExtension = fixture()
    withSessionExtension.session = {
      ...(withSessionExtension.session as Record<string, unknown>),
      clientSecret: 'must-not-cross-boundary',
    }
    expect(validateSessionControlConformanceFixture(withSessionExtension)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'invalid_session_fields', path: 'session' })],
    })
  })

  it('keeps common credential aliases in the portability defense layer', () => {
    expect(
      scanPortableSessionControlValue({
        refreshToken: 'opaque',
        clientSecret: 'opaque',
      }),
    ).toMatchObject({
      portable: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'forbidden_key', path: '$.refreshToken' }),
        expect.objectContaining({ code: 'forbidden_key', path: '$.clientSecret' }),
      ]),
    })
  })

  it('rejects vacuous and non-terminal conformance traces', () => {
    expect(
      validateSessionControlConformanceFixture({
        ...fixture(),
        commands: [],
        events: [],
      }),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'commands_required' })],
    })

    const nonTerminal = fixture()
    nonTerminal.events = (nonTerminal.events as unknown[]).slice(0, -1)
    expect(validateSessionControlConformanceFixture(nonTerminal)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'terminal_outcome_required' })],
    })
  })
})
