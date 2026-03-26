/**
 * Self-Correction Benchmark Suite
 *
 * Tests whether the self-correction pipeline can detect and fix known bugs.
 * Each scenario contains buggy code, a description of the bug, the expected
 * error pattern, and the corrected reference code.
 */

import type { BenchmarkSuite } from '../benchmark-types.js';

/**
 * Category of correction scenario.
 */
export type CorrectionCategory =
  | 'import_error'
  | 'type_error'
  | 'security_violation'
  | 'missing_validation'
  | 'test_failure'
  | 'lint_error'
  | 'logic_error';

/**
 * A single self-correction scenario with buggy and correct code.
 */
export interface CorrectionScenario {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Bug category */
  category: CorrectionCategory;
  /** The buggy code */
  buggyCode: string;
  /** Description of what is wrong */
  bugDescription: string;
  /** The correct code (reference for scoring) */
  correctCode: string;
  /** Expected error message pattern */
  expectedError: string;
  /** Difficulty: how hard to fix (1-5) */
  difficulty: number;
}

/**
 * Built-in correction scenarios covering all 7 categories.
 */
export const CORRECTION_SCENARIOS: CorrectionScenario[] = [
  // --- import_error ---
  {
    id: 'sc-001',
    name: 'import_missing_extension',
    category: 'import_error',
    buggyCode: `import { formatDate } from './utils';
import { UserService } from './services/user';

export function greet(name: string): string {
  return \`Hello \${name}, today is \${formatDate(new Date())}\`;
}`,
    bugDescription:
      'ESM imports require explicit .js file extensions. Both imports are missing the .js extension.',
    correctCode: `import { formatDate } from './utils.js';
import { UserService } from './services/user.js';

export function greet(name: string): string {
  return \`Hello \${name}, today is \${formatDate(new Date())}\`;
}`,
    expectedError: 'Cannot find module',
    difficulty: 1,
  },

  // --- type_error ---
  {
    id: 'sc-002',
    name: 'type_any_usage',
    category: 'type_error',
    buggyCode: `export function processUserData(data: any): any {
  const name = data.name;
  const age = data.age;
  return { name, age, isAdult: age >= 18 };
}`,
    bugDescription:
      'Function uses "any" for both parameter and return type. Should use a proper interface for type safety.',
    correctCode: `export interface UserData {
  name: string;
  age: number;
}

export interface ProcessedUser {
  name: string;
  age: number;
  isAdult: boolean;
}

export function processUserData(data: UserData): ProcessedUser {
  const name = data.name;
  const age = data.age;
  return { name, age, isAdult: age >= 18 };
}`,
    expectedError: 'Unexpected any',
    difficulty: 2,
  },

  // --- security_violation ---
  {
    id: 'sc-003',
    name: 'security_hardcoded_secret',
    category: 'security_violation',
    buggyCode: `const API_KEY = 'sk-ant-abc123secret456key789';
const DB_PASSWORD = 'super_secret_password';

export async function fetchData(endpoint: string): Promise<unknown> {
  const res = await fetch(endpoint, {
    headers: { Authorization: \`Bearer \${API_KEY}\` },
  });
  return res.json();
}`,
    bugDescription:
      'API key and database password are hardcoded as string literals. They must come from environment variables.',
    correctCode: `const API_KEY = process.env['API_KEY'];
const DB_PASSWORD = process.env['DB_PASSWORD'];

export async function fetchData(endpoint: string): Promise<unknown> {
  if (!API_KEY) {
    throw new Error('API_KEY environment variable is not set');
  }
  const res = await fetch(endpoint, {
    headers: { Authorization: \`Bearer \${API_KEY}\` },
  });
  return res.json();
}`,
    expectedError: 'hardcoded secret',
    difficulty: 2,
  },

  // --- missing_validation ---
  {
    id: 'sc-004',
    name: 'missing_zod_validation',
    category: 'missing_validation',
    buggyCode: `import { Router } from 'express';

const router = Router();

router.post('/users', (req, res) => {
  const { name, email, age } = req.body;
  // Directly use unvalidated input
  const user = { name, email, age };
  res.json({ success: true, user });
});

export default router;`,
    bugDescription:
      'Express route handler uses req.body directly without any input validation. Should use Zod schema validation.',
    correctCode: `import { Router } from 'express';
import { z } from 'zod';

const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
});

const router = Router();

router.post('/users', (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.issues });
    return;
  }
  const user = parsed.data;
  res.json({ success: true, user });
});

export default router;`,
    expectedError: 'unvalidated input',
    difficulty: 3,
  },

  // --- test_failure ---
  {
    id: 'sc-005',
    name: 'test_assertion_wrong',
    category: 'test_failure',
    buggyCode: `import { describe, it, expect } from 'vitest';

function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

describe('fibonacci', () => {
  it('should return 0 for n=0', () => {
    expect(fibonacci(0)).toBe(0);
  });

  it('should return 1 for n=1', () => {
    expect(fibonacci(1)).toBe(1);
  });

  it('should return 8 for n=6', () => {
    expect(fibonacci(6)).toBe(13);
  });

  it('should return 21 for n=8', () => {
    expect(fibonacci(8)).toBe(34);
  });
});`,
    bugDescription:
      'Two test assertions have wrong expected values. fibonacci(6) is 8 not 13, and fibonacci(8) is 21 not 34.',
    correctCode: `import { describe, it, expect } from 'vitest';

function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

describe('fibonacci', () => {
  it('should return 0 for n=0', () => {
    expect(fibonacci(0)).toBe(0);
  });

  it('should return 1 for n=1', () => {
    expect(fibonacci(1)).toBe(1);
  });

  it('should return 8 for n=6', () => {
    expect(fibonacci(6)).toBe(8);
  });

  it('should return 21 for n=8', () => {
    expect(fibonacci(8)).toBe(21);
  });
});`,
    expectedError: 'Expected 13 but received 8',
    difficulty: 1,
  },

  // --- lint_error ---
  {
    id: 'sc-006',
    name: 'lint_console_log',
    category: 'lint_error',
    buggyCode: `export class PaymentService {
  async processPayment(amount: number, currency: string): Promise<boolean> {
    console.log('Processing payment:', amount, currency);
    const result = await this.chargeCard(amount, currency);
    console.log('Payment result:', result);
    if (!result.success) {
      console.error('Payment failed:', result.error);
      return false;
    }
    console.log('Payment succeeded');
    return true;
  }

  private async chargeCard(amount: number, currency: string): Promise<{ success: boolean; error?: string }> {
    console.log('Charging card...');
    return { success: amount > 0 };
  }
}`,
    bugDescription:
      'Production code contains console.log and console.error statements. Should use a proper logger or remove them.',
    correctCode: `import type { Logger } from './logger.js';

export class PaymentService {
  constructor(private readonly logger: Logger) {}

  async processPayment(amount: number, currency: string): Promise<boolean> {
    this.logger.info('Processing payment', { amount, currency });
    const result = await this.chargeCard(amount, currency);
    if (!result.success) {
      this.logger.error('Payment failed', { error: result.error });
      return false;
    }
    this.logger.info('Payment succeeded');
    return true;
  }

  private async chargeCard(amount: number, currency: string): Promise<{ success: boolean; error?: string }> {
    this.logger.debug('Charging card', { amount, currency });
    return { success: amount > 0 };
  }
}`,
    expectedError: 'no-console',
    difficulty: 3,
  },

  // --- logic_error ---
  {
    id: 'sc-007',
    name: 'logic_off_by_one',
    category: 'logic_error',
    buggyCode: `export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize;
  const end = start + pageSize + 1;
  return items.slice(start, end);
}

export function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}`,
    bugDescription:
      'paginate() has off-by-one in end index (should not add 1). findLastIndex() starts at arr.length instead of arr.length - 1, accessing undefined element.',
    correctCode: `export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize;
  const end = start + pageSize;
  return items.slice(start, end);
}

export function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}`,
    expectedError: 'off-by-one',
    difficulty: 2,
  },

  // --- logic_error (another) ---
  {
    id: 'sc-008',
    name: 'missing_error_handling',
    category: 'logic_error',
    buggyCode: `export async function fetchUserProfile(userId: string): Promise<{ name: string; email: string }> {
  const response = await fetch(\`https://api.example.com/users/\${userId}\`);
  const data = await response.json();
  return { name: data.name, email: data.email };
}`,
    bugDescription:
      'Async function has no error handling. Missing try/catch, no response status check, and no handling of JSON parse failures.',
    correctCode: `export async function fetchUserProfile(userId: string): Promise<{ name: string; email: string }> {
  let response: Response;
  try {
    response = await fetch(\`https://api.example.com/users/\${userId}\`);
  } catch (error) {
    throw new Error(\`Network error fetching user \${userId}: \${String(error)}\`);
  }

  if (!response.ok) {
    throw new Error(\`HTTP \${response.status} fetching user \${userId}\`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(\`Invalid JSON response for user \${userId}\`);
  }

  const record = data as Record<string, unknown>;
  if (typeof record['name'] !== 'string' || typeof record['email'] !== 'string') {
    throw new Error(\`Invalid user data shape for user \${userId}\`);
  }

  return { name: record['name'], email: record['email'] };
}`,
    expectedError: 'unhandled promise rejection',
    difficulty: 3,
  },

  // --- security_violation ---
  {
    id: 'sc-009',
    name: 'sql_injection',
    category: 'security_violation',
    buggyCode: `import type { Pool } from 'pg';

export async function findUser(pool: Pool, username: string): Promise<unknown> {
  const query = \`SELECT * FROM users WHERE username = '\${username}'\`;
  const result = await pool.query(query);
  return result.rows[0];
}

export async function deleteUser(pool: Pool, id: string): Promise<void> {
  await pool.query(\`DELETE FROM users WHERE id = \${id}\`);
}`,
    bugDescription:
      'SQL queries use string interpolation, allowing SQL injection. Must use parameterized queries ($1, $2, etc.).',
    correctCode: `import type { Pool } from 'pg';

export async function findUser(pool: Pool, username: string): Promise<unknown> {
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0];
}

export async function deleteUser(pool: Pool, id: string): Promise<void> {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}`,
    expectedError: 'SQL injection',
    difficulty: 2,
  },

  // --- type_error ---
  {
    id: 'sc-010',
    name: 'missing_null_check',
    category: 'type_error',
    buggyCode: `interface Config {
  database?: {
    host?: string;
    port?: number;
    credentials?: {
      username: string;
      password: string;
    };
  };
}

export function getConnectionString(config: Config): string {
  const host = config.database.host;
  const port = config.database.port;
  const user = config.database.credentials.username;
  const pass = config.database.credentials.password;
  return \`postgres://\${user}:\${pass}@\${host}:\${port}/app\`;
}`,
    bugDescription:
      'Property accesses on optional fields without null checks. config.database, config.database.host, etc. may all be undefined.',
    correctCode: `interface Config {
  database?: {
    host?: string;
    port?: number;
    credentials?: {
      username: string;
      password: string;
    };
  };
}

export function getConnectionString(config: Config): string {
  const host = config.database?.host ?? 'localhost';
  const port = config.database?.port ?? 5432;
  const user = config.database?.credentials?.username ?? 'postgres';
  const pass = config.database?.credentials?.password ?? '';
  return \`postgres://\${user}:\${pass}@\${host}:\${port}/app\`;
}`,
    expectedError: 'possibly undefined',
    difficulty: 2,
  },

  // --- missing_validation ---
  {
    id: 'sc-011',
    name: 'missing_bounds_check',
    category: 'missing_validation',
    buggyCode: `export function getElement<T>(arr: T[], index: number): T {
  return arr[index]!;
}

export function setElement<T>(arr: T[], index: number, value: T): void {
  arr[index] = value;
}`,
    bugDescription:
      'Array access without bounds checking. Negative indices and out-of-range indices are not validated.',
    correctCode: `export function getElement<T>(arr: T[], index: number): T {
  if (index < 0 || index >= arr.length) {
    throw new RangeError(\`Index \${index} out of bounds for array of length \${arr.length}\`);
  }
  return arr[index]!;
}

export function setElement<T>(arr: T[], index: number, value: T): void {
  if (index < 0 || index >= arr.length) {
    throw new RangeError(\`Index \${index} out of bounds for array of length \${arr.length}\`);
  }
  arr[index] = value;
}`,
    expectedError: 'index out of bounds',
    difficulty: 2,
  },

  // --- import_error ---
  {
    id: 'sc-012',
    name: 'import_circular_dependency',
    category: 'import_error',
    buggyCode: `// file: user-service.ts
import { AuditLog } from './audit-log.js';
import { EmailService } from './email-service.js';

export class UserService {
  constructor(
    private audit: AuditLog,
    private email: EmailService,
  ) {}

  async createUser(name: string): Promise<void> {
    this.audit.log('user.created', name);
    this.email.sendWelcome(name);
  }
}

// file: audit-log.ts (imports UserService, creating a cycle)
import { UserService } from './user-service.js';

export class AuditLog {
  constructor(private userService: UserService) {}
  log(event: string, detail: string): void {}
}`,
    bugDescription:
      'Circular dependency between user-service.ts and audit-log.ts. AuditLog should not depend on UserService. Use an interface to break the cycle.',
    correctCode: `// file: user-service.ts
import type { AuditLogger } from './audit-types.js';
import { EmailService } from './email-service.js';

export class UserService {
  constructor(
    private audit: AuditLogger,
    private email: EmailService,
  ) {}

  async createUser(name: string): Promise<void> {
    this.audit.log('user.created', name);
    this.email.sendWelcome(name);
  }
}

// file: audit-types.ts (shared interface, no circular dep)
export interface AuditLogger {
  log(event: string, detail: string): void;
}

// file: audit-log.ts (implements interface, no import of UserService)
import type { AuditLogger } from './audit-types.js';

export class AuditLog implements AuditLogger {
  log(event: string, detail: string): void {}
}`,
    expectedError: 'circular dependency',
    difficulty: 4,
  },

  // --- test_failure ---
  {
    id: 'sc-013',
    name: 'test_async_missing_await',
    category: 'test_failure',
    buggyCode: `import { describe, it, expect } from 'vitest';

async function loadConfig(): Promise<{ port: number }> {
  return { port: 3000 };
}

describe('loadConfig', () => {
  it('should return port 3000', () => {
    const config = loadConfig();
    expect(config.port).toBe(3000);
  });

  it('should return an object', () => {
    const config = loadConfig();
    expect(config).toHaveProperty('port');
  });
});`,
    bugDescription:
      'Tests call an async function without await, so they assert against a Promise object instead of the resolved value. The test callback also needs to be async.',
    correctCode: `import { describe, it, expect } from 'vitest';

async function loadConfig(): Promise<{ port: number }> {
  return { port: 3000 };
}

describe('loadConfig', () => {
  it('should return port 3000', async () => {
    const config = await loadConfig();
    expect(config.port).toBe(3000);
  });

  it('should return an object', async () => {
    const config = await loadConfig();
    expect(config).toHaveProperty('port');
  });
});`,
    expectedError: 'received Promise',
    difficulty: 1,
  },

  // --- lint_error ---
  {
    id: 'sc-014',
    name: 'lint_unused_variables',
    category: 'lint_error',
    buggyCode: `export function calculateTotal(items: Array<{ price: number; quantity: number }>): number {
  const TAX_RATE = 0.08;
  const DISCOUNT_RATE = 0.1;
  const SHIPPING_COST = 5.99;
  const FREE_SHIPPING_THRESHOLD = 50;

  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.quantity;
  }

  const tax = subtotal * TAX_RATE;
  return subtotal + tax;
}`,
    bugDescription:
      'DISCOUNT_RATE, SHIPPING_COST, and FREE_SHIPPING_THRESHOLD are declared but never used. They should be removed or used in the calculation.',
    correctCode: `export function calculateTotal(items: Array<{ price: number; quantity: number }>): number {
  const TAX_RATE = 0.08;

  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.quantity;
  }

  const tax = subtotal * TAX_RATE;
  return subtotal + tax;
}`,
    expectedError: 'no-unused-vars',
    difficulty: 1,
  },

  // --- logic_error ---
  {
    id: 'sc-015',
    name: 'logic_race_condition',
    category: 'logic_error',
    buggyCode: `let requestCount = 0;

export async function handleRequest(handler: () => Promise<string>): Promise<string> {
  requestCount++;
  const current = requestCount;
  const result = await handler();
  if (current === requestCount) {
    return result;
  }
  return 'stale';
}

export function getCount(): number {
  return requestCount;
}`,
    bugDescription:
      'Shared mutable state (requestCount) without synchronization. Concurrent calls will cause race conditions. The staleness check is flawed because requestCount can be incremented between the read and the check.',
    correctCode: `export function createRequestHandler(): {
  handleRequest: (handler: () => Promise<string>) => Promise<string>;
  getCount: () => number;
} {
  let requestCount = 0;
  let currentToken = 0;

  return {
    async handleRequest(handler: () => Promise<string>): Promise<string> {
      requestCount++;
      const myToken = ++currentToken;
      const result = await handler();
      if (myToken === currentToken) {
        return result;
      }
      return 'stale';
    },
    getCount(): number {
      return requestCount;
    },
  };
}`,
    expectedError: 'race condition',
    difficulty: 5,
  },
];

