import { describe, it, expect } from 'vitest'
import { validateMcpExecutablePath, sanitizeMcpEnv } from '../mcp/mcp-security.js'

describe('validateMcpExecutablePath', () => {
  it('allows normal paths', () => {
    expect(() => validateMcpExecutablePath('/usr/bin/node')).not.toThrow()
    expect(() => validateMcpExecutablePath('npx')).not.toThrow()
    expect(() => validateMcpExecutablePath('./server.js')).not.toThrow()
  })

  it('blocks empty paths', () => {
    expect(() => validateMcpExecutablePath('')).toThrow()
    expect(() => validateMcpExecutablePath('  ')).toThrow()
  })

  it('blocks shell metacharacters', () => {
    expect(() => validateMcpExecutablePath('cmd; rm -rf /')).toThrow()
    expect(() => validateMcpExecutablePath('cmd | cat /etc/passwd')).toThrow()
    expect(() => validateMcpExecutablePath('$(malicious)')).toThrow()
    expect(() => validateMcpExecutablePath('cmd`whoami`')).toThrow()
  })

  it('blocks directory traversal', () => {
    expect(() => validateMcpExecutablePath('../../../etc/passwd')).toThrow()
    expect(() => validateMcpExecutablePath('/usr/bin/../../../bin/sh')).toThrow()
  })
})

describe('sanitizeMcpEnv', () => {
  it('merges server env into base env', () => {
    const result = sanitizeMcpEnv({ HOME: '/home/user' }, { MY_KEY: 'value' })
    expect(result['MY_KEY']).toBe('value')
    expect(result['HOME']).toBe('/home/user')
  })

  it('blocks LD_PRELOAD', () => {
    const result = sanitizeMcpEnv({}, { LD_PRELOAD: '/evil.so' })
    expect(result['LD_PRELOAD']).toBeUndefined()
  })

  it('blocks NODE_OPTIONS', () => {
    const result = sanitizeMcpEnv({}, { NODE_OPTIONS: '--require /evil.js' })
    expect(result['NODE_OPTIONS']).toBeUndefined()
  })

  it('blocks PATH override', () => {
    const result = sanitizeMcpEnv({ PATH: '/usr/bin' }, { PATH: '/evil/bin' })
    expect(result['PATH']).toBe('/usr/bin')
  })

  it('case-insensitive blocking', () => {
    const result = sanitizeMcpEnv({}, { ld_preload: '/evil.so' })
    expect(result['ld_preload']).toBeUndefined()
  })

  it('allows safe env vars', () => {
    const result = sanitizeMcpEnv({}, {
      API_KEY: 'key123',
      CUSTOM_VAR: 'value',
    })
    expect(result['API_KEY']).toBe('key123')
    expect(result['CUSTOM_VAR']).toBe('value')
  })
})
