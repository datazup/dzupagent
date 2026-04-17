import { describe, bench } from 'vitest';

// Benchmark time-to-first-token (TTFT) for the streaming infrastructure.
// Measures async generator setup, ReadableStream, and SSE serialization overhead.

describe('Streaming latency (TTFT)', () => {
  bench('async generator first-yield latency', async () => {
    async function* gen() {
      yield { type: 'text', data: { content: 'hello' } };
      yield { type: 'done', data: {} };
    }

    const iter = gen();
    await iter.next(); // First token
  });

  bench('ReadableStream first chunk latency', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue('data: {"type":"text"}\n\n');
        controller.close();
      },
    });
    const reader = stream.getReader();
    await reader.read();
    reader.releaseLock();
  });

  bench('10-event async generator drain', async () => {
    async function* gen() {
      for (let i = 0; i < 10; i++) {
        yield { type: 'text', data: { content: `chunk-${i}` } };
      }
      yield { type: 'done', data: {} };
    }

    for await (const _ of gen()) {
      // drain
    }
  });

  bench('JSON.stringify + serialize 100 SSE chunks', () => {
    const chunks = Array.from({ length: 100 }, (_, i) => ({
      id: `chatcmpl-${i}`,
      object: 'chat.completion.chunk',
      choices: [
        { index: 0, delta: { content: `word-${i}` }, finish_reason: null },
      ],
    }));
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  });
});
