import { afterEach, describe, expect, it } from 'vitest'

import { requireIntegrationEnv } from './require-integration-env.js'

const REQUIRED = 'RUN_REQUIRED_INTEGRATION'
const CAPABILITY = 'DZUPAGENT_TEST_INTEGRATION_URL'
const originalRequired = process.env[REQUIRED]
const originalCapability = process.env[CAPABILITY]

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restoreEnv(REQUIRED, originalRequired)
  restoreEnv(CAPABILITY, originalCapability)
})

describe('requireIntegrationEnv', () => {
  it('runs when the capability environment variable is present', () => {
    process.env[CAPABILITY] = 'available'
    delete process.env[REQUIRED]

    expect(requireIntegrationEnv('integration', CAPABILITY)).toEqual({
      shouldSkip: false,
    })
  })

  it('skips locally when the capability is absent', () => {
    delete process.env[CAPABILITY]
    delete process.env[REQUIRED]

    expect(requireIntegrationEnv('integration', CAPABILITY)).toEqual({
      shouldSkip: true,
    })
  })

  it('fails closed in the required integration lane', () => {
    delete process.env[CAPABILITY]
    process.env[REQUIRED] = '1'

    expect(() =>
      requireIntegrationEnv('integration', CAPABILITY),
    ).toThrow(
      'RUN_REQUIRED_INTEGRATION=1 requires this suite to run rather than skip',
    )
  })
})
