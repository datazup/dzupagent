# 03 — MCP Integration

> **Gaps addressed**: G-01 (MCP integration — Critical)
> **Priority**: P0 — This is the #1 gap identified across ALL research documents

---

## 1. Why MCP Is Critical

Model Context Protocol is becoming the standard for tool interoperability:
- **Mastra**: Full MCP client + server, SSE/HTTP transports, toolset credential isolation
- **Gnana**: Dedicated `@gnana/mcp` package, unified with custom tools
- **Claude Code**: Uses MCP extensively, adds deferred tool loading when tools > 10% of context
- **Codex CLI**: Can itself run as an MCP server
- **Cursor/Windsurf**: MCP integration for tool extensibility

DzipAgent has **zero** MCP support. This blocks integration with 100+ MCP servers and prevents DzipAgent agents from being consumed by Claude Code, Cursor, etc.

---

## 2. Architecture Decision: Core Module, Not Separate Package

MCP integration lives in `core/src/mcp/` (not a separate `@dzipagent/mcp` package) because:
1. **Tool bridge** must integrate tightly with LangChain's `StructuredToolInterface`
2. **Deferred loading** requires access to token budget management
3. **Event bus** integration for connection lifecycle events
4. The MCP SDK itself (`@modelcontextprotocol/sdk`) is lightweight (~50KB)

---

## 3. Components

### 3.1 MCP Client — Connect to External Servers

```typescript
// core/src/mcp/mcp-client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;              // for stdio
  args?: string[];               // for stdio
  url?: string;                  // for sse/http
  env?: Record<string, string>;  // environment variables
  timeout?: number;              // connection timeout (ms)
}

export class ForgeMCPClient {
  private clients = new Map<string, Client>();
  private tools = new Map<string, MCPTool>();

  constructor(
    private eventBus: DzipEventBus,
    private config?: { maxToolsPerServer?: number }
  ) {}

  /** Connect to an MCP server and discover its tools */
  async connect(server: MCPServerConfig): Promise<MCPTool[]> {
    const transport = this.createTransport(server);
    const client = new Client({ name: 'forgeagent', version: '0.1.0' }, {});
    await client.connect(transport);

    const { tools } = await client.listTools();

    const mcpTools: MCPTool[] = tools.map(t => ({
      serverName: server.name,
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }));

    this.clients.set(server.name, client);
    for (const tool of mcpTools) {
      this.tools.set(`${server.name}__${tool.name}`, tool);
    }

    this.eventBus.emit({
      type: 'mcp:connected',
      serverName: server.name,
      toolCount: mcpTools.length,
    });

    return mcpTools;
  }

  /** Invoke a tool on a connected MCP server */
  async callTool(serverName: string, toolName: string, args: unknown): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) throw new ForgeError({
      code: 'MCP_CONNECTION_FAILED',
      message: `MCP server "${serverName}" not connected`,
      recoverable: true,
      suggestion: `Call connect() with server config for "${serverName}"`,
    });

    const result = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
    return typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);
  }

  /** Disconnect from an MCP server */
  async disconnect(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      await client.close();
      this.clients.delete(serverName);
      // Remove tools from this server
      for (const key of this.tools.keys()) {
        if (key.startsWith(`${serverName}__`)) this.tools.delete(key);
      }
      this.eventBus.emit({ type: 'mcp:disconnected', serverName });
    }
  }

  /** Get all discovered tools across all connected servers */
  getAllTools(): MCPTool[] {
    return [...this.tools.values()];
  }

  /** Disconnect from all servers */
  async disconnectAll(): Promise<void> {
    for (const name of this.clients.keys()) {
      await this.disconnect(name);
    }
  }

  private createTransport(server: MCPServerConfig) {
    switch (server.transport) {
      case 'stdio':
        return new StdioClientTransport({
          command: server.command!,
          args: server.args,
          env: server.env,
        });
      case 'sse':
        return new SSEClientTransport(new URL(server.url!));
      default:
        throw new ForgeError({
          code: 'INVALID_CONFIG',
          message: `Unsupported MCP transport: ${server.transport}`,
          recoverable: false,
        });
    }
  }
}
```

### 3.2 MCP Tool Bridge — MCP ↔ LangChain Conversion

```typescript
// core/src/mcp/mcp-tool-bridge.ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export function mcpToolToLangChain(
  mcpClient: ForgeMCPClient,
  tool: MCPTool
): DynamicStructuredTool {
  // Convert JSON Schema to Zod schema (simplified — use zod-to-json-schema inverse)
  const schema = jsonSchemaToZod(tool.inputSchema);

  return new DynamicStructuredTool({
    name: `mcp_${tool.serverName}_${tool.name}`,
    description: tool.description,
    schema,
    func: async (args) => {
      return mcpClient.callTool(tool.serverName, tool.name, args);
    },
  });
}

/** Convert all MCP tools to LangChain tools */
export function bridgeAllMCPTools(
  mcpClient: ForgeMCPClient
): DynamicStructuredTool[] {
  return mcpClient.getAllTools().map(t => mcpToolToLangChain(mcpClient, t));
}

/** Simple JSON Schema → Zod converter for common types */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  // Handle common JSON Schema types
  // For complex schemas, fall back to z.record(z.unknown())
  const type = schema['type'];
  if (type === 'object') {
    const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    const required = (schema['required'] ?? []) as string[];
    const shape: Record<string, z.ZodType> = {};
    for (const [key, prop] of Object.entries(properties)) {
      let field = jsonSchemaToZod(prop);
      if (!required.includes(key)) field = field.optional();
      shape[key] = field;
    }
    return z.object(shape);
  }
  if (type === 'string') return z.string();
  if (type === 'number' || type === 'integer') return z.number();
  if (type === 'boolean') return z.boolean();
  if (type === 'array') {
    const items = schema['items'] as Record<string, unknown> | undefined;
    return z.array(items ? jsonSchemaToZod(items) : z.unknown());
  }
  return z.unknown();
}
```

