/**
 * ECO-179: Q&A Benchmark Suite
 *
 * Tests: factual Q&A, reasoning, summarization, comparison, explanation.
 */

import type { BenchmarkSuite } from '../benchmark-types.js';

export const QA_SUITE: BenchmarkSuite = {
  id: 'qa',
  name: 'Question & Answer',
  description: 'Evaluates quality of responses across factual, reasoning, and explanatory tasks',
  category: 'qa',
  dataset: [
    {
      id: 'qa-001',
      input: 'What is the difference between TypeScript interfaces and type aliases?',
      expectedOutput: 'Interfaces support declaration merging and can be extended with extends keyword. Type aliases support union and intersection types, mapped types, and conditional types. Interfaces are generally preferred for object shapes while type aliases are more versatile for complex types.',
      tags: ['factual', 'typescript'],
    },
    {
      id: 'qa-002',
      input: 'A developer has a function that takes O(n^2) time. They need to process 1 million items. Is this feasible? Explain your reasoning.',
      expectedOutput: 'Processing 1 million items with O(n^2) complexity means approximately 10^12 operations. At roughly 10^9 operations per second, this would take about 1000 seconds or roughly 16 minutes. This is likely too slow for most use cases. Consider optimizing to O(n log n) or O(n) if possible.',
      tags: ['reasoning', 'complexity'],
    },
    {
      id: 'qa-003',
      input: 'Summarize the key benefits of using a monorepo for a full-stack TypeScript project.',
      expectedOutput: 'Monorepos enable shared TypeScript types between frontend and backend, unified dependency management, atomic commits across packages, simplified CI/CD configuration, and consistent tooling. They also facilitate code reuse through shared packages and make refactoring across package boundaries easier.',
      tags: ['summarization', 'architecture'],
    },
    {
      id: 'qa-004',
      input: 'Compare REST APIs and GraphQL. When would you choose one over the other?',
      expectedOutput: 'REST is simpler with well-defined HTTP methods and caching. GraphQL avoids over-fetching and under-fetching with flexible queries. Choose REST for simple CRUD APIs, public APIs, and when HTTP caching is important. Choose GraphQL for complex data relationships, mobile apps with bandwidth concerns, and rapidly evolving frontends.',
      tags: ['comparison', 'api-design'],
    },
    {
      id: 'qa-005',
      input: 'Explain how JavaScript closures work and provide a practical example.',
      expectedOutput: 'A closure is a function that retains access to variables from its outer lexical scope even after the outer function has returned. This works because JavaScript functions carry a reference to their creation environment. Practical example: a counter function that returns increment/decrement functions sharing a private count variable.',
      tags: ['explanation', 'javascript'],
    },
    {
      id: 'qa-006',
      input: 'What are the SOLID principles in software engineering? List each one briefly.',
      expectedOutput: 'Single Responsibility: a class should have one reason to change. Open-Closed: open for extension, closed for modification. Liskov Substitution: subtypes must be substitutable for base types. Interface Segregation: prefer small, specific interfaces. Dependency Inversion: depend on abstractions, not concretions.',
      tags: ['factual', 'design-patterns'],
    },
  ],
  scorers: [
    {
      id: 'qa-relevance',
      name: 'Answer Relevance',
      description: 'Checks keyword overlap with expected answer',
      type: 'deterministic',
    },
    {
      id: 'qa-completeness',
      name: 'Answer Completeness',
      description: 'Checks if answer covers key concepts',
      type: 'deterministic',
    },
  ],
  baselineThresholds: {
    'qa-relevance': 0.4,
    'qa-completeness': 0.5,
  },
};
