/**
 * VEC-020: Vector Search Benchmark Suite
 *
 * Evaluates vector search relevance and recall for common code search queries.
 */

import type { BenchmarkSuite } from '../benchmark-types.js';

export const VECTOR_SEARCH_SUITE: BenchmarkSuite = {
  id: 'vector-search',
  name: 'Vector Search Quality',
  description: 'Evaluates vector search relevance and recall',
  category: 'tool-use',
  dataset: [
    {
      id: 'vs-1',
      input: 'Find authentication related code',
      expectedOutput: 'auth middleware, JWT validation, login handler',
      tags: ['vector', 'relevance'],
    },
    {
      id: 'vs-2',
      input: 'Database migration patterns',
      expectedOutput: 'prisma migrate, schema changes, seed scripts',
      tags: ['vector', 'relevance'],
    },
    {
      id: 'vs-3',
      input: 'Error handling best practices',
      expectedOutput: 'try/catch, error boundary, ForgeError',
      tags: ['vector', 'relevance'],
    },
    {
      id: 'vs-4',
      input: 'API rate limiting',
      expectedOutput: 'rate limiter middleware, throttle, sliding window',
      tags: ['vector', 'relevance'],
    },
    {
      id: 'vs-5',
      input: 'WebSocket real-time events',
      expectedOutput: 'socket connection, event streaming, SSE',
      tags: ['vector', 'relevance'],
    },
    {
      id: 'vs-6',
      input: 'Memory consolidation strategies',
      expectedOutput: 'dedup, merge, prune, sleep consolidation',
      tags: ['vector', 'recall'],
    },
  ],
  scorers: [
    {
      id: 'keyword-overlap',
      name: 'Keyword Overlap',
      type: 'deterministic',
      threshold: 0.3,
    },
  ],
  baselineThresholds: {
    'keyword-overlap': 0.3,
  },
};
