import { describe, it, expect } from 'vitest'

import { filterSensitiveEnvVars } from '../base/base-cli-adapter.js'

describe('Environment Variable Filtering', () => {
  const baseEnv: Record<string, string> = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    MY_SECRET: 'hidden',
    DB_PASSWORD: 'pass123',
    AUTH_TOKEN: 'tok_abc',
    TOKEN_LIMIT: '4096',
    TOKEN_COUNT: '100',
    TOKENS_PER_MIN: '60',
    PRIVATE_KEY: 'pk_xyz',
    DATABASE_URL: 'postgres://localhost/db',
    JWT_SECRET: 'jwtsecret',
    COOKIE_SECRET: 'cookiesecret',
    NODE_ENV: 'production',
  }

  it('should filter SECRET-containing vars by default', () => {
    const result = filterSensitiveEnvVars(baseEnv)
    expect(result).not.toHaveProperty('MY_SECRET')
    expect(result).not.toHaveProperty('JWT_SECRET')
    expect(result).not.toHaveProperty('COOKIE_SECRET')
  })

  it('should filter PASSWORD-containing vars by default', () => {
    const result = filterSensitiveEnvVars(baseEnv)
    expect(result).not.toHaveProperty('DB_PASSWORD')
  })

  it('should filter TOKEN vars but not TOKEN_LIMIT, TOKEN_COUNT, or TOKENS_PER_MIN', () => {
    const result = filterSensitiveEnvVars(baseEnv)
    expect(result).not.toHaveProperty('AUTH_TOKEN')
    expect(result).toHaveProperty('TOKEN_LIMIT', '4096')
    expect(result).toHaveProperty('TOKEN_COUNT', '100')
    expect(result).toHaveProperty('TOKENS_PER_MIN', '60')
  })

  it('should filter PRIVATE_KEY and DATABASE_URL by default', () => {
    const result = filterSensitiveEnvVars(baseEnv)
    expect(result).not.toHaveProperty('PRIVATE_KEY')
    expect(result).not.toHaveProperty('DATABASE_URL')
  })

  it('should keep safe vars like PATH, HOME, NODE_ENV', () => {
    const result = filterSensitiveEnvVars(baseEnv)
    expect(result).toHaveProperty('PATH', '/usr/bin')
    expect(result).toHaveProperty('HOME', '/home/user')
    expect(result).toHaveProperty('NODE_ENV', 'production')
  })

  it('should allow vars in allowedVars list even if they match a blocked pattern', () => {
    const result = filterSensitiveEnvVars(baseEnv, {
      allowedVars: ['AUTH_TOKEN', 'DATABASE_URL'],
    })
    expect(result).toHaveProperty('AUTH_TOKEN', 'tok_abc')
    expect(result).toHaveProperty('DATABASE_URL', 'postgres://localhost/db')
    // Other sensitive vars are still filtered
    expect(result).not.toHaveProperty('MY_SECRET')
    expect(result).not.toHaveProperty('DB_PASSWORD')
  })

  it('should pass all vars when disableFilter is true', () => {
    const result = filterSensitiveEnvVars(baseEnv, { disableFilter: true })
    expect(Object.keys(result).sort()).toEqual(Object.keys(baseEnv).sort())
    expect(result).toHaveProperty('MY_SECRET', 'hidden')
    expect(result).toHaveProperty('DB_PASSWORD', 'pass123')
  })

  it('should apply custom blockedPatterns in addition to defaults', () => {
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      CUSTOM_CREDENTIAL: 'cred123',
      MY_SECRET: 'hidden',
    }
    const result = filterSensitiveEnvVars(env, {
      blockedPatterns: [/CREDENTIAL/i],
    })
    expect(result).not.toHaveProperty('CUSTOM_CREDENTIAL')
    expect(result).not.toHaveProperty('MY_SECRET')
    expect(result).toHaveProperty('PATH', '/usr/bin')
  })

  it('should not mutate the input env object', () => {
    const env: Record<string, string> = {
      MY_SECRET: 'hidden',
      PATH: '/usr/bin',
    }
    const original = { ...env }
    filterSensitiveEnvVars(env)
    expect(env).toEqual(original)
  })
})
