# @dzipagent/express -- Express Adapter

Express.js integration for DzipAgent with SSE streaming, synchronous chat
endpoints, and lifecycle hooks.

## Installation

```bash
yarn add @dzipagent/express
```

Peer dependencies: `express`, `@dzipagent/agent`, `@langchain/core`.

## Quick Start

```ts
import express from 'express'
import { createAgentRouter } from '@dzipagent/express'
import { DzipAgent } from '@dzipagent/agent'

const app = express()
app.use(express.json())

const researchAgent = new DzipAgent({ /* ... */ })

const agentRouter = createAgentRouter({
  agents: { research: researchAgent },
  auth: authMiddleware,  // optional Express middleware
  sse: { keepAliveMs: 15_000 },
  hooks: {
    beforeAgent: async (req, agentName) => { /* logging, rate limiting */ },
    afterAgent: async (req, agentName, result) => { /* save conversation */ },
    onError: async (req, error) => { /* error tracking */ },
  },
})

app.use('/api/ai', agentRouter)
// POST /api/ai/chat       -- SSE streaming
// POST /api/ai/chat/sync  -- JSON response
// GET  /api/ai/health     -- agent availability
```

## Components

### createAgentRouter

Factory function that returns an Express `Router` with three endpoints:

**POST /chat** -- SSE streaming response. Streams `AgentStreamEvent` types as
SSE events (`chunk`, `tool_call`, `tool_result`, `done`, `error`,
`budget_warning`, `stuck`). Aborts the agent on client disconnect.

**POST /chat/sync** -- JSON response. Runs the agent to completion and returns:
```json
{
  "content": "...",
  "usage": { "inputTokens": 100, "outputTokens": 50, "totalTokens": 150 },
  "toolCalls": 2,
  "durationMs": 1234
}
```

**GET /health** -- Returns configured agent names and count.

Request body for both chat endpoints:

```ts
interface ChatRequestBody {
  message: string                        // required
  agentName?: string                     // which agent to use (default: first in config)
  conversationId?: string                // for multi-turn context
  model?: string                         // model override
  configurable?: Record<string, unknown> // extra params for the agent
}
```

Agent resolution: if `agentName` is provided and found, use it; otherwise fall
back to the first agent in the config map.

Configuration:

```ts
interface AgentRouterConfig {
  agents: Record<string, DzipAgent>
  auth?: (req, res, next) => void         // Express auth middleware
  sse?: SSEHandlerConfig                  // SSE streaming options
  hooks?: {
    beforeAgent?: (req, agentName) => Promise<void> | void
    afterAgent?: (req, agentName, result) => Promise<void> | void
    onError?: (req, error) => Promise<void> | void
  }
  basePath?: string                       // route prefix (default: '')
}
```

### SSEHandler

High-level handler that bridges DzipAgent streaming to Express responses.
Used internally by `createAgentRouter`, but can also be used standalone.

```ts
import { SSEHandler } from '@dzipagent/express'

const handler = new SSEHandler({
  keepAliveMs: 15_000,
  headers: { 'X-Custom': 'value' },
  onDisconnect: (req) => console.log('Client disconnected'),
  onComplete: async (result, req) => saveConversation(result),
  onError: (error, req, res) => reportError(error),
})

// Option 1: Automatic agent streaming
app.post('/chat', async (req, res) => {
  const agentStream = agent.stream(messages)
  const result = await handler.streamAgent(agentStream, res, req)
  // result: AgentResult
})

// Option 2: Manual event writing
app.get('/events', (req, res) => {
  const writer = handler.initStream(res)
  writer.writeChunk('Hello ')
  writer.writeChunk('world')
  writer.writeDone({ content: 'Hello world', toolCalls: 0, durationMs: 100 })
  writer.end()
})
```

`streamAgent` maps `AgentStreamEvent` types to SSE events:

| Agent Event      | SSE Event        | Data Shape                         |
|------------------|------------------|------------------------------------|
| `text`           | `chunk`          | `{ content: string }`              |
| `tool_call`      | `tool_call`      | `{ name: string, args: unknown }`  |
| `tool_result`    | `tool_result`    | `{ name: string, result: unknown }`|
| `done`           | `done`           | `AgentResult` fields               |
| `error`          | `error`          | `{ message: string }`              |
| `budget_warning` | `budget_warning` | `{ message: string }`              |
| `stuck`          | `stuck`          | event data passthrough             |

Client disconnect handling: listens on `req.close`, calls
`agentStream.return()` to signal the generator to stop, then fires the
`onDisconnect` hook.

### SSEWriter

Low-level writer for sending individual SSE events to an Express response.

```ts
import { SSEWriter } from '@dzipagent/express'

const writer = new SSEWriter(res, { keepAliveMs: 15_000 })
writer.startKeepAlive()     // start periodic `: keepalive\n\n` pings

writer.write({ type: 'chunk', data: { content: 'text' } })
writer.writeChunk('text')   // shorthand for chunk events
writer.writeError(error)    // shorthand for error events
writer.writeDone(result)    // shorthand for done events

writer.isConnected()        // check if client is still connected
writer.end()                // stop keep-alive, end response
```

Default SSE format:
```
event: chunk
data: {"content":"Hello"}

```

Custom formatting via `formatEvent` option:
```ts
const writer = new SSEWriter(res, {
  formatEvent: (event) => `data: ${JSON.stringify({ type: event.type, ...event.data })}\n\n`,
})
```

## SSE Event Protocol

Headers set by `SSEHandler.initStream()`:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

Keep-alive comments (`: keepalive\n\n`) are sent at the configured interval
(default 15s) to prevent proxy/load balancer timeouts.

## Types

```ts
interface SSEEvent {
  type: string       // SSE event field
  data: unknown      // serialized as JSON in data field
  id?: string        // optional SSE id field
}

interface AgentResult {
  content: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  cost?: number
  toolCalls: number
  durationMs: number
}

interface SSEHandlerConfig {
  formatEvent?: (event: SSEEvent) => string
  headers?: Record<string, string>
  onDisconnect?: (req: Request) => void
  onComplete?: (result: AgentResult, req: Request) => void | Promise<void>
  onError?: (error: Error, req: Request, res: Response) => void
  keepAliveMs?: number  // default 15_000
}
```

## Exports

```ts
// Classes
export { SSEHandler, SSEWriter }

// Functions
export { createAgentRouter }

// Types
export type { SSEEvent, SSEHandlerConfig, AgentResult, ChatRequestBody, AgentRouterConfig }
```
