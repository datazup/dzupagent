import { describe, expect, it } from 'vitest'
import type { AdapterConfig, EnvFilterConfig } from '../index.js'

describe('adapter config variants', () => {
  it('accepts all declared sandbox modes', () => {
    const modes = ['read-only', 'workspace-write', 'full-access'] as const satisfies readonly NonNullable<
      AdapterConfig['sandboxMode']
    >[]

    const configs: AdapterConfig[] = modes.map((mode) => ({
      sandboxMode: mode,
      timeoutMs: 30_000,
    }))

    expect(configs.map((c) => c.sandboxMode)).toEqual(['read-only', 'workspace-write', 'full-access'])
  })

  it('supports environment filter patterns and explicit allow-list', () => {
    const strictFilter: EnvFilterConfig = {
      blockedPatterns: [/SECRET/i, /^AWS_/],
      allowedVars: ['AWS_REGION'],
      disableFilter: false,
    }

    const passthroughFilter: EnvFilterConfig = {
      disableFilter: true,
    }

    const config: AdapterConfig = {
      env: {
        AWS_REGION: 'eu-central-1',
        APP_ENV: 'test',
      },
      envFilter: strictFilter,
    }

    expect(config.envFilter?.disableFilter).toBe(false)
    expect(config.envFilter?.allowedVars).toContain('AWS_REGION')
    expect(strictFilter.blockedPatterns).toHaveLength(2)
    expect(passthroughFilter.disableFilter).toBe(true)
  })
})

