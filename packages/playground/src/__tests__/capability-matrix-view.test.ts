/**
 * Tests for the CapabilityMatrixView component.
 *
 * Verifies: form rendering, input/button state, fetch URL construction,
 * matrix table rendering, badge color classes, error states (404 and
 * network failure), and the Clear button reset flow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

async function mountView() {
  const { default: CapabilityMatrixView } = await import('../views/CapabilityMatrixView.vue')
  return mount(CapabilityMatrixView)
}

type CapabilityStatus = 'active' | 'degraded' | 'dropped' | 'unsupported'

interface ProviderCapabilityRow {
  systemPrompt: CapabilityStatus
  toolBindings: CapabilityStatus
  approvalMode: CapabilityStatus
  networkPolicy: CapabilityStatus
  budgetLimit: CapabilityStatus
  warnings: string[]
}

function makeMatrix(overrides: Partial<Record<string, Partial<ProviderCapabilityRow>>> = {}) {
  const defaultRow: ProviderCapabilityRow = {
    systemPrompt: 'active',
    toolBindings: 'active',
    approvalMode: 'active',
    networkPolicy: 'active',
    budgetLimit: 'active',
    warnings: [],
  }

  return {
    data: {
      skillId: 'my-skill',
      skillName: 'My Skill',
      providers: {
        claude: { ...defaultRow, ...(overrides['claude'] ?? {}) },
        codex: { ...defaultRow, ...(overrides['codex'] ?? {}) },
      },
    },
  }
}

function makeFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(body),
  })
}

function makeFetchError(status: number, statusText: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    json: vi.fn().mockResolvedValue({}),
  })
}

describe('CapabilityMatrixView', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  // ------------------------------------------------------------------ form

  describe('form rendering', () => {
    it('renders the skill-id-input and Inspect button', async () => {
      const wrapper = await mountView()

      expect(wrapper.find('#skill-id-input').exists()).toBe(true)
      const button = wrapper.find('button[type="submit"]')
      expect(button.exists()).toBe(true)
      expect(button.text()).toContain('Inspect')
    })

    it('disables Inspect button when input is empty', async () => {
      const wrapper = await mountView()

      const button = wrapper.find('button[type="submit"]')
      expect(button.attributes('disabled')).toBeDefined()
    })

    it('enables Inspect button when input has a value', async () => {
      const wrapper = await mountView()

      const input = wrapper.find('#skill-id-input')
      await input.setValue('my-skill')

      const button = wrapper.find('button[type="submit"]')
      expect(button.attributes('disabled')).toBeUndefined()
    })
  })

  // ------------------------------------------------------------------ fetch

  describe('fetch behaviour', () => {
    it('calls fetch with the correct URL on submit', async () => {
      const mockFetch = makeFetchOk(makeMatrix())
      vi.stubGlobal('fetch', mockFetch)

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(mockFetch).toHaveBeenCalledOnce()
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/capabilities/my-skill')
    })

    it('URL-encodes a skillId that contains special characters', async () => {
      const mockFetch = makeFetchOk(makeMatrix())
      vi.stubGlobal('fetch', mockFetch)

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my skill/v2')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(mockFetch).toHaveBeenCalledWith('/api/v1/capabilities/my%20skill%2Fv2')
    })
  })

  // ------------------------------------------------------------------ success

  describe('successful response', () => {
    it('renders the matrix table with provider rows after a successful fetch', async () => {
      vi.stubGlobal('fetch', makeFetchOk(makeMatrix()))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('table').exists()).toBe(true)
      const text = wrapper.text()
      expect(text).toContain('claude')
      expect(text).toContain('codex')
    })

    it('renders all five capability column headers', async () => {
      vi.stubGlobal('fetch', makeFetchOk(makeMatrix()))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const text = wrapper.text()
      expect(text).toContain('System Prompt')
      expect(text).toContain('Tool Bindings')
      expect(text).toContain('Approval Mode')
      expect(text).toContain('Network Policy')
      expect(text).toContain('Budget Limit')
    })

    it('displays the skill name and skillId from the response', async () => {
      vi.stubGlobal('fetch', makeFetchOk(makeMatrix()))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const text = wrapper.text()
      expect(text).toContain('My Skill')
      expect(text).toContain('my-skill')
    })
  })

  // ------------------------------------------------------------------ badges

  describe('badgeClass', () => {
    it('applies bg-green-500/20 class for active status', async () => {
      const body = makeMatrix({ claude: { systemPrompt: 'active' } })
      vi.stubGlobal('fetch', makeFetchOk(body))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const badges = wrapper.findAll('span.rounded-full')
      const activeOne = badges.find(b => b.text() === 'active')
      expect(activeOne).toBeDefined()
      expect(activeOne!.classes().join(' ')).toContain('bg-green-500/20')
      expect(activeOne!.classes().join(' ')).toContain('text-green-400')
    })

    it('applies bg-yellow-500/20 class for degraded status', async () => {
      const body = makeMatrix({ claude: { systemPrompt: 'degraded' } })
      vi.stubGlobal('fetch', makeFetchOk(body))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const badges = wrapper.findAll('span.rounded-full')
      const degradedOne = badges.find(b => b.text() === 'degraded')
      expect(degradedOne).toBeDefined()
      expect(degradedOne!.classes().join(' ')).toContain('bg-yellow-500/20')
      expect(degradedOne!.classes().join(' ')).toContain('text-yellow-400')
    })

    it('applies bg-red-500/20 class for dropped status', async () => {
      const body = makeMatrix({ claude: { systemPrompt: 'dropped' } })
      vi.stubGlobal('fetch', makeFetchOk(body))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const badges = wrapper.findAll('span.rounded-full')
      const droppedOne = badges.find(b => b.text() === 'dropped')
      expect(droppedOne).toBeDefined()
      expect(droppedOne!.classes().join(' ')).toContain('bg-red-500/20')
      expect(droppedOne!.classes().join(' ')).toContain('text-red-400')
    })

    it('applies bg-pg-surface-raised class for unsupported status', async () => {
      const body = makeMatrix({ claude: { systemPrompt: 'unsupported' } })
      vi.stubGlobal('fetch', makeFetchOk(body))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const badges = wrapper.findAll('span.rounded-full')
      const unsupportedOne = badges.find(b => b.text() === 'unsupported')
      expect(unsupportedOne).toBeDefined()
      expect(unsupportedOne!.classes().join(' ')).toContain('bg-pg-surface-raised')
      expect(unsupportedOne!.classes().join(' ')).toContain('text-pg-text-muted')
    })
  })

  // ------------------------------------------------------------------ error states

  describe('error states', () => {
    it('shows an error message containing the skillId on a 404 response', async () => {
      vi.stubGlobal('fetch', makeFetchError(404, 'Not Found'))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('missing-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const alert = wrapper.find('[role="alert"]')
      expect(alert.exists()).toBe(true)
      expect(alert.text()).toContain('missing-skill')
      expect(alert.text()).toContain('not found')
    })

    it('shows a generic error message for non-404 HTTP errors', async () => {
      vi.stubGlobal('fetch', makeFetchError(500, 'Internal Server Error'))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const alert = wrapper.find('[role="alert"]')
      expect(alert.exists()).toBe(true)
      expect(alert.text()).toContain('500')
    })

    it('shows an error message when fetch throws a network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const alert = wrapper.find('[role="alert"]')
      expect(alert.exists()).toBe(true)
      expect(alert.text()).toContain('Failed to fetch')
    })

    it('shows an error message when fetch rejects with a non-Error value', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('unexpected'))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const alert = wrapper.find('[role="alert"]')
      expect(alert.exists()).toBe(true)
      expect(alert.text()).toContain('Network error')
    })
  })

  // ------------------------------------------------------------------ clear

  describe('Clear button', () => {
    it('does not render Clear button before any fetch', async () => {
      const wrapper = await mountView()
      const clearButton = wrapper.findAll('button').find(b => b.text() === 'Clear')
      expect(clearButton).toBeUndefined()
    })

    it('renders Clear button after a successful fetch', async () => {
      vi.stubGlobal('fetch', makeFetchOk(makeMatrix()))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const clearButton = wrapper.findAll('button').find(b => b.text() === 'Clear')
      expect(clearButton).toBeDefined()
    })

    it('renders Clear button after an error response', async () => {
      vi.stubGlobal('fetch', makeFetchError(404, 'Not Found'))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const clearButton = wrapper.findAll('button').find(b => b.text() === 'Clear')
      expect(clearButton).toBeDefined()
    })

    it('clicking Clear removes the matrix table and error and hides the Clear button', async () => {
      vi.stubGlobal('fetch', makeFetchOk(makeMatrix()))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('table').exists()).toBe(true)

      const clearButton = wrapper.findAll('button').find(b => b.text() === 'Clear')
      await clearButton!.trigger('click')
      await flushPromises()

      expect(wrapper.find('table').exists()).toBe(false)
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      const clearButtonAfter = wrapper.findAll('button').find(b => b.text() === 'Clear')
      expect(clearButtonAfter).toBeUndefined()
    })

    it('clears the input field when Clear is clicked', async () => {
      vi.stubGlobal('fetch', makeFetchOk(makeMatrix()))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const clearButton = wrapper.findAll('button').find(b => b.text() === 'Clear')
      await clearButton!.trigger('click')
      await flushPromises()

      const input = wrapper.find('#skill-id-input')
      expect((input.element as HTMLInputElement).value).toBe('')
    })
  })

  // ------------------------------------------------------------------ warnings

  describe('warnings section', () => {
    it('renders warnings for providers that have them', async () => {
      const body = makeMatrix({
        claude: { warnings: ['Tool bindings partially supported', 'Budget limit ignored'] },
      })
      vi.stubGlobal('fetch', makeFetchOk(body))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const text = wrapper.text()
      expect(text).toContain('Warnings')
      expect(text).toContain('Tool bindings partially supported')
      expect(text).toContain('Budget limit ignored')
    })

    it('does not render warnings section when no provider has warnings', async () => {
      vi.stubGlobal('fetch', makeFetchOk(makeMatrix()))

      const wrapper = await mountView()
      await wrapper.find('#skill-id-input').setValue('my-skill')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.text()).not.toContain('Warnings')
    })
  })
})
