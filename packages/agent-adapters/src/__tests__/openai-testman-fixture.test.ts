import { describe, expect, it, vi } from "vitest";
import { OpenAIAdapter } from "../openai/openai-adapter.js";

// Testman's proposed first model is a snapshot, not the moving gpt-4o-mini alias.
// This fixture characterizes this adapter's wire behavior; it never contacts OpenAI.
const MODEL = "gpt-4o-mini-2024-07-18";
const encoder = new TextEncoder();

describe("Testman OpenAI adapter connector fixture", () => {
  it("delivers upstream text chunks before completion on the selected snapshot", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const adapter = new OpenAIAdapter({ apiKey: "fixture-key", fetchImpl });
    const events = adapter.execute({ prompt: "fixture", options: { model: MODEL } });

    expect((await events.next()).value).toMatchObject({ type: "adapter:started", model: MODEL });
    const first = events.next();
    stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"one"}}]}\n'));
    expect((await first).value).toMatchObject({ type: "adapter:stream_delta", content: "one" });

    const second = events.next();
    stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" two"}}]}\n'));
    expect((await second).value).toMatchObject({ type: "adapter:stream_delta", content: " two" });

    const complete = events.next();
    stream.enqueue(encoder.encode('data: [DONE]\n'));
    stream.close();
    expect((await complete).value).toMatchObject({ type: "adapter:completed", result: "one two" });
    expect((await events.next()).done).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({ model: MODEL, stream: true });
    expect(adapter.getCapabilities().supportsStreaming).toBe(true);
  });

  it("hands off a fragmented tool call but cannot execute or continue the tool turn", async () => {
    const lines = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "lookup", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"id":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const wire = lines.map(line => `data: ${JSON.stringify(line)}\n`).join("") + "data: [DONE]\n";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(wire)); controller.close(); },
    })));
    const adapter = new OpenAIAdapter({ apiKey: "fixture-key", fetchImpl });
    const observed = [];
    for await (const event of adapter.execute({
      prompt: "lookup a",
      options: { model: MODEL, tools: [{ name: "lookup", parameters: { type: "object" } }] },
    })) observed.push(event);

    expect(observed.map(event => event.type)).toEqual([
      "adapter:started", "adapter:tool_call", "adapter:completed",
    ]);
    expect(observed[1]).toMatchObject({
      type: "adapter:tool_call", toolName: "lookup", toolCallId: "call_fixture", input: { id: "a" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({ model: MODEL, stream: true });
    expect(request["tools"]).toEqual([{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }]);
    expect(adapter.getCapabilities()).toMatchObject({ emitsToolCalls: true, executesToolLoop: false });
  });
});
