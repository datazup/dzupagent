/**
 * Comprehensive tests for domain-scorer deterministic-checks.ts
 *
 * Covers all 12 deterministic check functions with branch coverage
 * for passing and failing paths.
 */
import { describe, it, expect } from 'vitest';
import type { EvalInput } from '../types.js';
import {
  sqlCorrectnessDeterministic,
  sqlEfficiencyDeterministic,
  sqlInjectionSafetyDeterministic,
  sqlReadabilityDeterministic,
  codeTypeCorrectnessDeterministic,
  codeTestCoverageDeterministic,
  codeSecurityDeterministic,
  codeErrorHandlingDeterministic,
  analysisCitationDeterministic,
  opsIdempotencyDeterministic,
  opsRollbackSafetyDeterministic,
  opsPermissionScopeDeterministic,
  opsMonitoringDeterministic,
} from '../scorers/domain-scorer/deterministic-checks.js';

function makeInput(output: string, input = 'test'): EvalInput {
  return { input, output };
}

// ---------------------------------------------------------------------------
// SQL Correctness
// ---------------------------------------------------------------------------

describe('sqlCorrectnessDeterministic', () => {
  it('passes for valid SELECT...FROM', () => {
    const r = sqlCorrectnessDeterministic(makeInput('SELECT id FROM users'));
    expect(r.score).toBe(1);
    expect(r.reasoning).toContain('syntax checks passed');
  });

  it('passes for mutation keywords', () => {
    const r = sqlCorrectnessDeterministic(makeInput('INSERT INTO users (name) VALUES ("test")'));
    expect(r.score).toBe(1);
  });

  it('penalizes missing SQL keywords', () => {
    const r = sqlCorrectnessDeterministic(makeInput('just some random text'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('No SQL statement keyword');
  });

  it('penalizes SELECT without FROM', () => {
    const r = sqlCorrectnessDeterministic(makeInput('SELECT 1'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('SELECT without FROM');
  });

  it('penalizes unbalanced parentheses', () => {
    const r = sqlCorrectnessDeterministic(makeInput('SELECT id FROM users WHERE (id = 1'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('Unbalanced parentheses');
  });

  it('penalizes trailing comma before FROM', () => {
    const r = sqlCorrectnessDeterministic(makeInput('SELECT id, name, FROM users'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('Trailing comma');
  });

  it('penalizes trailing comma before WHERE', () => {
    const r = sqlCorrectnessDeterministic(makeInput('SELECT id FROM users, WHERE id = 1'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('Trailing comma');
  });

  it('clamps score to 0 when many issues', () => {
    const r = sqlCorrectnessDeterministic(makeInput('(random text with no parens close'));
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// SQL Efficiency
// ---------------------------------------------------------------------------

describe('sqlEfficiencyDeterministic', () => {
  it('passes for efficient query', () => {
    const r = sqlEfficiencyDeterministic(makeInput('SELECT id, name FROM users WHERE active = true'));
    expect(r.score).toBe(1);
    expect(r.reasoning).toContain('No efficiency issues');
  });

  it('penalizes SELECT *', () => {
    const r = sqlEfficiencyDeterministic(makeInput('SELECT * FROM users WHERE id = 1'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('SELECT *');
  });

  it('penalizes DISTINCT without comment justification', () => {
    const r = sqlEfficiencyDeterministic(makeInput('SELECT DISTINCT name FROM users'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('DISTINCT');
  });

  it('does not penalize DISTINCT with comment justification', () => {
    const r = sqlEfficiencyDeterministic(makeInput('SELECT DISTINCT name FROM users -- distinct needed'));
    expect(r.reasoning).not.toContain('DISTINCT used without');
  });

  it('penalizes subquery in WHERE', () => {
    const r = sqlEfficiencyDeterministic(makeInput('SELECT id FROM users WHERE id IN (SELECT user_id FROM orders)'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('Subquery');
  });

  it('penalizes subquery in FROM', () => {
    const r = sqlEfficiencyDeterministic(makeInput('SELECT * FROM (SELECT id FROM users)'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('Subquery');
  });

  it('penalizes unbounded SELECT without LIMIT or WHERE', () => {
    const r = sqlEfficiencyDeterministic(makeInput('SELECT id, name FROM users'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('Unbounded SELECT');
  });

  it('does not penalize SELECT with LIMIT', () => {
    const r = sqlEfficiencyDeterministic(makeInput('SELECT id FROM users LIMIT 10'));
    expect(r.reasoning).not.toContain('Unbounded');
  });

  it('does not penalize SELECT with TOP', () => {
    const r = sqlEfficiencyDeterministic(makeInput('SELECT TOP 10 id FROM users'));
    expect(r.reasoning).not.toContain('Unbounded');
  });
});

// ---------------------------------------------------------------------------
// SQL Injection Safety
// ---------------------------------------------------------------------------

describe('sqlInjectionSafetyDeterministic', () => {
  it('passes for parameterized query', () => {
    const r = sqlInjectionSafetyDeterministic(makeInput('SELECT id FROM users WHERE id = $1'));
    expect(r.score).toBe(1);
    expect(r.reasoning).toContain('No injection safety issues');
  });

  it('penalizes string concatenation pattern', () => {
    const r = sqlInjectionSafetyDeterministic(makeInput('"SELECT " + userId + " FROM users"'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('string interpolation');
  });

  it('penalizes template literal interpolation', () => {
    const r = sqlInjectionSafetyDeterministic(makeInput('`SELECT * FROM users WHERE id = ${userId}`'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('string interpolation');
  });

  it('penalizes f-string pattern', () => {
    const r = sqlInjectionSafetyDeterministic(makeInput('f"SELECT * FROM users WHERE id = {user_id}"'));
    expect(r.score).toBeLessThan(1);
  });

  it('penalizes .format() pattern', () => {
    const r = sqlInjectionSafetyDeterministic(makeInput('"SELECT * FROM users WHERE id = %s".format(id)'));
    expect(r.score).toBeLessThan(1);
  });

  it('penalizes user input references without parameterization', () => {
    const r = sqlInjectionSafetyDeterministic(
      makeInput('SELECT * FROM users WHERE id = id', 'Handle user_input for query'),
    );
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('User input referenced');
  });

  it('does not flag user input with ? placeholders (with comma)', () => {
    const r = sqlInjectionSafetyDeterministic(
      makeInput('SELECT * FROM users WHERE id = ?, name = ?)', 'Handle user_input for query'),
    );
    // Has param placeholder, so no penalty for user input
    expect(r.reasoning).not.toContain('User input referenced');
  });

  it('does not flag user input with :named placeholders', () => {
    const r = sqlInjectionSafetyDeterministic(
      makeInput('SELECT * FROM users WHERE id = :userId', 'Handle user_input'),
    );
    expect(r.reasoning).not.toContain('User input referenced');
  });

  it('does not flag user input with @named placeholders', () => {
    const r = sqlInjectionSafetyDeterministic(
      makeInput('SELECT * FROM users WHERE id = @userId', 'Handle req.body data'),
    );
    expect(r.reasoning).not.toContain('User input referenced');
  });

  it('detects $N positional placeholders', () => {
    const r = sqlInjectionSafetyDeterministic(
      makeInput('SELECT * FROM users WHERE id = $1', 'Handle user_input'),
    );
    expect(r.reasoning).not.toContain('User input referenced');
  });
});

// ---------------------------------------------------------------------------
// SQL Readability
// ---------------------------------------------------------------------------

describe('sqlReadabilityDeterministic', () => {
  it('passes for well-formatted SQL', () => {
    const r = sqlReadabilityDeterministic(makeInput('SELECT id\nFROM users\nWHERE active = true'));
    expect(r.score).toBe(1);
    expect(r.reasoning).toContain('readability checks passed');
  });

  it('penalizes lowercase SQL keywords', () => {
    const r = sqlReadabilityDeterministic(makeInput('select id from users'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('Lowercase SQL keywords');
  });

  it('penalizes complex single-line query without line breaks', () => {
    const longQuery = 'SELECT id, name, email, phone, address, city, state FROM users WHERE active = true ORDER BY name';
    const r = sqlReadabilityDeterministic(makeInput(longQuery));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('single line');
  });

  it('does not penalize short single-line queries', () => {
    const r = sqlReadabilityDeterministic(makeInput('SELECT id FROM users'));
    // Short enough not to trigger single-line penalty even without newlines
    expect(r.reasoning).not.toContain('single line');
  });
});

// ---------------------------------------------------------------------------
// Code Type Correctness
// ---------------------------------------------------------------------------

describe('codeTypeCorrectnessDeterministic', () => {
  it('passes for well-typed code', () => {
    const r = codeTypeCorrectnessDeterministic(makeInput('const x: number = 1;\nconst y: string = "hello";'));
    expect(r.score).toBe(1);
    expect(r.reasoning).toContain('No type safety issues');
  });

  it('penalizes any type annotations', () => {
    const r = codeTypeCorrectnessDeterministic(makeInput('const x: any = 1;'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain("'any' type");
  });

  it('penalizes as any casts', () => {
    const r = codeTypeCorrectnessDeterministic(makeInput('const x = foo as any;'));
    expect(r.score).toBeLessThan(1);
  });

  it('penalizes <any> angle bracket casts', () => {
    const r = codeTypeCorrectnessDeterministic(makeInput('const x = <any>foo;'));
    expect(r.score).toBeLessThan(1);
  });

  it('penalizes @ts-ignore directives', () => {
    const r = codeTypeCorrectnessDeterministic(makeInput('// @ts-ignore\nconst x = foo();'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('@ts-ignore');
  });

  it('penalizes @ts-expect-error directives (less severely)', () => {
    const r = codeTypeCorrectnessDeterministic(makeInput('// @ts-expect-error\nconst x = foo();'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('@ts-expect-error');
  });

  it('ignores any in comments', () => {
    const r = codeTypeCorrectnessDeterministic(makeInput('// the type was any before\n* old code used any'));
    expect(r.score).toBe(1);
  });

  it('caps deduction at 4 any occurrences', () => {
    const code = Array.from({ length: 10 }, (_, i) => `const x${i}: any = ${i};`).join('\n');
    const r = codeTypeCorrectnessDeterministic(makeInput(code));
    // 4 * 0.15 = 0.6, so score should be 0.4 (capped at 4)
    expect(r.score).toBeCloseTo(0.4, 1);
  });
});

// ---------------------------------------------------------------------------
// Code Test Coverage
// ---------------------------------------------------------------------------

describe('codeTestCoverageDeterministic', () => {
  it('scores 0 for code without test patterns', () => {
    const r = codeTestCoverageDeterministic(makeInput('function add(a, b) { return a + b; }'));
    expect(r.score).toBe(0);
    expect(r.reasoning).toContain('No test patterns found');
  });

  it('scores 1.0 for code with 4+ test patterns', () => {
    const testCode = `
describe('add', () => {
  it('adds numbers', () => {
    expect(add(1, 2)).toBe(3);
  });
  beforeEach(() => { setup(); });
});
`;
    const r = codeTestCoverageDeterministic(makeInput(testCode));
    expect(r.score).toBe(1);
    expect(r.reasoning).toContain('good coverage');
  });

  it('gives partial score for some test patterns', () => {
    const r = codeTestCoverageDeterministic(makeInput('test("works", () => { expect(1).toBe(1); })'));
    // test, expect = 2 patterns, score = 2/4 = 0.5
    expect(r.score).toBe(0.5);
  });

  it('detects assert pattern', () => {
    const r = codeTestCoverageDeterministic(makeInput('assert(x === 1)'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects afterEach pattern', () => {
    const r = codeTestCoverageDeterministic(makeInput('afterEach(() => { cleanup(); })'));
    expect(r.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Code Security
// ---------------------------------------------------------------------------

describe('codeSecurityDeterministic', () => {
  it('passes for secure code', () => {
    const r = codeSecurityDeterministic(makeInput('const data = await fetchData(url);'));
    expect(r.score).toBe(1);
    expect(r.reasoning).toContain('No security issues');
  });

  it('penalizes hardcoded secrets', () => {
    const r = codeSecurityDeterministic(makeInput('const apiKey = "sk_test_abcdefghijklmnop"'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('hardcoded secret');
  });

  it('penalizes AWS key patterns', () => {
    const r = codeSecurityDeterministic(makeInput('const key = "AKIAIOSFODNN7EXAMPLE"'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('hardcoded secret');
  });

  it('penalizes eval() usage', () => {
    const r = codeSecurityDeterministic(makeInput('eval("alert(1)")'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('eval()');
  });

  it('penalizes innerHTML assignment', () => {
    const r = codeSecurityDeterministic(makeInput('element.innerHTML = userInput'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('innerHTML');
  });

  it('penalizes dangerouslySetInnerHTML', () => {
    const r = codeSecurityDeterministic(makeInput('<div dangerouslySetInnerHTML={{ __html: data }} />'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('dangerouslySetInnerHTML');
  });

  it('accumulates multiple security issue deductions', () => {
    const r = codeSecurityDeterministic(makeInput('eval("x")\nelement.innerHTML = y'));
    expect(r.score).toBeLessThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// Code Error Handling
// ---------------------------------------------------------------------------

describe('codeErrorHandlingDeterministic', () => {
  it('starts at 0.5 for neutral code', () => {
    const r = codeErrorHandlingDeterministic(makeInput('const x = 1;'));
    expect(r.score).toBe(0.5);
    expect(r.reasoning).toContain('No specific error handling');
  });

  it('rewards try/catch blocks', () => {
    const r = codeErrorHandlingDeterministic(makeInput('try {\n  doSomething();\n} catch (e) {\n  log(e);\n}'));
    expect(r.score).toBeGreaterThan(0.5);
    expect(r.reasoning).toContain('try/catch');
  });

  it('penalizes empty catch blocks', () => {
    const r = codeErrorHandlingDeterministic(makeInput('try {\n  x();\n} catch (e) {}'));
    // Has try/catch (+0.2) but empty catch (-0.3), net: 0.5 + 0.2 - 0.3 = 0.4
    expect(r.score).toBeLessThan(0.5);
    expect(r.reasoning).toContain('Empty catch block');
  });

  it('rewards typed error handling', () => {
    const r = codeErrorHandlingDeterministic(makeInput('if (error instanceof TypeError) { handle(); }'));
    expect(r.score).toBeGreaterThan(0.5);
    expect(r.reasoning).toContain('Typed error handling');
  });

  it('rewards extends Error pattern', () => {
    const r = codeErrorHandlingDeterministic(makeInput('class MyError extends Error {}'));
    expect(r.score).toBeGreaterThan(0.5);
  });

  it('rewards promise .catch() handling', () => {
    const r = codeErrorHandlingDeterministic(makeInput('fetchData().catch((err) => log(err))'));
    expect(r.score).toBeGreaterThan(0.5);
    expect(r.reasoning).toContain('.catch()');
  });
});

// ---------------------------------------------------------------------------
// Analysis Citation
// ---------------------------------------------------------------------------

describe('analysisCitationDeterministic', () => {
  it('scores 0 for text without citations', () => {
    const r = analysisCitationDeterministic(makeInput('This is a plain statement without references.'));
    expect(r.score).toBe(0);
    expect(r.reasoning).toContain('No citation');
  });

  it('scores full for 3+ citation patterns', () => {
    const r = analysisCitationDeterministic(makeInput(
      'According to [1], the data shows improvement. See https://example.com for more.',
    ));
    expect(r.score).toBe(1);
  });

  it('detects numeric reference patterns', () => {
    const r = analysisCitationDeterministic(makeInput('As shown in [1,2], the results are clear.'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects author-year citation format', () => {
    const r = analysisCitationDeterministic(makeInput('(Smith, 2024) reported positive results.'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects URLs', () => {
    const r = analysisCitationDeterministic(makeInput('Source: https://example.com/study'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects "according to" pattern', () => {
    const r = analysisCitationDeterministic(makeInput('According to the WHO, the rate decreased.'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects "data shows" pattern', () => {
    const r = analysisCitationDeterministic(makeInput('The data shows a 10% improvement.'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects Figure/Table references', () => {
    const r = analysisCitationDeterministic(makeInput('As shown in Figure 1 and Table 2.'));
    expect(r.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Ops Idempotency
// ---------------------------------------------------------------------------

describe('opsIdempotencyDeterministic', () => {
  it('scores 0 for non-idempotent operations', () => {
    const r = opsIdempotencyDeterministic(makeInput('INSERT INTO users VALUES (1, "test")'));
    expect(r.score).toBe(0);
    expect(r.reasoning).toContain('No idempotency');
  });

  it('detects IF NOT EXISTS pattern', () => {
    const r = opsIdempotencyDeterministic(makeInput('CREATE TABLE IF NOT EXISTS users (id INT)'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects CREATE OR REPLACE pattern', () => {
    const r = opsIdempotencyDeterministic(makeInput('CREATE OR REPLACE VIEW v AS SELECT 1'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects upsert pattern', () => {
    const r = opsIdempotencyDeterministic(makeInput('db.collection.upsert({ id: 1 }, { name: "test" })'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects ON CONFLICT pattern', () => {
    const r = opsIdempotencyDeterministic(makeInput('INSERT INTO users (id) VALUES (1) ON CONFLICT DO NOTHING'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('gives full score for 2+ patterns', () => {
    const r = opsIdempotencyDeterministic(makeInput('CREATE TABLE IF NOT EXISTS users; INSERT ON CONFLICT DO NOTHING'));
    expect(r.score).toBe(1);
  });

  it('detects kubectl apply pattern', () => {
    const r = opsIdempotencyDeterministic(makeInput('kubectl apply -f deployment.yaml'));
    expect(r.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Ops Rollback Safety
// ---------------------------------------------------------------------------

describe('opsRollbackSafetyDeterministic', () => {
  it('scores 0 for operations without rollback patterns', () => {
    const r = opsRollbackSafetyDeterministic(makeInput('DROP TABLE users;'));
    expect(r.score).toBe(0);
    expect(r.reasoning).toContain('No rollback safety');
  });

  it('detects transaction pattern', () => {
    const r = opsRollbackSafetyDeterministic(makeInput('BEGIN TRANSACTION; UPDATE users SET active = false; COMMIT;'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects rollback keyword', () => {
    const r = opsRollbackSafetyDeterministic(makeInput('ROLLBACK TO SAVEPOINT sp1;'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects backup keyword', () => {
    const r = opsRollbackSafetyDeterministic(makeInput('Create a backup before proceeding'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects migration down() method', () => {
    const r = opsRollbackSafetyDeterministic(makeInput('async down() {\n  await queryRunner.dropTable("users");\n}'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects snapshot pattern', () => {
    const r = opsRollbackSafetyDeterministic(makeInput('Take a snapshot of the database first'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('gives full score for 2+ patterns', () => {
    const r = opsRollbackSafetyDeterministic(makeInput('BEGIN TRANSACTION; backup table; COMMIT'));
    expect(r.score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ops Permission Scope
// ---------------------------------------------------------------------------

describe('opsPermissionScopeDeterministic', () => {
  it('passes for minimal-permission operations', () => {
    const r = opsPermissionScopeDeterministic(makeInput('chmod 600 config.json'));
    expect(r.score).toBe(1);
    expect(r.reasoning).toContain('No permission scope issues');
  });

  it('penalizes unjustified sudo', () => {
    const r = opsPermissionScopeDeterministic(makeInput('sudo rm -rf /tmp/cache'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('sudo');
  });

  it('does not penalize sudo with justification', () => {
    const r = opsPermissionScopeDeterministic(makeInput('sudo rm -rf /tmp/cache\n# Reason: cleanup required'));
    expect(r.reasoning).not.toContain('sudo used without');
  });

  it('penalizes chmod 777', () => {
    const r = opsPermissionScopeDeterministic(makeInput('chmod 777 /var/www'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('chmod 777');
  });

  it('penalizes wildcard IAM permissions', () => {
    const r = opsPermissionScopeDeterministic(makeInput('iam policy: "*"\nrole: admin'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('Wildcard');
  });

  it('penalizes running as root in container', () => {
    const r = opsPermissionScopeDeterministic(makeInput('Run as root in docker container'));
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain('root');
  });

  it('does not penalize non-root container', () => {
    const r = opsPermissionScopeDeterministic(makeInput('Use non-root user in docker container'));
    expect(r.reasoning).not.toContain('Running as root');
  });
});

// ---------------------------------------------------------------------------
// Ops Monitoring
// ---------------------------------------------------------------------------

describe('opsMonitoringDeterministic', () => {
  it('scores 0 for operations without monitoring patterns', () => {
    const r = opsMonitoringDeterministic(makeInput('x = 1'));
    expect(r.score).toBe(0);
    expect(r.reasoning).toContain('No monitoring');
  });

  it('detects logging pattern', () => {
    const r = opsMonitoringDeterministic(makeInput('console.log("starting")'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects health check pattern', () => {
    const r = opsMonitoringDeterministic(makeInput('Configure health_check endpoint at /health'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects alerting pattern', () => {
    const r = opsMonitoringDeterministic(makeInput('Configure alerts for error rate'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects prometheus pattern', () => {
    const r = opsMonitoringDeterministic(makeInput('Use prometheus for metrics collection'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('detects opentelemetry pattern', () => {
    const r = opsMonitoringDeterministic(makeInput('Initialize opentelemetry tracing'));
    expect(r.score).toBeGreaterThan(0);
  });

  it('gives full score for 3+ monitoring patterns', () => {
    const r = opsMonitoringDeterministic(makeInput('console.log("start"); health_check endpoint; metrics collection'));
    expect(r.score).toBe(1);
  });
});
