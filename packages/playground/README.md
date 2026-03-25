# @forgeagent/playground

Vue 3 interactive playground for developing and debugging ForgeAgent agents. Provides a chat interface, trace viewer, memory browser, config editor, and run history inspector. Connects to `@forgeagent/server` via REST API and WebSocket for real-time event streaming.

This is a private workspace package -- not published to npm.

## Setup

```bash
cd packages/forgeagent-playground

# Install dependencies
npm install

# Start development server (Vite)
npm run dev

# Type check
npm run typecheck

# Run tests
npm run test

# Build for production
npm run build
```

In development, the Vite dev server proxies `/api/*` requests to the ForgeAgent server backend. In production, the built assets are served by `@forgeagent/server` at the `/playground` route.

## Features

### Chat Interface

Interactive conversation panel for sending messages to ForgeAgent agents and viewing responses.

- **Agent selector** -- switch between available agents fetched from the server
- **Message history** -- scrollable list of user/assistant/system messages with timestamps
- **Message input** -- text input with loading state while awaiting agent response
- **Auto-clear** -- message history resets when switching agents

Components: `ChatPanel.vue`, `ChatInput.vue`, `MessageList.vue`, `MessageBubble.vue`

### Trace Viewer

Timeline visualization of agent execution traces, showing LLM calls, tool invocations, memory operations, and guardrail checks.

- **Event timeline** -- chronological list of trace events with type, name, duration, and metadata
- **Event types** -- `llm`, `tool`, `memory`, `guardrail`, `system`
- **Real-time updates** -- events stream in via WebSocket during active runs

Component: `TraceTab.vue` (in inspector panel)

### Memory Browser

Browse and inspect agent memory namespaces and individual records.

- **Namespace list** -- displays available memory namespaces with record counts
- **Record viewer** -- inspect individual memory entries (key, value, timestamps)
- **Namespace filtering** -- select specific namespaces to browse

Component: `MemoryTab.vue` (in inspector panel)

### Config Editor

View and modify agent configuration including instructions, model tier, tools, guardrails, and approval settings.

Component: `ConfigTab.vue` (in inspector panel)

### Run History

Browse past agent runs with status, duration, and timestamps.

Component: `HistoryTab.vue` (in inspector panel)

### WebSocket Streaming

Real-time event streaming from the ForgeAgent server for live trace updates during active agent runs.

- **Connection management** -- automatic reconnection with state tracking (`disconnected`, `connecting`, `connected`, `error`)
- **Event dispatching** -- incoming WebSocket events update the trace store in real time

Composable: `useWebSocket.ts`; Store: `ws-store.ts`

## Architecture

### State Management (Pinia)

| Store | Purpose |
|-------|---------|
| `chat-store` | Chat messages, agent selection, send/receive cycle |
| `trace-store` | Trace events from agent execution |
| `memory-store` | Memory namespace browsing and record inspection |
| `ws-store` | WebSocket connection state and event handling |

### Composables

| Composable | Purpose |
|------------|---------|
| `useApi` | Typed HTTP client wrapping `fetch` with JSON handling and error normalization |
| `useWebSocket` | WebSocket connection management with auto-reconnect |

### API Client

The `useApi` composable provides typed `get`, `post`, `patch`, and `del` methods:

```ts
import { useApi } from './composables/useApi'

const { get, post } = useApi()

// Fetch available agents
const agents = await get<ApiResponse<AgentSummary[]>>('/api/agents?active=true')

// Send a chat message
const response = await post<ApiResponse<ChatMessage>>(
  `/api/agents/${agentId}/chat`,
  { message: 'Hello' },
)
```

API errors are normalized into `ApiRequestError` instances with `status`, `code`, and `message` properties.

## Project Structure

```
src/
  main.ts                           # App entry point (Vue + Pinia + Router)
  App.vue                           # Root component
  router/index.ts                   # Vue Router (SPA, single PlaygroundView route)
  types.ts                          # Shared TypeScript types
  views/
    PlaygroundView.vue              # Main playground layout
  components/
    chat/
      ChatPanel.vue                 # Chat container
      ChatInput.vue                 # Message input field
      MessageList.vue               # Scrollable message list
      MessageBubble.vue             # Individual message display
    inspector/
      InspectorPanel.vue            # Tabbed inspector sidebar
      TraceTab.vue                  # Trace event timeline
      MemoryTab.vue                 # Memory namespace browser
      ConfigTab.vue                 # Agent config editor
      HistoryTab.vue                # Run history list
  stores/
    chat-store.ts                   # Chat state (Pinia)
    trace-store.ts                  # Trace state (Pinia)
    memory-store.ts                 # Memory browser state (Pinia)
    ws-store.ts                     # WebSocket state (Pinia)
  composables/
    useApi.ts                       # Typed fetch wrapper
    useWebSocket.ts                 # WebSocket connection manager
  assets/
    main.css                        # Global styles (Tailwind CSS 4)
  __tests__/
    chat-store.test.ts              # Chat store unit tests
    ws-store.test.ts                # WebSocket store tests
    trace-store.test.ts             # Trace store tests
    useApi.test.ts                  # API composable tests
```

## Types

Key TypeScript types used throughout the playground:

```ts
type MessageRole = 'user' | 'assistant' | 'system'

interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: string
}

type WsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

interface TraceEvent {
  id: string
  type: 'llm' | 'tool' | 'memory' | 'guardrail' | 'system'
  name: string
  startedAt: string
  durationMs: number
  metadata?: Record<string, unknown>
}

interface AgentSummary {
  id: string
  name: string
  description?: string
  modelTier: string
  active: boolean
}

interface AgentConfig {
  id: string
  name: string
  instructions: string
  modelTier: string
  tools?: string[]
  guardrails?: Record<string, unknown>
  approval?: 'auto' | 'required' | 'conditional'
}

interface MemoryNamespace {
  name: string
  recordCount: number
}

interface MemoryRecord {
  key: string
  value: unknown
  namespace: string
  createdAt?: string
  updatedAt?: string
}
```

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `vue` | `^3.4.0` | UI framework |
| `vue-router` | `^4.3.0` | SPA routing |
| `pinia` | `^2.1.0` | State management |

## Dev Dependencies

| Package | Purpose |
|---------|---------|
| `vite` `^5.0.0` | Build tool and dev server |
| `tailwindcss` `^4.0.0` | Utility-first CSS (v4) |
| `vue-tsc` `^2.0.0` | Vue TypeScript type checking |
| `vitest` `^1.4.0` | Unit testing |
| `@vue/test-utils` `^2.4.5` | Vue component testing |
| `@vitejs/plugin-vue` `^5.0.0` | Vite Vue plugin |

## License

MIT
