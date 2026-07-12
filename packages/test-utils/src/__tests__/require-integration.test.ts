import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  REQUIRED_INTEGRATION_ENV_VAR,
  isRequiredIntegrationLane,
  requireIntegration,
  requireIntegrationEnv,
} from '../require-integration.js'

describe('requireIntegration', () => {
  const originalValue = process.env[REQUIRED_INTEGRATION_ENV_VAR]
  const originalDbUrl = process.env['TEST_DUMMY_DB_URL']

  beforeEach(() => {
    delete process.env[REQUIRED_INTEGRATION_ENV_VAR]
    delete process.env['TEST_DUMMY_DB_URL']
  })

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[REQUIRED_INTEGRATION_ENV_VAR]
    } else {
      process.env[REQUIRED_INTEGRATION_ENV_VAR] = originalValue
    }
    if (originalDbUrl === undefined) {
      delete process.env['TEST_DUMMY_DB_URL']
    } else {
      process.env['TEST_DUMMY_DB_URL'] = originalDbUrl
    }
  })

  describe('isRequiredIntegrationLane', () => {
    it('is false when the env var is unset', () => {
      expect(isRequiredIntegrationLane()).toBe(false)
    })

    it('is true when the env var is set', () => {
      process.env[REQUIRED_INTEGRATION_ENV_VAR] = '1'
      expect(isRequiredIntegrationLane()).toBe(true)
    })
  })

  describe('when the capability is available', () => {
    it('returns shouldSkip: false regardless of the required-integration flag', () => {
      expect(requireIntegration({ name: 'x', available: true, reason: 'n/a' })).toEqual({
        shouldSkip: false,
      })

      process.env[REQUIRED_INTEGRATION_ENV_VAR] = '1'
      expect(requireIntegration({ name: 'x', available: true, reason: 'n/a' })).toEqual({
        shouldSkip: false,
      })
    })
  })

  describe('when the capability is unavailable', () => {
    it('skips (does not throw) when RUN_REQUIRED_INTEGRATION is unset', () => {
      expect(
        requireIntegration({ name: 'my-suite', available: false, reason: 'no docker' })
      ).toEqual({ shouldSkip: true })
    })

    it('throws when RUN_REQUIRED_INTEGRATION=1', () => {
      process.env[REQUIRED_INTEGRATION_ENV_VAR] = '1'

      expect(() =>
        requireIntegration({ name: 'my-suite', available: false, reason: 'no docker' })
      ).toThrowError(/my-suite/)
      expect(() =>
        requireIntegration({ name: 'my-suite', available: false, reason: 'no docker' })
      ).toThrowError(/no docker/)
    })

    it('does not throw for falsy-but-set values of RUN_REQUIRED_INTEGRATION like "0"', () => {
      // Documented behaviour: any truthy string (including "0", since it is
      // a non-empty string) enables the required lane. Callers must unset
      // the var entirely to disable it. Verify "0" *does* enable it, since
      // that's a common footgun.
      process.env[REQUIRED_INTEGRATION_ENV_VAR] = '0'
      expect(isRequiredIntegrationLane()).toBe(true)
      expect(() =>
        requireIntegration({ name: 'my-suite', available: false, reason: 'no docker' })
      ).toThrow()
    })
  })

  describe('requireIntegrationEnv', () => {
    it('is available when the env var is a non-empty string', () => {
      process.env['TEST_DUMMY_DB_URL'] = 'postgres://localhost/test'
      expect(
        requireIntegrationEnv('dummy-db-suite', 'TEST_DUMMY_DB_URL')
      ).toEqual({ shouldSkip: false })
    })

    it('skips when the env var is unset and the required lane is off', () => {
      expect(
        requireIntegrationEnv('dummy-db-suite', 'TEST_DUMMY_DB_URL')
      ).toEqual({ shouldSkip: true })
    })

    it('throws when the env var is unset and the required lane is on', () => {
      process.env[REQUIRED_INTEGRATION_ENV_VAR] = '1'
      expect(() => requireIntegrationEnv('dummy-db-suite', 'TEST_DUMMY_DB_URL')).toThrowError(
        /TEST_DUMMY_DB_URL/
      )
    })

    it('treats an empty-string env var as unavailable', () => {
      process.env['TEST_DUMMY_DB_URL'] = ''
      expect(
        requireIntegrationEnv('dummy-db-suite', 'TEST_DUMMY_DB_URL')
      ).toEqual({ shouldSkip: true })
    })
  })
})
