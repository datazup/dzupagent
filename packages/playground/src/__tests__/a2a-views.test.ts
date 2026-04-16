/**
 * Tests for A2A task views, StepInspectorPanel component, and SSE integration.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

// ── Mock EventSource ──────────────────────────────────────
type ESListener = (event: MessageEvent | Event) => void

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  readyState = 0 // CONNECTING
  closed = false
  private _listeners: Record<string, ESListener[]> = {}

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
    // Simulate async open
    queueMicrotask(() => {
      if (!this.closed) {
        this.readyState = 1 // OPEN
        if (this.onopen) this.onopen(new Event('open'))
      }
    })
  }

  addEventListener(type: string, listener: ESListener): void {
    if (!this._listeners[type]) this._listeners[type] = []
    this._listeners[type]!.push(listener)
  }

  removeEventListener(type: string, listener: ESListener): void {
    const arr = this._listeners[type]
    if (arr) {
      this._listeners[type] = arr.filter((l) => l !== listener)
    }
  }

  close(): void {
    this.closed = true
    this.readyState = 2 // CLOSED
  }

  /** Test helper: emit a message event with JSON data */
  _emitMessage(data: unknown): void {
    const event = new MessageEvent('message', { data: JSON.stringify(data) })
    if (this.onmessage) this.onmessage(event)
  }

  /** Test helper: trigger an error */
  _emitError(): void {
    const event = new Event('error')
    if (this.onerror) this.onerror(event)
  }

  static reset(): void {
    MockEventSource.instances = []
  }

  static latest(): MockEventSource {
    return MockEventSource.instances[MockEventSource.instances.length - 1]!
  }
}

vi.stubGlobal('EventSource', MockEventSource)

// Mock vue-router
const pushMock = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
  useRoute: () => ({
    params: { id: 'task-001' },
  }),
}))

// Mock useApi composable
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

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-abc12345',
    agentName: 'test-agent',
    state: 'working',
    messages: [],
    artifacts: [],
    createdAt: '2026-04-16T10:00:00.000Z',
    updatedAt: '2026-04-16T10:00:00.000Z',
    ...overrides,
  }
}

async function mountA2ATasksView() {
  const { default: A2ATasksView } = await import('../views/A2ATasksView.vue')
  return mount(A2ATasksView)
}

async function mountA2ATaskDetailView() {
  const { default: A2ATaskDetailView } = await import('../views/A2ATaskDetailView.vue')
  return mount(A2ATaskDetailView)
}

async function mountStepInspectorPanel(props: {
  stepType: string
  configSchema?: object
  outputSchema?: object
  executionTrace?: Array<{ timestamp: string; event: string; data?: unknown }>
  playgroundComponent?: string
}) {
  const { default: StepInspectorPanel } = await import(
    '../components/inspector/StepInspectorPanel.vue'
  )
  return mount(StepInspectorPanel, { props })
}

// ── Original A2ATasksView tests ───────────────────────────

describe('A2ATasksView', () => {
  beforeEach(() => {
    pushMock.mockReset()
    getMock.mockReset()
    postMock.mockReset()
    MockEventSource.reset()
  })

  it('renders "No tasks" empty state when fetch returns empty array', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    const wrapper = await mountA2ATasksView()
    await flushPromises()

    expect(wrapper.text()).toContain('No tasks')
    expect(wrapper.text()).toContain('A2A tasks will appear here')
  })

  it('renders a task row with correct state badge color class', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: [makeTask()],
      count: 1,
    })

    const wrapper = await mountA2ATasksView()
    await flushPromises()

    expect(wrapper.text()).toContain('test-agent')
    expect(wrapper.text()).toContain('working')

    const badge = wrapper.find('[data-state="working"]')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).toContain('text-pg-warning')
  })
})

// ── Original A2ATaskDetailView tests ──────────────────────

describe('A2ATaskDetailView', () => {
  beforeEach(() => {
    pushMock.mockReset()
    getMock.mockReset()
    postMock.mockReset()
    MockEventSource.reset()
  })

  it('renders the Send Message form with a textarea and submit button', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', agentName: 'detail-agent', state: 'completed' }),
    })

    const wrapper = await mountA2ATaskDetailView()
    await flushPromises()

    const textarea = wrapper.find('[data-testid="message-textarea"]')
    expect(textarea.exists()).toBe(true)
    expect(textarea.element.tagName.toLowerCase()).toBe('textarea')

    const sendButton = wrapper.find('[data-testid="send-button"]')
    expect(sendButton.exists()).toBe(true)
    expect(sendButton.text()).toContain('Send')
  })
})

