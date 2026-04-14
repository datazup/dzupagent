import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { readFile } from 'node:fs/promises'
import {
  loadEnvConfig,
  loadFileConfig,
  mergeConfigs,
  resolveConfig,
  DEFAULT_CONFIG,
} from '../config/config-loader.js'
import type { ConfigLayer } from '../config/config-loader.js'

const mockedReadFile = vi.mocked(readFile)

describe('Config Loader', () => {
  // -----------------------------------------------------------------------
  // loadEnvConfig
  // -----------------------------------------------------------------------
  describe('loadEnvConfig', () => {
    const DZIP_KEYS = [
      'DZIP_PROVIDERS',
      'DZIP_MODEL_CHAT',
      'DZIP_MODEL_CODEGEN',
      'DZIP_MODEL_REASONING',
      'DZIP_MEMORY_STORE',
      'DZIP_MEMORY_CONN',
      'DZIP_PORT',
      'DZIP_CORS_ORIGINS',
      'DZIP_PLUGINS',
      'DZIP_SECURITY_RISK_CLASSIFICATION',
      'DZIP_SECURITY_SECRETS_SCANNING',
      'DZIP_SECURITY_OUTPUT_SANITIZATION',
    ] as const

    beforeEach(() => {
      for (const key of DZIP_KEYS) {
        delete process.env[key]
      }
    })

    afterEach(() => {
      for (const key of DZIP_KEYS) {
        delete process.env[key]
      }
    })

    it('returns empty object when no DZIP_* vars are set', () => {
      const config = loadEnvConfig()
      expect(config).toEqual({})
    })

    it('parses DZIP_PROVIDERS as JSON array', () => {
      process.env['DZIP_PROVIDERS'] = JSON.stringify([
        { provider: 'openai', apiKey: 'sk-test', priority: 1 },
      ])
      const config = loadEnvConfig()
      expect(config.providers).toEqual([
        { provider: 'openai', apiKey: 'sk-test', priority: 1 },
      ])
    })

    it('ignores invalid JSON in DZIP_PROVIDERS', () => {
      process.env['DZIP_PROVIDERS'] = '{not-json'
      const config = loadEnvConfig()
      expect(config.providers).toBeUndefined()
    })

    it('reads model tier env vars', () => {
      process.env['DZIP_MODEL_CHAT'] = 'gpt-4o'
      const config = loadEnvConfig()
      expect(config.models).toBeDefined()
      expect(config.models!.chat).toBe('gpt-4o')
      // Unset tiers fall back to defaults
      expect(config.models!.codegen).toBe(DEFAULT_CONFIG.models.codegen)
      expect(config.models!.reasoning).toBe(DEFAULT_CONFIG.models.reasoning)
    })

    it('parses numeric port value', () => {
      process.env['DZIP_PORT'] = '8080'
      const config = loadEnvConfig()
      expect(config.server).toBeDefined()
      expect(config.server!.port).toBe(8080)
    })

    it('splits comma-separated CORS origins', () => {
      process.env['DZIP_CORS_ORIGINS'] = 'http://a.com, http://b.com'
      const config = loadEnvConfig()
      expect(config.server!.corsOrigins).toEqual([
        'http://a.com',
        'http://b.com',
      ])
    })

    it('handles boolean security env vars', () => {
      process.env['DZIP_SECURITY_RISK_CLASSIFICATION'] = 'false'
      process.env['DZIP_SECURITY_SECRETS_SCANNING'] = 'true'
      const config = loadEnvConfig()
      expect(config.security!.riskClassification).toBe(false)
      expect(config.security!.secretsScanning).toBe(true)
    })

    it('reads memory store and connection string', () => {
      process.env['DZIP_MEMORY_STORE'] = 'postgres'
      process.env['DZIP_MEMORY_CONN'] = 'postgresql://localhost/test'
      const config = loadEnvConfig()
      expect(config.memory).toEqual({
        store: 'postgres',
        connectionString: 'postgresql://localhost/test',
      })
    })

    it('ignores invalid memory store value', () => {
      process.env['DZIP_MEMORY_STORE'] = 'redis'
      const config = loadEnvConfig()
      expect(config.memory).toBeUndefined()
    })

    it('splits comma-separated plugin paths', () => {
      process.env['DZIP_PLUGINS'] = './a.js, ./b.js'
      const config = loadEnvConfig()
      expect(config.plugins).toEqual(['./a.js', './b.js'])
    })
  })

  // -----------------------------------------------------------------------
  // loadFileConfig
  // -----------------------------------------------------------------------
  describe('loadFileConfig', () => {
    beforeEach(() => {
      mockedReadFile.mockReset()
    })

    it('reads and parses a valid JSON config file', async () => {
      const fileContent = JSON.stringify({ plugins: ['./my-plugin.js'] })
      mockedReadFile.mockResolvedValue(fileContent)

      const config = await loadFileConfig('/path/to/config.json')
      expect(mockedReadFile).toHaveBeenCalledWith('/path/to/config.json', 'utf-8')
      expect(config).toEqual({ plugins: ['./my-plugin.js'] })
    })

    it('returns empty object for missing file', async () => {
      mockedReadFile.mockRejectedValue(new Error('ENOENT'))
      const config = await loadFileConfig('/does/not/exist.json')
      expect(config).toEqual({})
    })

    it('returns empty object for invalid JSON', async () => {
      mockedReadFile.mockResolvedValue('not valid json {{{')
      const config = await loadFileConfig('/bad.json')
      expect(config).toEqual({})
    })

    it('returns empty object for non-object JSON (array)', async () => {
      mockedReadFile.mockResolvedValue('[1,2,3]')
      const config = await loadFileConfig('/array.json')
      expect(config).toEqual({})
    })

    it('returns empty object for non-object JSON (string)', async () => {
      mockedReadFile.mockResolvedValue('"just a string"')
      const config = await loadFileConfig('/string.json')
      expect(config).toEqual({})
    })
  })

  // -----------------------------------------------------------------------
  // mergeConfigs
  // -----------------------------------------------------------------------
  describe('mergeConfigs', () => {
    it('returns defaults when no layers override', () => {
      const result = mergeConfigs({ name: 'defaults', priority: 10, config: {} })
      expect(result).toEqual(DEFAULT_CONFIG)
    })

    it('deep merges nested config fields', () => {
      const layer: ConfigLayer = {
        name: 'override',
        priority: 20,
        config: { security: { riskClassification: false, secretsScanning: true, outputSanitization: true } },
      }
      const result = mergeConfigs(
        { name: 'defaults', priority: 10, config: {} },
        layer,
      )
      expect(result.security.riskClassification).toBe(false)
      // Other defaults remain intact
      expect(result.models).toEqual(DEFAULT_CONFIG.models)
    })

    it('higher priority layer wins over lower', () => {
      const low: ConfigLayer = {
        name: 'file',
        priority: 20,
        config: { server: { port: 4000, corsOrigins: [], rateLimit: DEFAULT_CONFIG.server.rateLimit } },
      }
      const high: ConfigLayer = {
        name: 'env',
        priority: 30,
        config: { server: { port: 9000, corsOrigins: ['*'], rateLimit: DEFAULT_CONFIG.server.rateLimit } },
      }
      const result = mergeConfigs(low, high)
      expect(result.server.port).toBe(9000)
    })

    it('sorts layers by priority regardless of input order', () => {
      const high: ConfigLayer = {
        name: 'env',
        priority: 30,
        config: { plugins: ['env-plugin'] },
      }
      const low: ConfigLayer = {
        name: 'file',
        priority: 20,
        config: { plugins: ['file-plugin'] },
      }
      // Pass high first, but low priority should be applied first
      const result = mergeConfigs(high, low)
      // Arrays replace (not concat), so the last applied (highest priority) wins
      expect(result.plugins).toEqual(['env-plugin'])
    })
  })

  // -----------------------------------------------------------------------
  // resolveConfig
  // -----------------------------------------------------------------------
  describe('resolveConfig', () => {
    beforeEach(() => {
      mockedReadFile.mockReset()
      // Clean env
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('DZIP_')) delete process.env[key]
      }
    })

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('DZIP_')) delete process.env[key]
      }
    })

    it('returns defaults with no env, no file, no overrides', async () => {
      const config = await resolveConfig()
      expect(config).toEqual(DEFAULT_CONFIG)
    })

    it('merges file config', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ plugins: ['from-file'] }))
      const config = await resolveConfig({ configFile: '/test.json' })
      expect(config.plugins).toEqual(['from-file'])
    })

    it('env overrides file config', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ server: { port: 4000, corsOrigins: [], rateLimit: DEFAULT_CONFIG.server.rateLimit } }))
      process.env['DZIP_PORT'] = '5000'
      const config = await resolveConfig({ configFile: '/test.json' })
      expect(config.server.port).toBe(5000)
    })

    it('runtime overrides override env', async () => {
      process.env['DZIP_PORT'] = '5000'
      const config = await resolveConfig({
        runtimeOverrides: {
          server: { port: 7777, corsOrigins: ['*'], rateLimit: DEFAULT_CONFIG.server.rateLimit },
        },
      })
      expect(config.server.port).toBe(7777)
    })
  })
})
