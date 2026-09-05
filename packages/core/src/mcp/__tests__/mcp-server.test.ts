import { describe, expect, it, vi } from "vitest";
import { DzupAgentMCPServer, isMCPRequest } from "../mcp-server.js";
import type { MCPExposedTool } from "../mcp-server.js";

describe("DzupAgentMCPServer", () => {
  it("supports the stateless current discovery and result contract without changing legacy initialize", async () => {
    const server = new DzupAgentMCPServer({
      name: "dual-stack-server",
      version: "2.0.0",
      protocolVersion: "2025-11-25",
      currentProtocol: { enabled: true },
      tools: [
        {
          name: "zeta",
          description: "Zeta tool",
          inputSchema: { type: "object", properties: {} },
          handler: async () => "ok",
        },
      ],
    });

    const legacy = await server.handleRequest({
      jsonrpc: "2.0",
      id: "legacy",
      method: "initialize",
    });
    expect(legacy).toEqual({
      jsonrpc: "2.0",
      id: "legacy",
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "dual-stack-server", version: "2.0.0" },
        capabilities: { tools: {} },
      },
    });

    const currentContext = { protocolVersion: "2026-07-28" };
    const discovery = await server.handleRequest(
      {
        jsonrpc: "2.0",
        id: "discover",
        method: "server/discover",
        params: {},
      },
      currentContext
    );
    expect(discovery).toEqual({
      jsonrpc: "2.0",
      id: "discover",
      result: {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        ttlMs: 0,
        cacheScope: "private",
        resultType: "complete",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "dual-stack-server",
            version: "2.0.0",
          },
        },
      },
    });

    const tools = await server.handleRequest(
      { jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} },
      currentContext
    );
    expect(tools).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          ttlMs: 0,
          cacheScope: "private",
          resultType: "complete",
        }),
      })
    );

    const initialize = await server.handleRequest(
      { jsonrpc: "2.0", id: "no-init", method: "initialize", params: {} },
      currentContext
    );
    expect(initialize).toEqual({
      jsonrpc: "2.0",
      id: "no-init",
      error: {
        code: -32601,
        message: "Unknown method: initialize",
        data: undefined,
      },
    });

    const removedPing = await server.handleRequest(
      { jsonrpc: "2.0", id: "no-ping", method: "ping" },
      currentContext
    );
    expect(removedPing).toEqual({
      jsonrpc: "2.0",
      id: "no-ping",
      error: {
        code: -32601,
        message: "Unknown method: ping",
        data: undefined,
      },
    });
  });

  it("advertises initialize capabilities for tools, resources, prompts, and sampling", async () => {
    const server = new DzupAgentMCPServer({
      name: "tooling-server",
      version: "1.2.3",
      tools: [
        {
          name: "echo",
          description: "Echo input",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          handler: async (args) => String(args["text"] ?? ""),
        },
      ],
      resources: [
        {
          uri: "memory://overview",
          name: "Overview",
          mimeType: "text/plain",
          read: async () => "Framework overview",
        },
      ],
      prompts: [
        {
          name: "review",
          description: "Review a change",
          arguments: [{ name: "diff", required: true }],
          get: async (args) => ({
            messages: [
              {
                role: "user",
                content: { type: "text", text: String(args["diff"] ?? "") },
              },
            ],
          }),
        },
      ],
      samplingHandler: async () => ({
        role: "assistant",
        content: { type: "text", text: "sampled" },
        model: "gpt-test",
      }),
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: {
          name: "tooling-server",
          version: "1.2.3",
        },
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          sampling: {},
        },
      },
    });
  });

  it("projects optional tool metadata without changing legacy descriptors", async () => {
    const inspectTool: MCPExposedTool = {
      name: "inspect",
      description: "Inspect deterministic state",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { disposition: { type: "string" } },
        required: ["disposition"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async () => "ok",
    };
    const server = new DzupAgentMCPServer({
      name: "metadata-server",
      version: "1.0.0",
      tools: [
        inspectTool,
        {
          name: "legacy",
          description: "Legacy tool",
          inputSchema: { type: "object", properties: {} },
          handler: async () => "ok",
        },
      ],
    });

    const expectedTools = [
      {
        name: "inspect",
        description: "Inspect deterministic state",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: {
          type: "object",
          properties: { disposition: { type: "string" } },
          required: ["disposition"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        serverId: "metadata-server",
      },
      {
        name: "legacy",
        description: "Legacy tool",
        inputSchema: { type: "object", properties: {} },
        serverId: "metadata-server",
      },
    ];

    expect(server.listTools()).toEqual(expectedTools);
    await expect(
      server.handleRequest({
        jsonrpc: "2.0",
        id: "metadata",
        method: "tools/list",
      })
    ).resolves.toEqual({
      jsonrpc: "2.0",
      id: "metadata",
      result: { tools: expectedTools },
    });
  });

  it("supports registering, listing, retrieving, and unregistering prompts", async () => {
    const server = new DzupAgentMCPServer({
      name: "prompt-server",
      version: "1.0.0",
    });

    server.registerPrompt({
      name: "commit-message",
      description: "Draft a commit message",
      arguments: [
        { name: "summary", description: "Change summary", required: true },
        { name: "scope", description: "Optional package scope" },
      ],
      get: async (args) => ({
        description: "Commit message prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Write a commit message for ${String(args["summary"])}`,
            },
          },
        ],
      }),
    });

    const listed = await server.handleRequest({
      jsonrpc: "2.0",
      id: "prompts",
      method: "prompts/list",
    });
    expect(listed).toEqual({
      jsonrpc: "2.0",
      id: "prompts",
      result: {
        prompts: [
          {
            name: "commit-message",
            description: "Draft a commit message",
            arguments: [
              {
                name: "summary",
                description: "Change summary",
                required: true,
              },
              { name: "scope", description: "Optional package scope" },
            ],
          },
        ],
      },
    });

    const retrieved = await server.handleRequest({
      jsonrpc: "2.0",
      id: "get-prompt",
      method: "prompts/get",
      params: {
        name: "commit-message",
        arguments: { summary: "MCP prompts support" },
      },
    });
    expect(retrieved).toEqual({
      jsonrpc: "2.0",
      id: "get-prompt",
      result: {
        description: "Commit message prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Write a commit message for MCP prompts support",
            },
          },
        ],
      },
    });

    server.unregisterPrompt("commit-message");
    expect(server.listPrompts()).toEqual([]);
  });

  it("supports resources/list, resources/templates/list, and resources/read", async () => {
    const server = new DzupAgentMCPServer({
      name: "resources-server",
      version: "1.0.0",
      resources: [
        {
          uri: "memory://overview",
          name: "Overview",
          mimeType: "text/plain",
          read: async () => ({
            uri: "memory://overview",
            text: "overview text",
          }),
        },
      ],
      resourceTemplates: [
        {
          uriTemplate: "project://{projectId}/report",
          name: "Project report",
          mimeType: "application/json",
          read: async (uri) => ({
            uri,
            mimeType: "application/json",
            text: '{"ok":true}',
          }),
        },
      ],
    });

    const listed = await server.handleRequest({
      jsonrpc: "2.0",
      id: "resources",
      method: "resources/list",
    });
    expect(listed).toEqual({
      jsonrpc: "2.0",
      id: "resources",
      result: {
        resources: [
          {
            uri: "memory://overview",
            name: "Overview",
            mimeType: "text/plain",
          },
        ],
      },
    });

    const templates = await server.handleRequest({
      jsonrpc: "2.0",
      id: "templates",
      method: "resources/templates/list",
    });
    expect(templates).toEqual({
      jsonrpc: "2.0",
      id: "templates",
      result: {
        resourceTemplates: [
          {
            uriTemplate: "project://{projectId}/report",
            name: "Project report",
            mimeType: "application/json",
          },
        ],
      },
    });

    const readDirect = await server.handleRequest({
      jsonrpc: "2.0",
      id: "read-direct",
      method: "resources/read",
      params: { uri: "memory://overview" },
    });
    expect(readDirect).toEqual({
      jsonrpc: "2.0",
      id: "read-direct",
      result: {
        contents: [
          {
            uri: "memory://overview",
            text: "overview text",
          },
        ],
      },
    });

    const readFromTemplate = await server.handleRequest({
      jsonrpc: "2.0",
      id: "read-template",
      method: "resources/read",
      params: { uri: "project://abc/report" },
    });
    expect(readFromTemplate).toEqual({
      jsonrpc: "2.0",
      id: "read-template",
      result: {
        contents: [
          {
            uri: "project://abc/report",
            mimeType: "application/json",
            text: '{"ok":true}',
          },
        ],
      },
    });
  });

  it("delegates sampling/createMessage when a sampling handler is configured", async () => {
    const samplingHandler = vi.fn(async () => ({
      role: "assistant" as const,
      content: { type: "text" as const, text: "sample reply" },
      model: "gpt-test",
      stopReason: "endTurn" as const,
    }));

    const server = new DzupAgentMCPServer({
      name: "sampling-server",
      version: "1.0.0",
      samplingHandler,
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "sampling/createMessage",
      params: {
        messages: [{ role: "user", content: { type: "text", text: "hello" } }],
        maxTokens: 64,
      },
    });

    expect(samplingHandler).toHaveBeenCalledWith({
      messages: [{ role: "user", content: { type: "text", text: "hello" } }],
      maxTokens: 64,
    });
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        role: "assistant",
        content: { type: "text", text: "sample reply" },
        model: "gpt-test",
        stopReason: "endTurn",
      },
    });
  });

  it("responds to ping with an empty result (MCP utility)", async () => {
    const server = new DzupAgentMCPServer({
      name: "ping-server",
      version: "1.0.0",
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "ping",
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {},
    });
  });

  it("returns null for notifications that omit an id while still executing the handler", async () => {
    const handler = vi.fn(async () => "ok");
    const server = new DzupAgentMCPServer({
      name: "notify-server",
      version: "1.0.0",
      tools: [
        {
          name: "echo",
          description: "Echo input",
          inputSchema: { type: "object", properties: {} },
          handler,
        },
      ],
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });

    expect(response).toBeNull();
    expect(handler).toHaveBeenCalledWith({ text: "hi" });
  });

  it("supports structured tool results and id:null requests", async () => {
    const server = new DzupAgentMCPServer({
      name: "structured-server",
      version: "1.0.0",
      tools: [
        {
          name: "inspect",
          description: "Return structured content",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({
            content: [
              {
                type: "resource",
                data: "memory://overview",
                mimeType: "text/uri-list",
              },
            ],
          }),
        },
      ],
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: null,
      method: "tools/call",
      params: { name: "inspect", arguments: {} },
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: null,
      result: {
        content: [
          {
            type: "resource",
            data: "memory://overview",
            mimeType: "text/uri-list",
          },
        ],
        isError: false,
      },
    });
  });

  it("preserves valid structured tool content exactly", async () => {
    const structuredContent = {
      disposition: "continue",
      attempts: 2,
      tags: ["safe", "local"],
      detail: { ready: true },
    };
    const server = new DzupAgentMCPServer({
      name: "structured-output-server",
      version: "1.0.0",
      tools: [
        {
          name: "inspect",
          description: "Inspect state",
          inputSchema: { type: "object", properties: {} },
          outputSchema: {
            type: "object",
            properties: {
              disposition: {
                type: "string",
                enum: ["continue", "wait"],
              },
              attempts: { type: "integer" },
              tags: { type: "array", items: { type: "string" } },
              detail: {
                type: "object",
                properties: { ready: { type: "boolean" } },
              },
            },
            required: ["disposition", "attempts", "tags", "detail"],
            additionalProperties: false,
          },
          handler: async () => ({
            content: [{ type: "text", text: "ready" }],
            structuredContent,
          }),
        },
      ],
    });

    await expect(
      server.handleRequest({
        jsonrpc: "2.0",
        id: "structured-output",
        method: "tools/call",
        params: { name: "inspect", arguments: {} },
      })
    ).resolves.toEqual({
      jsonrpc: "2.0",
      id: "structured-output",
      result: {
        content: [{ type: "text", text: "ready" }],
        structuredContent,
        isError: false,
      },
    });
  });

  it("keeps legacy string tool normalization unchanged", async () => {
    const server = new DzupAgentMCPServer({
      name: "legacy-output-server",
      version: "1.0.0",
      tools: [
        {
          name: "legacy",
          description: "Return text",
          inputSchema: { type: "object", properties: {} },
          handler: async () => "legacy result",
        },
      ],
    });

    await expect(
      server.handleRequest({
        jsonrpc: "2.0",
        id: "legacy-output",
        method: "tools/call",
        params: { name: "legacy", arguments: {} },
      })
    ).resolves.toEqual({
      jsonrpc: "2.0",
      id: "legacy-output",
      result: {
        content: [{ type: "text", text: "legacy result" }],
        isError: false,
      },
    });
  });

  it.each([
    ["missing required keys", {}],
    ["unknown keys", { disposition: "continue", leak: "do-not-echo" }],
    ["wrong primitive types", { disposition: 7 }],
    ["wrong enum values", { disposition: "execute" }],
  ])("rejects structured output with %s", async (_caseName, structuredContent) => {
    const server = new DzupAgentMCPServer({
      name: "schema-fence-server",
      version: "1.0.0",
      tools: [
        {
          name: "inspect",
          description: "Inspect state",
          inputSchema: { type: "object", properties: {} },
          outputSchema: {
            type: "object",
            properties: {
              disposition: {
                type: "string",
                enum: ["continue", "wait"],
              },
            },
            required: ["disposition"],
            additionalProperties: false,
          },
          handler: async () => ({
            content: [{ type: "text", text: "invalid" }],
            structuredContent,
          }),
        },
      ],
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: "invalid-output",
      method: "tools/call",
      params: { name: "inspect", arguments: {} },
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "invalid-output",
      error: {
        code: -32000,
        message: "MCP_OUTPUT_SCHEMA_MISMATCH",
        data: {
          toolName: "inspect",
          reasonCode: "MCP_OUTPUT_SCHEMA_MISMATCH",
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("do-not-echo");
  });

  it("rejects invalid array items under a declared output schema", async () => {
    const server = new DzupAgentMCPServer({
      name: "array-schema-server",
      version: "1.0.0",
      tools: [
        {
          name: "inspect",
          description: "Inspect state",
          inputSchema: { type: "object", properties: {} },
          outputSchema: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["tags"],
          },
          handler: async () => ({
            content: [],
            structuredContent: { tags: ["safe", 7] },
          }),
        },
      ],
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: "invalid-array-output",
      method: "tools/call",
      params: { name: "inspect", arguments: {} },
    });

    expect(response).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: -32000,
          message: "MCP_OUTPUT_SCHEMA_MISMATCH",
        }),
      })
    );
  });

  it("rejects unsupported output-schema keywords before listing a tool", () => {
    const outputSchema = {
      type: "object",
      properties: {
        disposition: { type: "string", minLength: 1 },
      },
    } as unknown as NonNullable<MCPExposedTool["outputSchema"]>;
    const server = new DzupAgentMCPServer({
      name: "unsupported-schema-server",
      version: "1.0.0",
      tools: [
        {
          name: "inspect",
          description: "Inspect state",
          inputSchema: { type: "object", properties: {} },
          outputSchema,
          handler: async () => "ok",
        },
      ],
    });

    expect(() => server.listTools()).toThrowError(
      "MCP_OUTPUT_SCHEMA_UNSUPPORTED"
    );
  });

  it("returns protocol errors for invalid requests and missing params", async () => {
    const server = new DzupAgentMCPServer({
      name: "errors-server",
      version: "1.0.0",
    });

    expect(isMCPRequest({ jsonrpc: "2.0", method: "tools/list" })).toBe(true);
    expect(isMCPRequest({ jsonrpc: "1.0", method: "tools/list" })).toBe(false);
    expect(
      isMCPRequest({ jsonrpc: "2.0", id: true, method: "tools/list" })
    ).toBe(false);
    expect(
      isMCPRequest({ jsonrpc: "2.0", method: "tools/list", params: "bad" })
    ).toBe(false);

    const invalidRequest = await server.handleRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "" as string,
    });
    expect(invalidRequest).toEqual({
      jsonrpc: "2.0",
      id: 10,
      error: {
        code: -32601,
        message: "Unknown method: ",
        data: undefined,
      },
    });

    const missingUri = await server.handleRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "resources/read",
      params: {},
    });
    expect(missingUri).toEqual({
      jsonrpc: "2.0",
      id: 11,
      error: {
        code: -32602,
        message: "Missing required param: uri",
        data: undefined,
      },
    });

    const unknownPrompt = await server.handleRequest({
      jsonrpc: "2.0",
      id: 12,
      method: "prompts/get",
      params: { name: "missing" },
    });
    expect(unknownPrompt).toEqual({
      jsonrpc: "2.0",
      id: 12,
      error: {
        code: -32601,
        message: "Prompt not found: missing",
        data: { availablePrompts: [] },
      },
    });

    const missingPromptName = await server.handleRequest({
      jsonrpc: "2.0",
      id: 13,
      method: "prompts/get",
      params: {},
    });
    expect(missingPromptName).toEqual({
      jsonrpc: "2.0",
      id: 13,
      error: {
        code: -32602,
        message: "Missing required param: name",
        data: undefined,
      },
    });

    server.registerPrompt({
      name: "existing",
      get: async () => ({
        messages: [{ role: "user", content: { type: "text", text: "ok" } }],
      }),
    });

    const invalidPromptArguments = await server.handleRequest({
      jsonrpc: "2.0",
      id: 14,
      method: "prompts/get",
      params: { name: "existing", arguments: "bad" },
    });
    expect(invalidPromptArguments).toEqual({
      jsonrpc: "2.0",
      id: 14,
      error: {
        code: -32602,
        message: "Invalid param: arguments",
        data: undefined,
      },
    });
  });
});
