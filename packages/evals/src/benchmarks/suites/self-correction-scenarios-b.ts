/**
 * Self-Correction scenarios sc-008 through sc-015.
 * Covers: logic_error, security_violation, type_error, missing_validation,
 *         import_error (circular), test_failure, lint_error, logic_error (race condition).
 */

import type { CorrectionScenario } from './self-correction-types.js';

/**
 * Scenarios sc-008 to sc-015.
 */
export const CORRECTION_SCENARIOS_B: CorrectionScenario[] = [
  // --- logic_error ---
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
