/**
 * Self-Correction scenarios sc-001 through sc-007.
 * Covers: import_error, type_error, security_violation, missing_validation,
 *         test_failure, lint_error, logic_error (first occurrence each).
 */

import type { CorrectionScenario } from './self-correction-types.js';

/**
 * Scenarios sc-001 to sc-007.
 */
export const CORRECTION_SCENARIOS_A: CorrectionScenario[] = [
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
];