/**
 * All 7 correction categories present in the scenarios.
 */
export const ALL_CORRECTION_CATEGORIES: readonly CorrectionCategory[] = [
  'import_error',
  'type_error',
  'security_violation',
  'missing_validation',
  'test_failure',
  'lint_error',
  'logic_error',
] as const;

/**
 * Create the self-correction benchmark suite from built-in scenarios.
 */
export function createSelfCorrectionSuite(): BenchmarkSuite {
  return SELF_CORRECTION_SUITE;
}

/**
 * Pre-built self-correction benchmark suite.
 */
export const SELF_CORRECTION_SUITE: BenchmarkSuite = {
  id: 'self-correction',
  name: 'Self-Correction Effectiveness',
  description:
    'Tests whether the self-correction pipeline can detect and fix known bugs across 7 categories: import errors, type errors, security violations, missing validation, test failures, lint errors, and logic errors.',
  category: 'self-correction',
  dataset: CORRECTION_SCENARIOS.map((s) => ({
    id: s.id,
    input: `Fix this code:\n\`\`\`typescript\n${s.buggyCode}\n\`\`\`\n\nBug: ${s.bugDescription}`,
    expectedOutput: s.correctCode,
    tags: [s.category, `difficulty-${s.difficulty}`, s.name],
    metadata: {
      category: s.category,
      difficulty: s.difficulty,
      expectedError: s.expectedError,
    },
  })),
  scorers: [
    {
      id: 'correction-keyword',
      name: 'Correction Keyword Match',
      description: 'Checks if the corrected output contains key fixes',
      type: 'deterministic',
    },
    {
      id: 'correction-completeness',
      name: 'Correction Completeness',
      description: 'Checks if the corrected output is complete and compiles',
      type: 'deterministic',
    },
    {
      id: 'correction-quality',
      name: 'Correction Quality',
      description: 'LLM judge evaluating whether the fix addresses the root cause',
      type: 'llm-judge',
    },
  ],
  baselineThresholds: {
    'correction-keyword': 0.6,
    'correction-completeness': 0.7,
    'correction-quality': 0.6,
  },
};