### 3.3 Deferred Tool Loading

```typescript
// core/src/mcp/deferred-loader.ts
/**
 * Claude Code pattern: When tool count exceeds a threshold (e.g., 10% of context),
 * load tool schemas lazily. Only the tool name + description are sent to the LLM;
 * the full input schema is fetched on demand when the LLM actually calls the tool.
 */
export class DeferredToolLoader {
  private fullSchemas = new Map<string, z.ZodType>();
  private loaded = new Set<string>();

  constructor(
    private threshold: number = 50,  // defer if > 50 tools
  ) {}

  shouldDefer(toolCount: number): boolean {
    return toolCount > this.threshold;
  }

  /** Create lightweight tool stubs (name + description only) */
  createStubs(tools: MCPTool[]): LightweightToolDef[] {
    for (const t of tools) {
      this.fullSchemas.set(`mcp_${t.serverName}_${t.name}`, jsonSchemaToZod(t.inputSchema));
    }
    return tools.map(t => ({
      name: `mcp_${t.serverName}_${t.name}`,
      description: t.description,
      // No inputSchema — saves context tokens
    }));
  }

  /** Resolve full schema when a tool is actually called */
  resolveSchema(toolName: string): z.ZodType | undefined {
    return this.fullSchemas.get(toolName);
  }
}
```

### 3.4 MCP Server — Expose Agents as MCP Tools

```typescript
// core/src/mcp/mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface MCPServerOptions {
  name: string;
  version: string;
  agents: Array<{
    agent: DzipAgent;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  transport?: 'stdio' | 'sse';
}

export class ForgeMCPServer {
  private server: Server;

  constructor(private options: MCPServerOptions) {
    this.server = new Server(
      { name: options.name, version: options.version },
      { capabilities: { tools: {} } }
    );

    this.registerTools();
  }

  private registerTools(): void {
    // List tools handler
    this.server.setRequestHandler('tools/list', async () => ({
      tools: this.options.agents.map(a => ({
        name: a.agent.id,
        description: a.description,
        inputSchema: a.inputSchema,
      })),
    }));

    // Call tool handler
    this.server.setRequestHandler('tools/call', async (request) => {
      const agentEntry = this.options.agents.find(a => a.agent.id === request.params.name);
      if (!agentEntry) throw new Error(`Agent not found: ${request.params.name}`);

      const result = await agentEntry.agent.generate([
        { role: 'user', content: JSON.stringify(request.params.arguments) },
      ]);

      return { content: [{ type: 'text', text: result }] };
    });
  }

  async start(): Promise<void> {
    const transport = this.options.transport === 'sse'
      ? new SSEServerTransport('/mcp', ...)
      : new StdioServerTransport();
    await this.server.connect(transport);
  }

  async stop(): Promise<void> {
    await this.server.close();
  }
}
```

---

## 4. Usage Examples

### Consuming External MCP Servers

```typescript
import { ForgeMCPClient, bridgeAllMCPTools } from '@dzipagent/core';

const mcpClient = new ForgeMCPClient(eventBus);

// Connect to filesystem MCP server
await mcpClient.connect({
  name: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
});

// Connect to GitHub MCP server
await mcpClient.connect({
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
});

// Bridge all MCP tools to LangChain
const mcpTools = bridgeAllMCPTools(mcpClient);

// Create agent with both custom and MCP tools
const agent = new DzipAgent({
  id: 'code-reviewer',
  instructions: 'Review code for quality...',
  model: 'codegen',
  tools: [
    ...mcpTools,             // MCP tools: mcp_filesystem_read_file, mcp_github_create_issue, etc.
    writeFileTool,           // Custom tool
    editFileTool,            // Custom tool
  ],
});
```

### Exposing Agents as MCP Server

```typescript
import { ForgeMCPServer } from '@dzipagent/core';

const mcpServer = new ForgeMCPServer({
  name: 'forgeagent',
  version: '0.1.0',
  agents: [
    {
      agent: codeReviewAgent,
      description: 'Review code for TypeScript quality, security, and best practices',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Code to review' },
          language: { type: 'string', description: 'Programming language' },
        },
        required: ['code'],
      },
    },
  ],
  transport: 'stdio',
});

await mcpServer.start();
// Now Claude Code, Cursor, etc. can use this agent as a tool
```

---

## 5. New Dependencies

```json
{
  "peerDependencies": {
    "@modelcontextprotocol/sdk": ">=1.0.0"
  }
}
```

The MCP SDK is the only new dependency. It's lightweight and maintained by Anthropic.

---

## 6. Implementation Estimates

| Component | File | ~LOC | Priority |
|-----------|------|------|----------|
| MCP Client | `mcp-client.ts` | 150 | P0 |
| MCP Tool Bridge | `mcp-tool-bridge.ts` | 100 | P0 |
| Deferred Tool Loader | `deferred-loader.ts` | 60 | P1 |
| MCP Server | `mcp-server.ts` | 120 | P1 |
| Types | `mcp-types.ts` | 30 | P0 |
| Index | `index.ts` | 10 | P0 |
| **Total** | **6 files** | **~470 LOC** | |
