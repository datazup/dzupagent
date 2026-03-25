/**
 * ECO-179: Tool Use Benchmark Suite
 *
 * Tests: single tool, multi-tool, tool selection, error recovery, complex chains.
 */

import type { BenchmarkSuite } from '../benchmark-types.js';

export const TOOL_USE_SUITE: BenchmarkSuite = {
  id: 'tool-use',
  name: 'Tool Use',
  description: 'Evaluates ability to select and use tools correctly in agent workflows',
  category: 'tool-use',
  dataset: [
    {
      id: 'tu-001',
      input: 'Read the contents of the file at /src/index.ts',
      expectedOutput: 'Use readFile tool with path /src/index.ts to read the file contents.',
      tags: ['single-tool', 'file-operations'],
      metadata: { availableTools: ['readFile', 'writeFile', 'listDir', 'search'] },
    },
    {
      id: 'tu-002',
      input: 'Find all TypeScript files that import the UserService class, then read the first matching file.',
      expectedOutput: 'First use search tool to find files importing UserService, then use readFile tool on the first result.',
      tags: ['multi-tool', 'search'],
      metadata: { availableTools: ['readFile', 'writeFile', 'search', 'listDir'] },
    },
    {
      id: 'tu-003',
      input: 'Create a new directory called utils and add a helpers.ts file with a formatDate function.',
      expectedOutput: 'Use createDir tool for utils directory, then writeFile tool to create utils/helpers.ts with formatDate function.',
      tags: ['multi-tool', 'file-operations'],
      metadata: { availableTools: ['readFile', 'writeFile', 'createDir', 'deleteFile'] },
    },
    {
      id: 'tu-004',
      input: 'The file at /src/config.ts has a syntax error. Read it, identify the error, and fix it.',
      expectedOutput: 'Use readFile tool to read /src/config.ts, analyze the syntax error, then use writeFile tool to save the corrected version.',
      tags: ['error-recovery', 'file-operations'],
      metadata: { availableTools: ['readFile', 'writeFile', 'runTypecheck'] },
    },
    {
      id: 'tu-005',
      input: 'Run the test suite, check for failures, read the failing test file, fix the issue, and re-run tests.',
      expectedOutput: 'Use runTests tool to execute tests, analyze failures, use readFile to read failing test, use writeFile to fix issue, then runTests again to verify.',
      tags: ['complex-chain', 'testing'],
      metadata: { availableTools: ['readFile', 'writeFile', 'runTests', 'runTypecheck'] },
    },
    {
      id: 'tu-006',
      input: 'You need to deploy the application. Choose between the deploy tool and the build tool. The application has not been built yet.',
      expectedOutput: 'Use build tool first since the application needs to be built before deployment. Then use deploy tool after build succeeds.',
      tags: ['tool-selection', 'deployment'],
      metadata: { availableTools: ['build', 'deploy', 'runTests', 'lint'] },
    },
  ],
  scorers: [
    {
      id: 'tool-selection',
      name: 'Tool Selection Accuracy',
      description: 'Checks if correct tools are mentioned',
      type: 'deterministic',
    },
    {
      id: 'tool-ordering',
      name: 'Tool Ordering',
      description: 'Checks if tools are used in correct order',
      type: 'deterministic',
    },
  ],
  baselineThresholds: {
    'tool-selection': 0.5,
    'tool-ordering': 0.4,
  },
};
