import { describe, bench, beforeAll } from 'vitest';
import { Hono } from 'hono';

// Benchmark pure Hono routing throughput without hitting real databases.
// This measures framework overhead only.

describe('Server route throughput', () => {
  let app: Hono;

  beforeAll(() => {
    app = new Hono();
    app.get('/health', (c) => c.json({ status: 'ok' }));
    app.get('/ready', (c) => c.json({ ready: true }));
    app.post('/v1/chat/completions', async (c) => {
      const body = await c.req.json();
      return c.json({ id: 'chatcmpl-1', model: body.model, choices: [] });
    });
  });

  bench('GET /health (no-op handler)', async () => {
    const req = new Request('http://localhost/health');
    await app.fetch(req);
  });

  bench('GET /ready (no-op handler)', async () => {
    const req = new Request('http://localhost/ready');
    await app.fetch(req);
  });

  bench('POST /v1/chat/completions (parse + respond)', async () => {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-agent',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    await app.fetch(req);
  });

  bench('10 concurrent GET /health', async () => {
    const reqs = Array.from({ length: 10 }, () =>
      app.fetch(new Request('http://localhost/health')),
    );
    await Promise.all(reqs);
  });
});
