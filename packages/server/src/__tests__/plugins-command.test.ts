import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listPlugins, addPlugin, removePlugin } from '../cli/plugins-command.js'

describe('Plugin Commands', () => {
  let tempDir: string
  let configPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-plugins-'))
    configPath = join(tempDir, 'dzupagent.config.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  async function writeTestConfig(config: Record<string, unknown>): Promise<void> {
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  describe('listPlugins', () => {
    it('returns empty array when no plugins configured', async () => {
      await writeTestConfig({ name: 'test-project' })
      const result = listPlugins(configPath)
      expect(result).toEqual([])
    })

    it('returns plugin info for each registered plugin', async () => {
      await writeTestConfig({
        name: 'test-project',
        plugins: [
          { name: '@dzupagent/otel', version: '0.1.0' },
          { name: '@dzupagent/evals', version: '0.2.0' },
        ],
      })

      const result = listPlugins(configPath)
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        name: '@dzupagent/otel',
        version: '0.1.0',
        status: 'active',
        manifestValid: true,
      })
      expect(result[1]?.name).toBe('@dzupagent/evals')
    })

    it('throws if config file does not exist', () => {
      expect(() => listPlugins('/nonexistent/path.json')).toThrow('Config file not found')
    })
  })

  describe('addPlugin', () => {
    it('adds a plugin to the config', async () => {
      await writeTestConfig({ name: 'test-project', plugins: [] })

      const result = addPlugin('@dzupagent/memory', configPath)
      expect(result.success).toBe(true)

      const plugins = listPlugins(configPath)
      expect(plugins).toHaveLength(1)
      expect(plugins[0]?.name).toBe('@dzupagent/memory')
    })

    it('creates plugins array if not present', async () => {
      await writeTestConfig({ name: 'test-project' })

      const result = addPlugin('@dzupagent/otel', configPath)
      expect(result.success).toBe(true)

      const plugins = listPlugins(configPath)
      expect(plugins).toHaveLength(1)
    })

    it('rejects duplicate plugin names', async () => {
      await writeTestConfig({
        name: 'test-project',
        plugins: [{ name: '@dzupagent/otel', version: '0.1.0' }],
      })

      const result = addPlugin('@dzupagent/otel', configPath)
      expect(result.success).toBe(false)
      expect(result.error).toContain('already registered')
    })

    it('rejects empty plugin name', async () => {
      await writeTestConfig({ name: 'test-project', plugins: [] })

      const result = addPlugin('', configPath)
      expect(result.success).toBe(false)
      expect(result.error).toContain('non-empty string')
    })

    it('returns error for missing config file', () => {
      const result = addPlugin('@dzupagent/x', '/nonexistent/path.json')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Config file not found')
    })
  })

  describe('removePlugin', () => {
    it('removes an existing plugin', async () => {
      await writeTestConfig({
        name: 'test-project',
        plugins: [
          { name: '@dzupagent/otel', version: '0.1.0' },
          { name: '@dzupagent/evals', version: '0.2.0' },
        ],
      })

      const result = removePlugin('@dzupagent/otel', configPath)
      expect(result.success).toBe(true)

      const plugins = listPlugins(configPath)
      expect(plugins).toHaveLength(1)
      expect(plugins[0]?.name).toBe('@dzupagent/evals')
    })

    it('returns error when plugin not found', async () => {
      await writeTestConfig({ name: 'test-project', plugins: [] })

      const result = removePlugin('@dzupagent/nonexistent', configPath)
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('returns error for missing config file', () => {
      const result = removePlugin('@dzupagent/x', '/nonexistent/path.json')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Config file not found')
    })
  })
})
