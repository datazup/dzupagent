/**
 * ECO-179: Multi-Turn Benchmark Suite
 *
 * Tests: clarification, context retention, topic switch, correction acceptance, multi-step task.
 */

import type { BenchmarkSuite } from '../benchmark-types.js';

export const MULTI_TURN_SUITE: BenchmarkSuite = {
  id: 'multi-turn',
  name: 'Multi-Turn Conversation',
  description: 'Evaluates multi-turn conversation capabilities including context retention and correction handling',
  category: 'multi-turn',
  dataset: [
    {
      id: 'mt-001',
      input: 'User: Create a user login function. Assistant: What authentication method do you want? User: Use JWT tokens with bcrypt for passwords.',
      expectedOutput: 'The response should implement a login function using JWT tokens for session management and bcrypt for password hashing, addressing the clarification about authentication method.',
      tags: ['clarification', 'authentication'],
      metadata: { turns: 3 },
    },
    {
      id: 'mt-002',
      input: 'User: We are building a REST API with Express. [...] User: Now add error handling middleware to the API we discussed.',
      expectedOutput: 'The response should reference the Express REST API context from earlier turns and add appropriate error handling middleware that integrates with the existing Express setup.',
      tags: ['context-retention', 'express'],
      metadata: { turns: 2 },
    },
    {
      id: 'mt-003',
      input: 'User: Help me set up a PostgreSQL database. [...] User: Actually, let us switch to talking about frontend testing with Vitest.',
      expectedOutput: 'The response should smoothly transition to discussing Vitest frontend testing, acknowledging the topic switch away from PostgreSQL database setup.',
      tags: ['topic-switch', 'testing'],
      metadata: { turns: 2 },
    },
    {
      id: 'mt-004',
      input: 'User: Sort this array in ascending order. Assistant: Here is descending sort code. User: No, I said ascending order, not descending.',
      expectedOutput: 'The response should acknowledge the correction, apologize for the error, and provide the correct ascending sort implementation.',
      tags: ['correction-acceptance', 'sorting'],
      metadata: { turns: 3 },
    },
    {
      id: 'mt-005',
      input: 'User: I need to build a full CRUD API. Step 1: Set up the Express server. Step 2: Create the database schema. Step 3: Implement the routes. Let us start with step 1.',
      expectedOutput: 'The response should focus on step 1 (Express server setup) while acknowledging the overall multi-step plan for the CRUD API, setting up context for subsequent steps.',
      tags: ['multi-step', 'planning'],
      metadata: { turns: 1, totalSteps: 3 },
    },
    {
      id: 'mt-006',
      input: 'User: Create a React component for a todo list. [...] User: Now add the ability to mark items as complete. [...] User: Also add a delete button for each item.',
      expectedOutput: 'The response should build on the existing todo list component from previous turns, adding both the complete toggle and delete button features while preserving the original structure.',
      tags: ['context-retention', 'incremental-building'],
      metadata: { turns: 3 },
    },
  ],
  scorers: [
    {
      id: 'context-awareness',
      name: 'Context Awareness',
      description: 'Checks if response demonstrates awareness of conversation context',
      type: 'deterministic',
    },
    {
      id: 'instruction-following',
      name: 'Instruction Following',
      description: 'Checks if response follows the most recent instruction',
      type: 'deterministic',
    },
  ],
  baselineThresholds: {
    'context-awareness': 0.4,
    'instruction-following': 0.5,
  },
};