// ── StepInspectorPanel tests ──────────────────────────────

describe('StepInspectorPanel', () => {
  it('renders the step type name and config/output schema sections when provided', async () => {
    const configSchema = { type: 'object', properties: { name: { type: 'string' } } }
    const outputSchema = { type: 'object', properties: { result: { type: 'number' } } }

    const wrapper = await mountStepInspectorPanel({
      stepType: 'synthesize_report',
      configSchema,
      outputSchema,
    })
    await flushPromises()

    // Step type heading
    const heading = wrapper.find('[data-testid="step-type-heading"]')
    expect(heading.exists()).toBe(true)
    expect(heading.text()).toBe('synthesize_report')

    // Config schema section rendered
    const configSection = wrapper.find('[data-testid="config-schema-section"]')
    expect(configSection.exists()).toBe(true)
    expect(configSection.text()).toContain('Config Schema')
    expect(configSection.text()).toContain('"name"')

    // Output schema section rendered
    const outputSection = wrapper.find('[data-testid="output-schema-section"]')
    expect(outputSection.exists()).toBe(true)
    expect(outputSection.text()).toContain('Output Schema')
    expect(outputSection.text()).toContain('"result"')
  })
})

// ── SSE integration tests for A2ATasksView ────────────────

describe('A2ATasksView SSE integration', () => {
  beforeEach(() => {
    pushMock.mockReset()
    getMock.mockReset()
    postMock.mockReset()
    MockEventSource.reset()
  })

  it('opens an SSE connection on mount', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    await mountA2ATasksView()
    await flushPromises()

    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.latest().url).toContain('/api/events/stream')
  })

  it('shows Live indicator when SSE is connected', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    const wrapper = await mountA2ATasksView()
    await flushPromises()

    const indicator = wrapper.find('[data-testid="sse-status-connected"]')
    expect(indicator.exists()).toBe(true)
    expect(indicator.text()).toContain('Live')
  })

  it('refreshes task list when agent:completed event is received', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    await mountA2ATasksView()
    await flushPromises()

    // Reset to track subsequent calls
    getMock.mockReset()
    getMock.mockResolvedValueOnce({
      success: true,
      data: [makeTask({ state: 'completed' })],
      count: 1,
    })

    // Simulate SSE event
    const source = MockEventSource.latest()
    source._emitMessage({ type: 'agent:completed', runId: 'run-1' })
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/a2a/tasks')
  })

  it('refreshes task list when agent:failed event is received', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    await mountA2ATasksView()
    await flushPromises()

    getMock.mockReset()
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'agent:failed', runId: 'run-2' })
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/a2a/tasks')
  })

  it('refreshes task list when agent:started event is received', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    await mountA2ATasksView()
    await flushPromises()

    getMock.mockReset()
    getMock.mockResolvedValueOnce({ success: true, data: [makeTask()], count: 1 })

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'agent:started', runId: 'run-3' })
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/a2a/tasks')
  })

  it('ignores non-task SSE events (e.g. tool:called)', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    await mountA2ATasksView()
    await flushPromises()

    getMock.mockReset()

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'tool:called', toolName: 'read_file' })
    await flushPromises()

    expect(getMock).not.toHaveBeenCalled()
  })

  it('ignores malformed SSE messages', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    await mountA2ATasksView()
    await flushPromises()

    getMock.mockReset()

    const source = MockEventSource.latest()
    // Send a non-JSON message directly through onmessage
    const badEvent = new MessageEvent('message', { data: 'not json' })
    if (source.onmessage) source.onmessage(badEvent)
    await flushPromises()

    expect(getMock).not.toHaveBeenCalled()
  })

  it('handles envelope-format events with nested payload', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    await mountA2ATasksView()
    await flushPromises()

    getMock.mockReset()
    getMock.mockResolvedValueOnce({ success: true, data: [makeTask()], count: 1 })

    const source = MockEventSource.latest()
    source._emitMessage({
      version: 'v1',
      payload: { type: 'agent:completed', runId: 'run-5' },
    })
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/a2a/tasks')
  })

  it('closes SSE connection on unmount', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    const wrapper = await mountA2ATasksView()
    await flushPromises()

    const source = MockEventSource.latest()
    expect(source.closed).toBe(false)

    wrapper.unmount()

    expect(source.closed).toBe(true)
  })

  it('shows Offline indicator when SSE encounters an error', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    const wrapper = await mountA2ATasksView()
    await flushPromises()

    const source = MockEventSource.latest()
    source._emitError()
    await flushPromises()

    const indicator = wrapper.find('[data-testid="sse-status-error"]')
    expect(indicator.exists()).toBe(true)
    expect(indicator.text()).toContain('Offline')
  })

  it('handles a2a:task_updated event type', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    await mountA2ATasksView()
    await flushPromises()

    getMock.mockReset()
    getMock.mockResolvedValueOnce({ success: true, data: [makeTask()], count: 1 })

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'a2a:task_updated', taskId: 'task-abc' })
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/a2a/tasks')
  })

  it('handles a2a:task_created event type', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    await mountA2ATasksView()
    await flushPromises()

    getMock.mockReset()
    getMock.mockResolvedValueOnce({ success: true, data: [makeTask()], count: 1 })

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'a2a:task_created', taskId: 'task-new' })
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/a2a/tasks')
  })

  it('handles agent:cancelled event type', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    await mountA2ATasksView()
    await flushPromises()

    getMock.mockReset()
    getMock.mockResolvedValueOnce({ success: true, data: [], count: 0 })

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'agent:cancelled', runId: 'run-x' })
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/a2a/tasks')
  })
})

