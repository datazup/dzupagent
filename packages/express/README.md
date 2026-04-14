# @dzupagent/express

Express integration for DzupAgent. This package provides an Express router to expose agents as HTTP endpoints.

## Installation

```bash
yarn add @dzupagent/express @dzupagent/agent @dzupagent/core express zod
```

## Features

- **SSE Streaming**: Built-in support for streaming agent outputs using Server-Sent Events (SSE).
- **Synchronous JSON**: Simple POST endpoint for non-streaming agent responses.
- **Health Checks**: Endpoint to check agent health and availability.
- **Hooks**: Request life-cycle hooks for auth, logging, and metrics.

## Usage

### Simple Setup

```typescript
import express from 'express';
import { DzupAgent } from '@dzupagent/agent';
import { createAgentRouter } from '@dzupagent/express';

const app = express();
app.use(express.json());

const agent = new DzupAgent({
  id: 'my-agent',
  // ... configuration
});

const router = createAgentRouter({
  agents: {
    'my-agent': agent
  }
});

app.use('/api', router);

app.listen(3000, () => {
  console.log('Agent server running on http://localhost:3000');
});
```

### Endpoints Created

The router exposes the following endpoints (relative to `basePath`):

- `POST /chat`: SSE streaming response.
- `POST /chat/sync`: Synchronous JSON response.
- `GET  /health`: Health status and list of available agents.

### Request Body

Both `/chat` and `/chat/sync` accept:

```json
{
  "message": "Hello!",
  "agentName": "my-agent" (optional, defaults to first agent)
}
```

## API

### `createAgentRouter(config: AgentRouterConfig)`

Creates an Express `Router`.

#### Configuration Properties

- `agents`: A map of agent IDs to `DzupAgent` instances.
- `basePath`: Optional base path for the router (default: `''`).
- `auth`: Optional Express middleware for authentication.
- `hooks`: Optional lifecycle hooks:
    - `beforeAgent(req, agentName)`: Runs before agent processing.
    - `afterAgent(req, agentName, result)`: Runs after agent processing.
    - `onError(req, error)`: Runs on agent or router errors.
- `sse`: Optional configuration for SSE streaming.

### `SSEHandler`

Internal class used to handle streaming responses to the client.
