# @forgeagent/connectors

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Experimental | **Coverage:** N/A | **Exports:** 12

| Metric | Value |
|--------|-------|
| Source Files | 10 |
| Lines of Code | 1,174 |
| Test Files | 4 |
| Internal Dependencies | `@forgeagent/core` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @forgeagent/connectors
```
<!-- AUTO-GENERATED-END -->

Pre-built integrations for ForgeAgent. Each connector produces LangChain `DynamicStructuredTool` instances that can be passed directly to `ForgeAgent`'s `tools` config.

## Installation

```bash
yarn add @forgeagent/connectors
# or
npm install @forgeagent/connectors
```

## Quick Start

```ts
import { ForgeAgent } from '@forgeagent/agent'
import { createGitHubConnector, createSlackConnector, filterTools } from '@forgeagent/connectors'

// Create connectors
const github = createGitHubConnector({ token: process.env.GITHUB_TOKEN! })
const slack = createSlackConnector({ token: process.env.SLACK_TOKEN! })

// Use all tools from a connector
const agent = new ForgeAgent({
  tools: [...github.tools, ...slack.tools],
})

// Or filter to specific tools
const readOnlyGH = filterTools(github.tools, ['get_file', 'list_issues'])
```

## Available Connectors

### GitHub

```ts
import { createGitHubConnector } from '@forgeagent/connectors'

const github = createGitHubConnector({
  token: 'ghp_...',
  owner: 'my-org',    // optional default owner
  repo: 'my-repo',    // optional default repo
})
```

Tools: file operations, issue management, PR management, repository search.

### HTTP

```ts
import { createHTTPConnector } from '@forgeagent/connectors'

const http = createHTTPConnector({
  baseUrl: 'https://api.example.com',
  headers: { Authorization: 'Bearer ...' },
})
```

Tools: generic HTTP GET/POST/PUT/DELETE requests.

### Slack

```ts
import { createSlackConnector } from '@forgeagent/connectors'

const slack = createSlackConnector({
  token: 'xoxb-...',
})
```

Tools: send messages, list channels, reply to threads.

### Database

```ts
import { createDatabaseConnector } from '@forgeagent/connectors'

const db = createDatabaseConnector({
  connectionString: process.env.DATABASE_URL!,
  readOnly: true,
})
```

Tools: execute SQL queries, list tables, describe schema.

## API Reference

### Types

- `Connector` -- connector interface (`{ tools: DynamicStructuredTool[] }`)
- `ConnectorConfig` -- base config shared by all connectors
- `filterTools(tools, names)` -- filter a tool list to specific tool names

### Version

- `FORGEAGENT_CONNECTORS_VERSION: string` -- `'0.1.0'`

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@forgeagent/core` | `0.1.0` | Core infrastructure |

## Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@langchain/core` | `>=1.0.0` | Tool types |
| `zod` | `>=4.0.0` | Tool parameter schemas |

## License

MIT