// ── SSE integration tests for A2ATaskDetailView ───────────

describe('A2ATaskDetailView SSE integration', () => {
  beforeEach(() => {
    pushMock.mockReset()
    getMock.mockReset()
    postMock.mockReset()
    MockEventSource.reset()
  })

  it('opens an SSE connection on mount', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'working' }),
    })

    await mountA2ATaskDetailView()
    await flushPromises()

    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.latest().url).toContain('/api/events/stream')
  })

  it('refreshes task detail when agent:completed event is received', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'working' }),
    })

    await mountA2ATaskDetailView()
    await flushPromises()

    getMock.mockReset()
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'completed' }),
    })

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'agent:completed', taskId: 'task-001' })
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/a2a/tasks/task-001')
  })

  it('refreshes task detail when agent:failed event with matching taskId is received', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'working' }),
    })

    await mountA2ATaskDetailView()
    await flushPromises()

    getMock.mockReset()
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'failed' }),
    })

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'agent:failed', taskId: 'task-001' })
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/a2a/tasks/task-001')
  })

  it('refreshes on matching runId even without taskId', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'working' }),
    })

    await mountA2ATaskDetailView()
    await flushPromises()

    getMock.mockReset()
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'completed' }),
    })

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'agent:completed', runId: 'task-001' })
    await flushPromises()

    expect(getMock).toHaveBeenCalledWith('/api/a2a/tasks/task-001')
  })

  it('does not have setInterval polling (verifies migration)', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'working' }),
    })

    await mountA2ATaskDetailView()
    await flushPromises()

    // setInterval should not be called by the detail view for task polling
    expect(setIntervalSpy).not.toHaveBeenCalled()

    setIntervalSpy.mockRestore()
  })

  it('closes SSE connection on unmount', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'working' }),
    })

    const wrapper = await mountA2ATaskDetailView()
    await flushPromises()

    const source = MockEventSource.latest()
    expect(source.closed).toBe(false)

    wrapper.unmount()

    expect(source.closed).toBe(true)
  })

  it('shows Live indicator when SSE connected', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'working' }),
    })

    const wrapper = await mountA2ATaskDetailView()
    await flushPromises()

    const indicator = wrapper.find('[data-testid="sse-status-connected"]')
    expect(indicator.exists()).toBe(true)
  })

  it('shows Offline indicator on SSE error', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'working' }),
    })

    const wrapper = await mountA2ATaskDetailView()
    await flushPromises()

    const source = MockEventSource.latest()
    source._emitError()
    await flushPromises()

    const indicator = wrapper.find('[data-testid="sse-status-error"]')
    expect(indicator.exists()).toBe(true)
  })

  it('ignores events for a different task', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: makeTask({ id: 'task-001', state: 'working' }),
    })

    await mountA2ATaskDetailView()
    await flushPromises()

    getMock.mockReset()

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'agent:completed', taskId: 'task-OTHER' })
    await flushPromises()

    // Should not fetch since the event is for a different task
    expect(getMock).not.toHaveBeenCalled()
  })
})

