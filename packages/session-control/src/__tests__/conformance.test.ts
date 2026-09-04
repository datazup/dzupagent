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
  })
})
