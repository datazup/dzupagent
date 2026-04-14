import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryMcpAdapterManager } from '../mcp/mcp-adapter-manager.js'
import type { AdapterMcpServer } from '../mcp/mcp-adapter-types.js'

function makeServer(id: string, overrides?: Partial<AdapterMcpServer>) {
  return {
    id,
    transport: 'http' as const,
    endpoint: `http://localhost:3000/${id}`,
    ...overrides,
  }
}

describe('InMemoryMcpAdapterManager', () => {
  let manager: InMemoryMcpAdapterManager

  beforeEach(() => {
    manager = new InMemoryMcpAdapterManager()
  })

  // ---------------------------------------------------------------------------
  // addServer
  // ---------------------------------------------------------------------------
  describe('addServer', () => {
    it('creates a server with defaults', async () => {
      const server = await manager.addServer(makeServer('s1'))
      expect(server.id).toBe('s1')
      expect(server.enabled).toBe(false)
      expect(server.createdAt).toBeTruthy()
      expect(server.updatedAt).toBe(server.createdAt)
    })

    it('respects explicit enabled=true', async () => {
      const server = await manager.addServer(makeServer('s1', { enabled: true }))
      expect(server.enabled).toBe(true)
    })

    it('throws on duplicate id', async () => {
      await manager.addServer(makeServer('s1'))
      await expect(manager.addServer(makeServer('s1'))).rejects.toThrow(/already exists/)
    })
  })

  // ---------------------------------------------------------------------------
  // removeServer
  // ---------------------------------------------------------------------------
  describe('removeServer', () => {
    it('removes an existing server', async () => {
      await manager.addServer(makeServer('s1'))
      const removed = await manager.removeServer('s1')
      expect(removed).toBe(true)

      const list = await manager.listServers()
      expect(list).toHaveLength(0)
    })

    it('returns false for non-existent server', async () => {
      expect(await manager.removeServer('nope')).toBe(false)
    })

    it('blocks removal when active enabled bindings exist', async () => {
      await manager.addServer(makeServer('s1'))
      await manager.bindServer({
        id: 'b1',
        providerId: 'claude',
        serverId: 's1',
        enabled: true,
        mode: 'native',
      })

      await expect(manager.removeServer('s1')).rejects.toThrow(/active binding/)
    })

    it('allows forced removal despite active bindings', async () => {
      await manager.addServer(makeServer('s1'))
      await manager.bindServer({
        id: 'b1',
        providerId: 'claude',
        serverId: 's1',
        enabled: true,
        mode: 'native',
      })

      const removed = await manager.removeServer('s1', true)
      expect(removed).toBe(true)

      // Bindings should also be cleaned up
      const bindings = await manager.listBindings()
      expect(bindings).toHaveLength(0)
    })

    it('allows removal when bindings are disabled', async () => {
      await manager.addServer(makeServer('s1'))
      await manager.bindServer({
        id: 'b1',
        providerId: 'claude',
        serverId: 's1',
        enabled: false,
        mode: 'native',
      })

      const removed = await manager.removeServer('s1')
      expect(removed).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // enableServer / disableServer
  // ---------------------------------------------------------------------------
  describe('enableServer / disableServer', () => {
    it('toggles enabled flag', async () => {
      await manager.addServer(makeServer('s1'))

      expect(await manager.enableServer('s1')).toBe(true)
      const enabled = await manager.getServer('s1')
      expect(enabled?.enabled).toBe(true)

      expect(await manager.disableServer('s1')).toBe(true)
      const disabled = await manager.getServer('s1')
      expect(disabled?.enabled).toBe(false)
    })

    it('returns false for non-existent server', async () => {
      expect(await manager.enableServer('nope')).toBe(false)
      expect(await manager.disableServer('nope')).toBe(false)
    })

    it('updates the updatedAt timestamp', async () => {
      const server = await manager.addServer(makeServer('s1'))
      const originalUpdatedAt = server.updatedAt

      // Small delay to ensure timestamp differs
      await new Promise(r => setTimeout(r, 5))
      await manager.enableServer('s1')

      const updated = await manager.getServer('s1')
      expect(updated?.updatedAt).not.toBe(originalUpdatedAt)
    })
  })

  // ---------------------------------------------------------------------------
  // updateServer
  // ---------------------------------------------------------------------------
  describe('updateServer', () => {
    it('patches fields and updates timestamp', async () => {
      await manager.addServer(makeServer('s1'))
      const updated = await manager.updateServer('s1', {
        endpoint: 'http://new-url',
        tags: ['production'],
      })
      expect(updated?.endpoint).toBe('http://new-url')
      expect(updated?.tags).toEqual(['production'])
    })

    it('returns undefined for non-existent server', async () => {
      expect(await manager.updateServer('nope', { tags: [] })).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // bindServer / unbindServer
  // ---------------------------------------------------------------------------
  describe('bindServer / unbindServer', () => {
    it('creates a binding with timestamps', async () => {
      await manager.addServer(makeServer('s1'))
      const binding = await manager.bindServer({
        id: 'b1',
        providerId: 'claude',
        serverId: 's1',
        enabled: true,
        mode: 'native',
      })
      expect(binding.id).toBe('b1')
      expect(binding.createdAt).toBeTruthy()
    })

    it('throws when server does not exist', async () => {
      await expect(
        manager.bindServer({
          id: 'b1',
          providerId: 'claude',
          serverId: 'nonexistent',
          enabled: true,
          mode: 'native',
        }),
      ).rejects.toThrow(/does not exist/)
    })

    it('throws on duplicate binding id', async () => {
      await manager.addServer(makeServer('s1'))
      await manager.bindServer({
        id: 'b1',
        providerId: 'claude',
        serverId: 's1',
        enabled: true,
        mode: 'native',
      })
      await expect(
        manager.bindServer({
          id: 'b1',
          providerId: 'codex',
          serverId: 's1',
          enabled: true,
          mode: 'tool-bridge',
        }),
      ).rejects.toThrow(/already exists/)
    })

    it('unbinds by id', async () => {
      await manager.addServer(makeServer('s1'))
      await manager.bindServer({
        id: 'b1',
        providerId: 'claude',
        serverId: 's1',
        enabled: true,
        mode: 'native',
      })
      expect(await manager.unbindServer('b1')).toBe(true)
      expect(await manager.unbindServer('b1')).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // enableBinding / disableBinding
  // ---------------------------------------------------------------------------
  describe('enableBinding / disableBinding', () => {
    it('toggles binding enabled flag', async () => {
      await manager.addServer(makeServer('s1'))
      await manager.bindServer({
        id: 'b1',
        providerId: 'claude',
        serverId: 's1',
        enabled: false,
        mode: 'native',
      })

      expect(await manager.enableBinding('b1')).toBe(true)
      const bindings = await manager.listBindings()
      expect(bindings[0]?.enabled).toBe(true)

      expect(await manager.disableBinding('b1')).toBe(true)
      const bindings2 = await manager.listBindings()
      expect(bindings2[0]?.enabled).toBe(false)
    })

    it('returns false for non-existent binding', async () => {
      expect(await manager.enableBinding('nope')).toBe(false)
      expect(await manager.disableBinding('nope')).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // listBindings
  // ---------------------------------------------------------------------------
  describe('listBindings', () => {
    it('filters by providerId', async () => {
      await manager.addServer(makeServer('s1'))
      await manager.bindServer({
        id: 'b1',
        providerId: 'claude',
        serverId: 's1',
        enabled: true,
        mode: 'native',
      })
      await manager.bindServer({
        id: 'b2',
        providerId: 'codex',
        serverId: 's1',
        enabled: true,
        mode: 'tool-bridge',
      })
      await manager.bindServer({
        id: 'b3',
        providerId: 'claude',
        serverId: 's1',
        enabled: false,
        mode: 'prompt-injection',
      })

      const claude = await manager.listBindings('claude')
      expect(claude).toHaveLength(2)
      expect(claude.map(b => b.id).sort()).toEqual(['b1', 'b3'])

      const codex = await manager.listBindings('codex')
      expect(codex).toHaveLength(1)

      const all = await manager.listBindings()
      expect(all).toHaveLength(3)
    })
  })

  // ---------------------------------------------------------------------------
  // getEffectiveConfig
  // ---------------------------------------------------------------------------
  describe('getEffectiveConfig', () => {
    it('only includes enabled servers with enabled bindings', async () => {
      // s1: enabled server, enabled binding -> included
      await manager.addServer(makeServer('s1'))
      await manager.enableServer('s1')
      await manager.bindServer({
        id: 'b1',
        providerId: 'claude',
        serverId: 's1',
        enabled: true,
        mode: 'native',
      })

      // s2: disabled server, enabled binding -> excluded
      await manager.addServer(makeServer('s2'))
      // s2 stays disabled (default)
      await manager.bindServer({
        id: 'b2',
        providerId: 'claude',
        serverId: 's2',
        enabled: true,
        mode: 'tool-bridge',
      })

      // s3: enabled server, disabled binding -> excluded
      await manager.addServer(makeServer('s3'))
      await manager.enableServer('s3')
      await manager.bindServer({
        id: 'b3',
        providerId: 'claude',
        serverId: 's3',
        enabled: false,
        mode: 'native',
      })

      // s4: enabled server, enabled binding but different provider -> excluded
      await manager.addServer(makeServer('s4'))
      await manager.enableServer('s4')
      await manager.bindServer({
        id: 'b4',
        providerId: 'codex',
        serverId: 's4',
        enabled: true,
        mode: 'tool-bridge',
      })

      const config = await manager.getEffectiveConfig('claude')
      expect(config.servers).toHaveLength(1)
      expect(config.servers[0]?.server.id).toBe('s1')
      expect(config.servers[0]?.binding.id).toBe('b1')
    })

    it('returns empty config when no bindings match', async () => {
      const config = await manager.getEffectiveConfig('gemini')
      expect(config.servers).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // testServer (basic - MCPClient not available in test environment)
  // ---------------------------------------------------------------------------
  describe('testServer', () => {
    it('returns error for non-existent server', async () => {
      const result = await manager.testServer('nope')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not found/)
    })
  })
})
