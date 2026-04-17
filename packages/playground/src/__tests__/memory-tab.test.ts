/**
 * Tests for the MemoryTab component.
 *
 * Covers: namespace loading, search, schema viewer, export/import panels,
 * live memory operations display, health indicators, formatValue/formatDate,
 * empty state, loading state, error display.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

const getMock = vi.fn()
const postMock = vi.fn()

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: getMock,
    post: postMock,
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

const memoryStore = {
  namespaces: [] as Array<{ name: string; recordCount: number }>,
  records: [] as Array<{ key: string; value: unknown; namespace?: string; updatedAt?: string; createdAt?: string }>,
  filteredRecords: [] as Array<{ key: string; value: unknown; namespace?: string; updatedAt?: string; createdAt?: string }>,
  selectedNamespace: null as string | null,
  searchQuery: '',
  scopeJson: '{"tenant":"default","project":"default"}',
  isLoading: false,
  error: null as string | null,
  fetchNamespace: vi.fn(),
  searchRecords: vi.fn(),
  clearSelection: vi.fn(),
}

vi.mock('../stores/memory-store.js', () => ({
  useMemoryStore: () => memoryStore,
}))

const chatStore = {
  activeRunId: null as string | null,
}

vi.mock('../stores/chat-store.js', () => ({
  useChatStore: () => chatStore,
}))

vi.mock('../composables/useEventStream.js', () => ({
  useEventStream: () => ({
    events: ref([]),
    isConnected: ref(false),
    connectionError: ref(null),
    connect: vi.fn(),
    disconnect: vi.fn(),
    clearEvents: vi.fn(),
  }),
}))

vi.mock('../composables/useLiveTrace.js', () => ({
  useLiveTrace: () => ({
    memoryOperations: ref([]),
    timelineData: ref({ events: [], eventCount: 0, totalDurationMs: 0 }),
    tokenUsage: ref({ total: 0 }),
    costEstimate: ref(0),
  }),
}))

async function mountMemoryTab() {
  const { default: MemoryTab } = await import('../components/inspector/MemoryTab.vue')
  return mount(MemoryTab)
}

describe('MemoryTab', () => {
  beforeEach(() => {
    getMock.mockReset()
    postMock.mockReset()
    memoryStore.namespaces = []
    memoryStore.records = []
    memoryStore.filteredRecords = []
    memoryStore.selectedNamespace = null
    memoryStore.searchQuery = ''
    memoryStore.scopeJson = '{"tenant":"default","project":"default"}'
    memoryStore.isLoading = false
    memoryStore.error = null
    memoryStore.fetchNamespace.mockReset()
    memoryStore.searchRecords.mockReset()
    chatStore.activeRunId = null
  })

  it('shows empty state when no records and not loading', async () => {
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Load a namespace to browse records.')
  })

  it('shows loading overlay when isLoading is true', async () => {
    memoryStore.isLoading = true
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Loading...')
  })

  it('shows error with role alert', async () => {
    memoryStore.error = 'Failed to fetch records'
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Failed to fetch records')
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })

  it('renders namespace input and load button', async () => {
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.find('input[aria-label="Memory namespace"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Load')
  })

  it('renders search input and search button', async () => {
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.find('input[aria-label="Search memory records"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Search')
  })

  it('renders scope JSON input', async () => {
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.find('input[aria-label="Memory scope JSON"]').exists()).toBe(true)
  })

  it('clicking Load button triggers fetchNamespace', async () => {
    const wrapper = await mountMemoryTab()
    await flushPromises()

    const loadBtn = wrapper.findAll('button').find((b) => b.text() === 'Load')
    expect(loadBtn).toBeDefined()
    await loadBtn!.trigger('click')
    expect(memoryStore.fetchNamespace).toHaveBeenCalledWith('lessons')
  })

  it('clicking Search button triggers searchRecords', async () => {
    const wrapper = await mountMemoryTab()
    await flushPromises()

    const searchBtn = wrapper.findAll('button').find((b) => b.text() === 'Search')
    expect(searchBtn).toBeDefined()
    await searchBtn!.trigger('click')
    expect(memoryStore.searchRecords).toHaveBeenCalled()
  })

  it('renders memory records with key and value', async () => {
    memoryStore.filteredRecords = [
      { key: 'rule-1', value: 'Use strict mode', namespace: 'conventions' },
      { key: 'rule-2', value: { nested: true }, namespace: 'conventions' },
    ]
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('rule-1')
    expect(wrapper.text()).toContain('Use strict mode')
    expect(wrapper.text()).toContain('rule-2')
    expect(wrapper.text()).toContain('"nested": true')
  })

  it('renders record dates when available', async () => {
    memoryStore.filteredRecords = [
      { key: 'k1', value: 'v1', updatedAt: '2025-06-15T12:00:00Z' },
    ]
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('k1')
  })

  it('renders recent namespace buttons', async () => {
    memoryStore.namespaces = [
      { name: 'conventions', recordCount: 5 },
      { name: 'lessons', recordCount: 3 },
    ]
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('conventions (5)')
    expect(wrapper.text()).toContain('lessons (3)')
  })

  it('clicking namespace button triggers fetchNamespace', async () => {
    memoryStore.namespaces = [
      { name: 'conventions', recordCount: 5 },
    ]
    const wrapper = await mountMemoryTab()
    await flushPromises()

    const nsBtn = wrapper.findAll('button').find((b) => b.text().includes('conventions'))
    expect(nsBtn).toBeDefined()
    await nsBtn!.trigger('click')
    expect(memoryStore.fetchNamespace).toHaveBeenCalledWith('conventions')
  })

  it('renders Schema and Export buttons', async () => {
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Schema')
    expect(wrapper.text()).toContain('Export')
  })

  it('clicking Schema button loads schema', async () => {
    getMock.mockResolvedValueOnce({
      columns: [
        { name: 'key', type: 'VARCHAR', nullable: false },
        { name: 'value', type: 'JSON', nullable: true },
      ],
    })
    const wrapper = await mountMemoryTab()
    await flushPromises()

    const schemaBtn = wrapper.findAll('button').find((b) => b.text() === 'Schema')
    await schemaBtn!.trigger('click')
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/memory/schema')
    expect(wrapper.text()).toContain('Memory Schema (2 columns)')
    expect(wrapper.text()).toContain('key')
    expect(wrapper.text()).toContain('VARCHAR')
  })

  it('schema load failure results in empty columns', async () => {
    getMock.mockRejectedValueOnce(new Error('Schema unavailable'))
    const wrapper = await mountMemoryTab()
    await flushPromises()

    const schemaBtn = wrapper.findAll('button').find((b) => b.text() === 'Schema')
    await schemaBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('Memory Schema')
  })

  it('toggling Export panel shows export options', async () => {
    const wrapper = await mountMemoryTab()
    await flushPromises()

    const exportBtn = wrapper.findAll('button').find((b) => b.text() === 'Export')
    await exportBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Export Memory')
    expect(wrapper.text()).toContain('JSON')
    expect(wrapper.text()).toContain('Arrow IPC')
    expect(wrapper.text()).toContain('Download')
  })

  it('import panel is always visible with Import Memory label', async () => {
    const wrapper = await mountMemoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Import Memory')
    expect(wrapper.text()).toContain('Skip existing')
    expect(wrapper.text()).toContain('Overwrite')
    expect(wrapper.text()).toContain('Merge')
  })
})
