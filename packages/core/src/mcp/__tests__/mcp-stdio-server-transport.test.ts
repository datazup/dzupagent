import { Readable, PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DzupAgentMCPServer, serveMCPOverStdio } from "../index.js";
import type {
  MCPStdioServerOptions,
  MCPStdioServerResult,
  MCPToolAnnotations,
  MCPToolOutputSchema,
} from "../index.js";

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function capture(stream: PassThrough): () => string {
  let value = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    value += chunk;
  });
  return () => value;
}

function parseFrames(value: string): unknown[] {
  return value
    .split("\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as unknown);
}

function createServer(
  handler: (args: Record<string, unknown>) => Promise<string> = async (args) =>
    String(args["value"] ?? "ok")
): DzupAgentMCPServer {
  return new DzupAgentMCPServer({
    name: "stdio-test-server",
    version: "1.0.0",
    tools: [
      {
        name: "echo",
        description: "Echo a value",
        inputSchema: { type: "object", properties: {} },
        handler,
      },
    ],
  });
}

describe("serveMCPOverStdio", () => {
  it("serves initialize, tools/list, and tools/call as newline JSON", async () => {
    const input = Readable.from([
      line({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      line({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      line({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { value: "hello" } },
      }),
    ]);
    const output = new PassThrough();
    const error = new PassThrough();
    const stdout = capture(output);
    const stderr = capture(error);

    await expect(
      serveMCPOverStdio(createServer(), { input, output, error })
    ).resolves.toEqual({
      framesRead: 3,
      responsesWritten: 3,
      exitReason: "eof",
    });

    expect(parseFrames(stdout())).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "stdio-test-server", version: "1.0.0" },
          capabilities: { tools: {} },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo a value",
              inputSchema: { type: "object", properties: {} },
              serverId: "stdio-test-server",
            },
          ],
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [{ type: "text", text: "hello" }],
          isError: false,
        },
      },
    ]);
    expect(stderr()).toBe("");
  });

  it("uses a fixed protocol version when requested", async () => {
    const input = Readable.from([
      line({ jsonrpc: "2.0", id: "discover", method: "server/discover" }),
    ]);
    const output = new PassThrough();
    const stdout = capture(output);
    const server = new DzupAgentMCPServer({
      name: "current-server",
      version: "1.0.0",
      currentProtocol: { enabled: true },
    });

    await serveMCPOverStdio(server, {
      input,
      output,
      error: new PassThrough(),
      protocolVersion: "2026-07-28",
    });

    expect(parseFrames(stdout())).toEqual([
      expect.objectContaining({
        id: "discover",
        result: expect.objectContaining({
          supportedVersions: ["2026-07-28"],
          resultType: "complete",
        }),
      }),
    ]);
  });

  it("returns bounded protocol errors for malformed, invalid, and blank frames", async () => {
    const input = Readable.from(["{\n", "[]\n", "\n"]);
    const output = new PassThrough();
    const stdout = capture(output);

    await expect(
      serveMCPOverStdio(createServer(), {
        input,
        output,
        error: new PassThrough(),
      })
    ).resolves.toEqual({
      framesRead: 3,
      responsesWritten: 3,
      exitReason: "eof",
    });
    expect(parseFrames(stdout())).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid MCP request" },
      },
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid MCP request" },
      },
    ]);
  });

  it("rejects an oversized frame before parsing or reflecting it", async () => {
    const secret = "do-not-reflect".repeat(20);
    const input = Readable.from([
      line({ jsonrpc: "2.0", id: 1, method: secret }),
    ]);
    const output = new PassThrough();
    const error = new PassThrough();
    const stdout = capture(output);
    const stderr = capture(error);

    await serveMCPOverStdio(createServer(), {
      input,
      output,
      error,
      maxFrameBytes: 64,
    });

    expect(parseFrames(stdout())).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "MCP input frame too large" },
      },
    ]);
    expect(stdout()).not.toContain(secret);
    expect(stderr()).toBe("");
  });

  it("executes notifications without writing a response", async () => {
    const handler = vi.fn(async () => "ok");
    const input = Readable.from([
      line({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "echo", arguments: { value: "notify" } },
      }),
    ]);
    const output = new PassThrough();
    const stdout = capture(output);

    await expect(
      serveMCPOverStdio(createServer(handler), {
        input,
        output,
        error: new PassThrough(),
      })
    ).resolves.toEqual({
      framesRead: 1,
      responsesWritten: 0,
      exitReason: "eof",
    });
    expect(handler).toHaveBeenCalledWith({ value: "notify" });
    expect(stdout()).toBe("");
  });

  it("dispatches frames serially", async () => {
    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const handler = async (args: Record<string, unknown>) => {
      const value = String(args["value"]);
      events.push(`start:${value}`);
      if (value === "first") {
        reportFirstStarted();
        await firstGate;
      }
      events.push(`end:${value}`);
      return value;
    };
    const input = Readable.from([
      line({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { value: "first" } },
      }),
      line({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { value: "second" } },
      }),
    ]);
    const output = new PassThrough();
    output.resume();

    const serving = serveMCPOverStdio(createServer(handler), {
      input,
      output,
      error: new PassThrough(),
    });
    await firstStarted;
    expect(events).toEqual(["start:first"]);
    releaseFirst();
    await serving;

    expect(events).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  it("waits for output backpressure before completing", async () => {
    const chunks: string[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        queueMicrotask(callback);
      },
    });
    const input = Readable.from([
      line({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ]);

    await expect(
      serveMCPOverStdio(createServer(), {
        input,
        output,
        error: new PassThrough(),
      })
    ).resolves.toEqual({
      framesRead: 1,
      responsesWritten: 1,
      exitReason: "eof",
    });
    expect(parseFrames(chunks.join(""))).toHaveLength(1);
  });

  it("returns input_error with one sanitized stderr diagnostic", async () => {
    const input = new Readable({
      read() {
        this.destroy(new Error("secret input detail"));
      },
    });
    const output = new PassThrough();
    const error = new PassThrough();
    const stdout = capture(output);
    const stderr = capture(error);

    await expect(
      serveMCPOverStdio(createServer(), { input, output, error })
    ).resolves.toEqual({
      framesRead: 0,
      responsesWritten: 0,
      exitReason: "input_error",
    });
    expect(stdout()).toBe("");
    expect(stderr()).toBe("MCP stdio input error\n");
  });

  it("returns output_error without writing diagnostics to stdout", async () => {
    const input = Readable.from([
      line({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ]);
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("secret output detail"));
      },
    });
    const error = new PassThrough();
    const stderr = capture(error);

    await expect(
      serveMCPOverStdio(createServer(), { input, output, error })
    ).resolves.toEqual({
      framesRead: 1,
      responsesWritten: 0,
      exitReason: "output_error",
    });
    expect(stderr()).toBe("MCP stdio output error\n");
    expect(stderr()).not.toContain("secret output detail");
  });

  it("ends only an injected output when explicitly requested", async () => {
    const input = Readable.from([]);
    const output = new PassThrough();
    output.resume();

    await serveMCPOverStdio(createServer(), {
      input,
      output,
      error: new PassThrough(),
      endOutput: true,
    });

    expect(output.writableEnded).toBe(true);
  });

  it("exposes the admitted runtime and type contracts through the MCP barrel", async () => {
    const annotations: MCPToolAnnotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    const outputSchema: MCPToolOutputSchema = {
      type: "object",
      properties: { disposition: { type: "string" } },
      required: ["disposition"],
      additionalProperties: false,
    };
    const server = new DzupAgentMCPServer({
      name: "barrel-server",
      version: "1.0.0",
      tools: [
        {
          name: "inspect",
          description: "Inspect state",
          inputSchema: { type: "object", properties: {} },
          annotations,
          outputSchema,
          handler: async () => ({
            content: [],
            structuredContent: { disposition: "continue" },
          }),
        },
      ],
    });
    const input = Readable.from([
      line({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ]);
    const output = new PassThrough();
    const stdout = capture(output);
    const options: MCPStdioServerOptions = {
      input,
      output,
      error: new PassThrough(),
    };
    const expectedResult: MCPStdioServerResult = {
      framesRead: 1,
      responsesWritten: 1,
      exitReason: "eof",
    };

    await expect(serveMCPOverStdio(server, options)).resolves.toEqual(
      expectedResult
    );
    expect(parseFrames(stdout())).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            {
              name: "inspect",
              description: "Inspect state",
              inputSchema: { type: "object", properties: {} },
              annotations,
              outputSchema,
              serverId: "barrel-server",
            },
          ],
        },
      },
    ]);
  });
});
