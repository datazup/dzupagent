import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryMcpManager } from '../mcp/mcp-manager.js'
import { createEventBus } from '../events/event-bus.js'
import type { DzupEventBus } from '../events/event-bus.js'
import type { DzupEvent } from '../events/event-types.js'
import type { McpServerInput } from '../mcp/mcp-registry-types.js'
import type { MCPClient } from '../mcp/mcp-client.js'

function makeInput(overrides?: Partial<McpServerInput>): McpServerInput {
  return {
    id: 'test-server',
    transport: 'http',
    endpoint: 'http://localhost:3000',
    enabled: true,
    ...overrides,
  }
}

describe('InMemoryMcpManager', () => {
  let bus: DzupEventBus
  let events: DzupEvent[]
  let manager: InMemoryMcpManager

  beforeEach(() => {
    bus = createEventBus()
    events = []
    bus.onAny((e) => { events.push(e) })
    manager = new InMemoryMcpManager({ eventBus: bus })
  })

  // -----------------------------------------------------------------------
  // addServer
  // -----------------------------------------------------------------------

  describe('addServer', () => {
    it('creates a server definition with timestamps', async () => {
      const result = await manager.addServer(makeInput())
      expect(result.id).toBe('test-server')
      expect(result.createdAt).toBeTruthy()
      expect(result.updatedAt).toBeTruthy()
      expect(result.enabled).toBe(true)
    })

    it('emits mcp:server_added event', async () => {
      await manager.addServer(makeInput())
      const evt = events.find(e => e.type === 'mcp:server_added')
      expect(evt).toBeDefined()
      if (evt?.type === 'mcp:server_added') {
        expect(evt.serverId).toBe('test-server')
        expect(evt.transport).toBe('http')
      }
    })

    it('rejects duplicate server id', async () => {
      await manager.addServer(makeInput())
      await expect(manager.addServer(makeInput())).rejects.toThrow('already exists')
    })
  })

  // -----------------------------------------------------------------------
  // listServers / getServer
  // -----------------------------------------------------------------------

  describe('listServers / getServer', () => {
    it('lists all servers', async () => {
      await manager.addServer(makeInput({ id: 'a' }))
      await manager.addServer(makeInput({ id: 'b' }))
      const list = await manager.listServers()
      expect(list).toHaveLength(2)
    })

    it('returns undefined for nonexistent server', async () => {
      const s = await manager.getServer('nope')
      expect(s).toBeUndefined()
    })

    it('returns a copy (not the internal reference)', async () => {
      await manager.addServer(makeInput())
      const a = await manager.getServer('test-server')
      const b = await manager.getServer('test-server')
      expect(a).toEqual(b)
      expect(a).not.toBe(b)
    })
  })

  // -----------------------------------------------------------------------
  // updateServer
  // -----------------------------------------------------------------------

  describe('updateServer', () => {
    it('patches fields and updates timestamp', async () => {
      const original = await manager.addServer(makeInput())
      const updated = await manager.updateServer('test-server', { name: 'renamed' })
      expect(updated.name).toBe('renamed')
      expect(updated.createdAt).toBe(original.createdAt)
      expect(updated.id).toBe(original.id)
    })

    it('emits mcp:server_updated event', async () => {
      await manager.addServer(makeInput())
      await manager.updateServer('test-server', { name: 'renamed', timeoutMs: 5000 })
      const evt = events.find(e => e.type === 'mcp:server_updated')
      expect(evt).toBeDefined()
      if (evt?.type === 'mcp:server_updated') {
        expect(evt.fields).toContain('name')
        expect(evt.fields).toContain('timeoutMs')
      }
    })

    it('throws for nonexistent server', async () => {
      await expect(manager.updateServer('nope', { name: 'x' })).rejects.toThrow('not found')
    })
  })

  // -----------------------------------------------------------------------
  // removeServer
  // -----------------------------------------------------------------------

  describe('removeServer', () => {
    it('removes the server and emits event', async () => {
      await manager.addServer(makeInput())
      await manager.removeServer('test-server')
      const s = await manager.getServer('test-server')
      expect(s).toBeUndefined()
      expect(events.some(e => e.type === 'mcp:server_removed')).toBe(true)
    })

    it('does not emit event for nonexistent server', async () => {
      await manager.removeServer('nope')
      expect(events.filter(e => e.type === 'mcp:server_removed')).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // enableServer / disableServer
  // -----------------------------------------------------------------------

  describe('enableServer / disableServer', () => {
    it('enables a disabled server', async () => {
      await manager.addServer(makeInput({ enabled: false }))
      const result = await manager.enableServer('test-server')
      expect(result.enabled).toBe(true)
      expect(events.some(e => e.type === 'mcp:server_enabled')).toBe(true)
    })

    it('disables an enabled server', async () => {
      await manager.addServer(makeInput({ enabled: true }))
      const result = await manager.disableServer('test-server')
      expect(result.enabled).toBe(false)
      expect(events.some(e => e.type === 'mcp:server_disabled')).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // testServer
  // -----------------------------------------------------------------------

  describe('testServer', () => {
    it('returns error when no MCPClient configured', async () => {
      await manager.addServer(makeInput())
      const result = await manager.testServer('test-server')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('No MCPClient')
    })

    it('returns error for nonexistent server', async () => {
      const result = await manager.testServer('nope')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('emits mcp:test_passed on successful connection', async () => {
      const mockClient = {
        addServer: vi.fn(),
        connect: vi.fn().mockResolvedValue(true),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue([
          { id: 'test-server', toolCount: 5 },
        ]),
      } as unknown as MCPClient

      const mgr = new InMemoryMcpManager({ eventBus: bus, mcpClient: mockClient })
      await mgr.addServer(makeInput())

      const result = await mgr.testServer('test-server')
      expect(result.ok).toBe(true)
      expect(result.toolCount).toBe(5)

      const evt = events.find(e => e.type === 'mcp:test_passed')
      expect(evt).toBeDefined()
    })

    it('emits mcp:test_failed on connection failure', async () => {
      const mockClient = {
        addServer: vi.fn(),
        connect: vi.fn().mockResolvedValue(false),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue([
          { id: 'test-server', lastError: 'timeout' },
        ]),
      } as unknown as MCPClient

      const mgr = new InMemoryMcpManager({ eventBus: bus, mcpClient: mockClient })
      await mgr.addServer(makeInput())

      const result = await mgr.testServer('test-server')
      expect(result.ok).toBe(false)
      expect(result.error).toBe('timeout')

      const evt = events.find(e => e.type === 'mcp:test_failed')
      expect(evt).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // Profile management
  // -----------------------------------------------------------------------

  describe('profiles', () => {
    it('adds and retrieves a profile', async () => {
      const profile = { id: 'p1', serverIds: ['s1', 's2'], enabled: true }
      await manager.addProfile(profile)
      const found = await manager.getProfile('p1')
      expect(found).toEqual(profile)
    })

    it('lists profiles', async () => {
      await manager.addProfile({ id: 'p1', serverIds: ['s1'], enabled: true })
      await manager.addProfile({ id: 'p2', serverIds: ['s2'], enabled: false })
      const list = await manager.listProfiles()
      expect(list).toHaveLength(2)
    })

    it('removes a profile', async () => {
      await manager.addProfile({ id: 'p1', serverIds: ['s1'], enabled: true })
      await manager.removeProfile('p1')
      const found = await manager.getProfile('p1')
      expect(found).toBeUndefined()
    })

    it('rejects duplicate profile id', async () => {
      await manager.addProfile({ id: 'p1', serverIds: [], enabled: true })
      await expect(
        manager.addProfile({ id: 'p1', serverIds: [], enabled: true }),
      ).rejects.toThrow('already exists')
    })
  })

  // -----------------------------------------------------------------------
  // Event bus optional
  // -----------------------------------------------------------------------

  describe('without event bus', () => {
    it('works without event bus', async () => {
      const mgr = new InMemoryMcpManager()
      await mgr.addServer(makeInput())
      const list = await mgr.listServers()
      expect(list).toHaveLength(1)
    })
  })
})