// ── useA2AEventStream composable unit tests ───────────────

describe('useA2AEventStream composable', () => {
  beforeEach(() => {
    MockEventSource.reset()
  })

  it('can be imported and called', async () => {
    const { useA2AEventStream } = await import('../composables/useA2AEventStream.js')
    const onTaskEvent = vi.fn()
    const { open, close, isConnected } = useA2AEventStream({ onTaskEvent })

    open()
    await flushPromises()

    expect(MockEventSource.instances.length).toBe(1)
    expect(isConnected.value).toBe(true)

    close()
    expect(MockEventSource.latest().closed).toBe(true)
    expect(isConnected.value).toBe(false)
  })

  it('invokes onTaskEvent callback for matching events', async () => {
    const { useA2AEventStream } = await import('../composables/useA2AEventStream.js')
    const onTaskEvent = vi.fn()
    const { open } = useA2AEventStream({ onTaskEvent })

    open()
    await flushPromises()

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'agent:completed', runId: 'run-1' })

    expect(onTaskEvent).toHaveBeenCalledTimes(1)
  })

  it('does not invoke onTaskEvent for irrelevant events', async () => {
    const { useA2AEventStream } = await import('../composables/useA2AEventStream.js')
    const onTaskEvent = vi.fn()
    const { open } = useA2AEventStream({ onTaskEvent })

    open()
    await flushPromises()

    const source = MockEventSource.latest()
    source._emitMessage({ type: 'memory:written', namespace: 'test' })

    expect(onTaskEvent).not.toHaveBeenCalled()
  })

  it('filters by taskId when provided as string', async () => {
    const { useA2AEventStream } = await import('../composables/useA2AEventStream.js')
    const onTaskEvent = vi.fn()
    const { open } = useA2AEventStream({ onTaskEvent, taskId: 'task-42' })

    open()
    await flushPromises()

    const source = MockEventSource.latest()

    // Non-matching taskId should be ignored
    source._emitMessage({ type: 'agent:completed', taskId: 'task-OTHER' })
    expect(onTaskEvent).not.toHaveBeenCalled()

    // Matching taskId should trigger
    source._emitMessage({ type: 'agent:completed', taskId: 'task-42' })
    expect(onTaskEvent).toHaveBeenCalledTimes(1)
  })

  it('sets sseError on connection error', async () => {
    const { useA2AEventStream } = await import('../composables/useA2AEventStream.js')
    const onTaskEvent = vi.fn()
    const { open, sseError } = useA2AEventStream({ onTaskEvent })

    open()
    await flushPromises()

    expect(sseError.value).toBeNull()

    const source = MockEventSource.latest()
    source._emitError()

    expect(sseError.value).toBe('SSE connection error')
  })

  it('close() followed by open() creates a new EventSource', async () => {
    const { useA2AEventStream } = await import('../composables/useA2AEventStream.js')
    const onTaskEvent = vi.fn()
    const { open, close } = useA2AEventStream({ onTaskEvent })

    open()
    await flushPromises()
    expect(MockEventSource.instances.length).toBe(1)

    close()
    open()
    await flushPromises()
    expect(MockEventSource.instances.length).toBe(2)
    expect(MockEventSource.instances[0]!.closed).toBe(true)
    expect(MockEventSource.instances[1]!.closed).toBe(false)
  })

  it('open() closes previous connection before creating new one', async () => {
    const { useA2AEventStream } = await import('../composables/useA2AEventStream.js')
    const onTaskEvent = vi.fn()
    const { open } = useA2AEventStream({ onTaskEvent })

    open()
    await flushPromises()
    const first = MockEventSource.latest()

    open()
    await flushPromises()

    expect(first.closed).toBe(true)
    expect(MockEventSource.instances.length).toBe(2)
  })
})
