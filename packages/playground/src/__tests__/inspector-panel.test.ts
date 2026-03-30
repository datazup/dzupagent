/**
 * Tests for the InspectorPanel component.
 *
 * Verifies tab rendering, tab switching, ARIA attributes,
 * and correct panel visibility.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'

// Mock all stores used by child components
vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

// Mock vue-router for HistoryTab
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}))

async function mountInspectorPanel() {
  const { default: InspectorPanel } = await import('../components/inspector/InspectorPanel.vue')
  return mount(InspectorPanel)
}

function getInspectorTabs(wrapper: ReturnType<typeof mount>) {
  const tablist = wrapper.find('[aria-label="Inspector tabs"]')
  return tablist.findAll('[role="tab"]')
}

function getInspectorPanels(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('[id^="panel-"][role="tabpanel"]')
}

describe('InspectorPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders all five tab buttons', async () => {
    const wrapper = await mountInspectorPanel()
    const tabs = getInspectorTabs(wrapper)
    expect(tabs).toHaveLength(6)

    const labels = tabs.map((t) => t.text())
    expect(labels).toContain('Trace')
    expect(labels).toContain('Memory')
    expect(labels).toContain('Analytics')
    expect(labels).toContain('Config')
    expect(labels).toContain('History')
    expect(labels).toContain('Tools')
  })

  it('has a tablist container', async () => {
    const wrapper = await mountInspectorPanel()
    const tablist = wrapper.find('[role="tablist"]')
    expect(tablist.exists()).toBe(true)
    expect(tablist.attributes('aria-label')).toBe('Inspector tabs')
  })

  it('Trace tab is active by default', async () => {
    const wrapper = await mountInspectorPanel()
    const tabs = getInspectorTabs(wrapper)
    const traceTab = tabs.find((t) => t.text() === 'Trace')
    expect(traceTab?.attributes('aria-selected')).toBe('true')
  })

  it('other tabs are not selected by default', async () => {
    const wrapper = await mountInspectorPanel()
    const tabs = getInspectorTabs(wrapper)
    const nonTraceTabs = tabs.filter((t) => t.text() !== 'Trace')
    nonTraceTabs.forEach((tab) => {
      expect(tab.attributes('aria-selected')).toBe('false')
    })
  })

  it('clicking a tab switches the active tab', async () => {
    const wrapper = await mountInspectorPanel()
    const tabs = getInspectorTabs(wrapper)
    const memoryTab = tabs.find((t) => t.text() === 'Memory')

    await memoryTab!.trigger('click')
    await flushPromises()

    expect(memoryTab!.attributes('aria-selected')).toBe('true')

    // Trace should no longer be selected
    const traceTab = tabs.find((t) => t.text() === 'Trace')
    expect(traceTab!.attributes('aria-selected')).toBe('false')
  })

  it('renders tabpanel elements for each tab', async () => {
    const wrapper = await mountInspectorPanel()
    const panels = getInspectorPanels(wrapper)
    expect(panels).toHaveLength(6)
  })

  it('tab buttons have aria-controls linking to panels', async () => {
    const wrapper = await mountInspectorPanel()
    const tabs = getInspectorTabs(wrapper)

    const traceTab = tabs.find((t) => t.text() === 'Trace')
    expect(traceTab?.attributes('aria-controls')).toBe('panel-trace')

    const toolsTab = tabs.find((t) => t.text() === 'Tools')
    expect(toolsTab?.attributes('aria-controls')).toBe('panel-tools')
  })

  it('panels have correct aria-label attributes', async () => {
    const wrapper = await mountInspectorPanel()
    const panels = getInspectorPanels(wrapper)

    const labels = panels.map((p) => p.attributes('aria-label'))
    expect(labels).toContain('Trace panel')
    expect(labels).toContain('Memory panel')
    expect(labels).toContain('Memory analytics panel')
    expect(labels).toContain('Config panel')
    expect(labels).toContain('History panel')
    expect(labels).toContain('Tool stats panel')
  })

  it('switching through all tabs works', async () => {
    const wrapper = await mountInspectorPanel()
    const tabs = getInspectorTabs(wrapper)

    for (const tab of tabs) {
      await tab.trigger('click')
      await flushPromises()
      expect(tab.attributes('aria-selected')).toBe('true')
    }
  })
})
