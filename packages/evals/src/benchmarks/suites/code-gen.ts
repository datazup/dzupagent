/**
 * ECO-179: Code Generation Benchmark Suite
 *
 * Tests: function generation, class creation, bug fix, refactor, test writing.
 */

import type { BenchmarkSuite } from '../benchmark-types.js';

export const CODE_GEN_SUITE: BenchmarkSuite = {
  id: 'code-gen',
  name: 'Code Generation',
  description: 'Evaluates code generation quality across common development tasks',
  category: 'code-gen',
  dataset: [
    {
      id: 'cg-001',
      input: 'Write a TypeScript function that takes an array of numbers and returns the sum of all even numbers.',
      expectedOutput: 'function sumEven(numbers: number[]): number { return numbers.filter(n => n % 2 === 0).reduce((sum, n) => sum + n, 0); }',
      tags: ['function', 'typescript', 'array'],
    },
    {
      id: 'cg-002',
      input: 'Create a TypeScript class called UserService with methods: create(name: string, email: string), findById(id: string), and delete(id: string). Use an in-memory Map for storage.',
      expectedOutput: 'class UserService { private users = new Map<string, { id: string; name: string; email: string }>(); create(name: string, email: string) { const id = crypto.randomUUID(); this.users.set(id, { id, name, email }); return id; } findById(id: string) { return this.users.get(id); } delete(id: string) { return this.users.delete(id); } }',
      tags: ['class', 'typescript', 'service'],
    },
    {
      id: 'cg-003',
      input: 'Fix this buggy function: function divide(a: number, b: number): number { return a / b; } — it should handle division by zero by throwing an Error.',
      expectedOutput: 'function divide(a: number, b: number): number { if (b === 0) throw new Error("Division by zero"); return a / b; }',
      tags: ['bugfix', 'typescript', 'error-handling'],
    },
    {
      id: 'cg-004',
      input: 'Refactor this code to use async/await instead of .then() chains: function fetchUser(id: string) { return fetch(`/api/users/${id}`).then(res => res.json()).then(data => data.user); }',
      expectedOutput: 'async function fetchUser(id: string) { const res = await fetch(`/api/users/${id}`); const data = await res.json(); return data.user; }',
      tags: ['refactor', 'typescript', 'async'],
    },
    {
      id: 'cg-005',
      input: 'Write a Vitest test suite for a function add(a: number, b: number): number that returns the sum of two numbers. Include tests for positive numbers, negative numbers, and zero.',
      expectedOutput: "import { describe, it, expect } from 'vitest'; describe('add', () => { it('should add positive numbers', () => { expect(add(2, 3)).toBe(5); }); it('should handle negative numbers', () => { expect(add(-1, -2)).toBe(-3); }); it('should handle zero', () => { expect(add(0, 5)).toBe(5); }); });",
      tags: ['test', 'vitest', 'typescript'],
    },
    {
      id: 'cg-006',
      input: 'Write a TypeScript generic function called filterByProperty that takes an array of objects, a property key, and a value, and returns all objects where that property equals the value.',
      expectedOutput: 'function filterByProperty<T>(items: T[], key: keyof T, value: T[keyof T]): T[] { return items.filter(item => item[key] === value); }',
      tags: ['function', 'typescript', 'generics'],
    },
  ],
  scorers: [
    {
      id: 'code-keyword',
      name: 'Code Keyword Match',
      description: 'Checks if output contains key code constructs',
      type: 'deterministic',
    },
    {
      id: 'code-completeness',
      name: 'Code Completeness',
      description: 'Checks if output appears to be complete code',
      type: 'deterministic',
    },
  ],
  baselineThresholds: {
    'code-keyword': 0.5,
    'code-completeness': 0.6,
  },
};
