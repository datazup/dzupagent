import { describe, bench } from 'vitest';

// Benchmark memory-related operations: Map CRUD, Array filtering,
// JSON round-trip, and micro-task overhead.

describe('Memory footprint', () => {
  bench('Map CRUD (1000 entries)', () => {
    const map = new Map<string, unknown>();
    for (let i = 0; i < 1000; i++) {
      map.set(`key-${i}`, { id: i, data: 'payload' });
    }
    for (let i = 0; i < 1000; i++) {
      map.get(`key-${i}`);
    }
    map.clear();
  });

  bench('Array push + filter (1000 elements)', () => {
    const arr: Array<{ id: number; active: boolean }> = [];
    for (let i = 0; i < 1000; i++) {
      arr.push({ id: i, active: i % 2 === 0 });
    }
    arr.filter((x) => x.active);
  });

  bench('JSON round-trip (agent config object)', () => {
    const config = {
      id: 'agent-123',
      name: 'Test Agent',
      instructions: 'You are a helpful assistant.',
      model: 'claude-sonnet-4-6',
      tools: Array.from({ length: 10 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool number ${i}`,
        schema: {
          type: 'object',
          properties: { input: { type: 'string' } },
        },
      })),
    };
    const serialized = JSON.stringify(config);
    JSON.parse(serialized);
  });

  bench('Promise.all 50 micro-tasks', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve({ index: i, result: 'ok' }),
      ),
    );
  });
});
