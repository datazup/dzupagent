/**
 * Tests for the marketplace store and MarketplaceView.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { useMarketplaceStore } from '../stores/marketplace-store.js'
import type { MarketplaceAgent } from '../types.js'

// ── Mock data ────────────────────────────────────────

function createMockAgents(): MarketplaceAgent[] {
  return [
    {
      id: 'plugin-otel',
      name: '@forge/otel-tracer',
      description: 'OpenTelemetry tracing for ForgeAgent runs',
      version: '1.2.0',
      author: 'ForgeTeam',
      category: 'observability',
      tags: ['tracing', 'opentelemetry', 'spans'],
      installed: false,
      verified: true,
      downloadCount: 12450,
      rating: 4.5,
    },
    {
      id: 'plugin-redis',
      name: '@forge/redis-memory',
      description: 'Redis-backed memory store with TTL support',
      version: '2.0.0',
      author: 'CacheWorks',
      category: 'memory',
      tags: ['redis', 'cache', 'memory'],
      installed: true,
      verified: true,
      downloadCount: 15780,
      rating: 4.8,
    },
    {
      id: 'plugin-codegen',
      name: '@forge/ts-codegen',
      description: 'TypeScript code generation with AST manipulation',
      version: '3.1.0',
      author: 'CodeSmith',
      category: 'codegen',
      tags: ['typescript', 'codegen', 'ast'],
      installed: false,
      verified: false,
      downloadCount: 21300,
    },
  ]
}

// ── Mock API ─────────────────────────────────────────

const getMock = vi.fn(async () => ({
  data: createMockAgents(),
}))

const postMock = vi.fn(async () => ({
  data: { installed: true },
}))

const delMock = vi.fn(async () => ({
  data: { uninstalled: true },
}))

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: getMock,
    post: postMock,
    patch: vi.fn(),
    del: delMock,
    buildUrl: vi.fn((p: string) => p),
  }),
}))

// ── Store tests ──────────────────────────────────────

describe('marketplace-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockClear()
    postMock.mockClear()
    delMock.mockClear()
  })

  it('starts with empty state', () => {
    const store = useMarketplaceStore()
    expect(store.agents).toEqual([])
    expect(store.isLoading).toBe(false)
    expect(store.error).toBeNull()
    expect(store.searchQuery).toBe('')
    expect(store.selectedCategory).toBeNull()
  })

  it('fetchAgents loads agents from the API', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()

    expect(getMock).toHaveBeenCalledWith('/api/marketplace/agents')
    expect(store.agents).toHaveLength(3)
    expect(store.agents[0]!.name).toBe('@forge/otel-tracer')
    expect(store.isLoading).toBe(false)
  })

  it('fetchAgents handles errors gracefully', async () => {
    getMock.mockRejectedValueOnce(new Error('Network error'))
    const store = useMarketplaceStore()
    await store.fetchAgents()

    expect(store.error).toBe('Network error')
    expect(store.agents).toEqual([])
    expect(store.isLoading).toBe(false)
  })

  it('filteredAgents filters by search query on name', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()

    store.setSearchQuery('otel')
    expect(store.filteredAgents).toHaveLength(1)
    expect(store.filteredAgents[0]!.id).toBe('plugin-otel')
  })

  it('filteredAgents filters by search query on description', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()

    store.setSearchQuery('redis')
    expect(store.filteredAgents).toHaveLength(1)
    expect(store.filteredAgents[0]!.id).toBe('plugin-redis')
  })

  it('filteredAgents filters by search query on tags', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()

    store.setSearchQuery('ast')
    expect(store.filteredAgents).toHaveLength(1)
    expect(store.filteredAgents[0]!.id).toBe('plugin-codegen')
  })

  it('filteredAgents filters by category', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()

    store.setCategory('memory')
    expect(store.filteredAgents).toHaveLength(1)
    expect(store.filteredAgents[0]!.category).toBe('memory')
  })

  it('filteredAgents applies both category and search filters', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()

    store.setCategory('observability')
    store.setSearchQuery('tracing')
    expect(store.filteredAgents).toHaveLength(1)

    // Search that does not match within the category
    store.setSearchQuery('redis')
    expect(store.filteredAgents).toHaveLength(0)
  })

  it('filteredAgents returns all when no filters applied', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()
    expect(store.filteredAgents).toHaveLength(3)
  })

  it('setCategory(null) clears the category filter', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()

    store.setCategory('codegen')
    expect(store.filteredAgents).toHaveLength(1)

    store.setCategory(null)
    expect(store.filteredAgents).toHaveLength(3)
  })

  it('installedCount returns the count of installed agents', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()
    expect(store.installedCount).toBe(1) // only redis-memory is installed
  })

  it('installAgent calls the API and updates local state', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()

    const result = await store.installAgent('plugin-otel')
    expect(result).toBe(true)
    expect(postMock).toHaveBeenCalledWith('/api/marketplace/install', { agentId: 'plugin-otel' })
    expect(store.agents.find((a) => a.id === 'plugin-otel')!.installed).toBe(true)
  })

  it('installAgent handles API errors', async () => {
    postMock.mockRejectedValueOnce(new Error('Install failed'))
    const store = useMarketplaceStore()
    await store.fetchAgents()

    const result = await store.installAgent('plugin-otel')
    expect(result).toBe(false)
    expect(store.error).toBe('Install failed')
  })

  it('uninstallAgent calls the API and updates local state', async () => {
    const store = useMarketplaceStore()
    await store.fetchAgents()

    const result = await store.uninstallAgent('plugin-redis')
    expect(result).toBe(true)
    expect(delMock).toHaveBeenCalledWith('/api/marketplace/plugin-redis')
    expect(store.agents.find((a) => a.id === 'plugin-redis')!.installed).toBe(false)
  })

  it('uninstallAgent handles API errors', async () => {
    delMock.mockRejectedValueOnce(new Error('Uninstall failed'))
    const store = useMarketplaceStore()
    await store.fetchAgents()

    const result = await store.uninstallAgent('plugin-redis')
    expect(result).toBe(false)
    expect(store.error).toBe('Uninstall failed')
  })

  it('clearError resets the error state', async () => {
    getMock.mockRejectedValueOnce(new Error('Something went wrong'))
    const store = useMarketplaceStore()
    await store.fetchAgents()

    expect(store.error).toBe('Something went wrong')
    store.clearError()
    expect(store.error).toBeNull()
  })
})

// ── AgentCard component tests ────────────────────────

// Use a minimal stub since we cannot import .vue in unit test easily
// Instead, test the MarketplaceView rendering via mount with stubs.
describe('MarketplaceView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockClear()
    postMock.mockClear()
    delMock.mockClear()
    getMock.mockResolvedValue({ data: createMockAgents() })
  })

  async function mountView() {
    // Dynamically import to ensure mocks are in place
    const { default: MarketplaceView } = await import('../views/MarketplaceView.vue')
    const wrapper = mount(MarketplaceView, {
      global: {
        stubs: {
          AgentCard: {
            template: `<div :data-testid="'agent-card-' + agent.id" class="agent-card">
              <span class="agent-name">{{ agent.name }}</span>
              <button class="install-btn" @click="$emit('install', agent.id)">Install</button>
              <button class="uninstall-btn" @click="$emit('uninstall', agent.id)">Uninstall</button>
            </div>`,
            props: ['agent', 'actionLoading'],
            emits: ['install', 'uninstall'],
          },
        },
      },
    })
    await flushPromises()
    return wrapper
  }

  it('renders agent cards from the store', async () => {
    const wrapper = await mountView()
    const cards = wrapper.findAll('.agent-card')
    expect(cards).toHaveLength(3)
  })

  it('displays the correct agent names', async () => {
    const wrapper = await mountView()
    const names = wrapper.findAll('.agent-name').map((el) => el.text())
    expect(names).toContain('@forge/otel-tracer')
    expect(names).toContain('@forge/redis-memory')
    expect(names).toContain('@forge/ts-codegen')
  })

  it('search filters agents by name/description', async () => {
    const wrapper = await mountView()

    const input = wrapper.find('input[aria-label="Search marketplace plugins"]')
    await input.setValue('redis')
    await flushPromises()

    const cards = wrapper.findAll('.agent-card')
    expect(cards).toHaveLength(1)
  })

  it('category filter works', async () => {
    const wrapper = await mountView()

    // Click the "codegen" category tab
    const buttons = wrapper.findAll('button')
    const codegenBtn = buttons.find((b) => b.text().toLowerCase() === 'codegen')
    expect(codegenBtn).toBeDefined()
    await codegenBtn!.trigger('click')
    await flushPromises()

    const cards = wrapper.findAll('.agent-card')
    expect(cards).toHaveLength(1)
  })

  it('install button calls store action', async () => {
    const wrapper = await mountView()

    const firstInstallBtn = wrapper.find('[data-testid="agent-card-plugin-otel"] .install-btn')
    await firstInstallBtn.trigger('click')
    await flushPromises()

    expect(postMock).toHaveBeenCalledWith('/api/marketplace/install', { agentId: 'plugin-otel' })
  })

  it('shows loading skeleton state', async () => {
    getMock.mockImplementation(() => new Promise(() => {
      // Never resolves -- stays in loading
    }))

    const { default: MarketplaceView } = await import('../views/MarketplaceView.vue')
    const wrapper = mount(MarketplaceView, {
      global: { stubs: { AgentCard: true } },
    })

    // Wait for Vue to process the reactive update from onMounted
    await flushPromises()
    await wrapper.vm.$nextTick()

    // The store should be loading, showing skeleton cards
    const store = useMarketplaceStore()
    expect(store.isLoading).toBe(true)

    const skeletons = wrapper.findAll('[data-testid="skeleton-card"]')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('shows error banner when store has error', async () => {
    getMock.mockRejectedValueOnce(new Error('Server unavailable'))
    const wrapper = await mountView()

    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('Server unavailable')
  })

  it('dismiss button clears error', async () => {
    getMock.mockRejectedValueOnce(new Error('Server error'))
    const wrapper = await mountView()

    const dismissBtn = wrapper.find('[role="alert"] button')
    expect(dismissBtn.exists()).toBe(true)
    await dismissBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('shows empty state when no agents match', async () => {
    const wrapper = await mountView()

    const input = wrapper.find('input[aria-label="Search marketplace plugins"]')
    await input.setValue('nonexistent-plugin-xyz')
    await flushPromises()

    expect(wrapper.text()).toContain('No agents found')
  })

  it('"All" category tab shows all agents', async () => {
    const wrapper = await mountView()

    // First filter to codegen
    const buttons = wrapper.findAll('button')
    const codegenBtn = buttons.find((b) => b.text().toLowerCase() === 'codegen')
    await codegenBtn!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.agent-card')).toHaveLength(1)

    // Then click "All"
    const allBtn = buttons.find((b) => b.text() === 'All')
    await allBtn!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.agent-card')).toHaveLength(3)
  })
})
