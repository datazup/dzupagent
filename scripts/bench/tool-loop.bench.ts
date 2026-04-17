import { describe, bench } from 'vitest';

// Benchmark tool dispatch overhead without actual LLM calls.
// Measures invocation, parallelism, accumulation, and argument parsing.

describe('Tool loop dispatch', () => {
  const noopTool = {
    name: 'noop',
    description: 'Does nothing',
    invoke: async (_input: unknown) => ({ result: 'ok' }),
  };

  bench('single tool invocation', async () => {
    await noopTool.invoke({});
  });

  bench('10 sequential tool invocations', async () => {
    for (let i = 0; i < 10; i++) {
      await noopTool.invoke({ i });
    }
  });

  bench('10 parallel tool invocations', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => noopTool.invoke({ i })),
    );
  });

  bench('tool result accumulation (100 results)', () => {
    const results: unknown[] = [];
    for (let i = 0; i < 100; i++) {
      results.push({ tool: 'noop', result: `result-${i}`, index: i });
    }
  });

  bench('JSON parse tool arguments (100 calls)', () => {
    const args = JSON.stringify({
      query: 'test search query',
      limit: 10,
      offset: 0,
    });
    for (let i = 0; i < 100; i++) {
      JSON.parse(args);
    }
  });
});
