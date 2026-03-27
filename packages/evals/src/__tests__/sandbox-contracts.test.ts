/**
 * Sandbox adapter contract tests.
 *
 * Runs the SANDBOX_CONTRACT suite against SandboxProtocol implementations
 * to verify they conform to the interface contract. Each adapter gets the same
 * battery of tests: execute, file upload/download, timeout, cleanup.
 *
 * Currently tested adapters:
 * - Inline mock sandbox (minimal conformance baseline)
 * - MockSandbox from @dzipagent/codegen (when available)
 * - DockerSandbox from @dzipagent/codegen (skipped when Docker is unavailable)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SANDBOX_CONTRACT,
  createSandboxContract,
  runContractSuite,
  ContractSuiteBuilder,
  timedTest,
} from '../contracts/index.js';
import type { ComplianceReport } from '../contracts/index.js';

// ---------------------------------------------------------------------------
// Inline mock sandbox — self-contained, no external dependencies
// ---------------------------------------------------------------------------

function createInlineMockSandbox() {
  const files = new Map<string, string>();

  return {
    async execute(
      command: string,
      options?: { timeoutMs?: number; cwd?: string },
    ) {
      // Simulate timeout
      if (options?.timeoutMs && command.includes('sleep')) {
        return { exitCode: 137, stdout: '', stderr: 'killed', timedOut: true };
      }

      // Simulate basic commands
      if (command === 'true')
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      if (command === 'false')
        return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
      if (command.startsWith('echo "') && command.includes('>&2')) {
        const content = command.match(/echo "([^"]*)"/)?.[1] ?? '';
        return {
          exitCode: 0,
          stdout: '',
          stderr: content + '\n',
          timedOut: false,
        };
      }
      if (command.includes('>') && command.startsWith('echo ')) {
        const match = command.match(/echo "([^"]*)" > (.+)/);
        if (match) {
          files.set(match[2]!.trim(), match[1]!);
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        }
      }
      if (command.startsWith('echo "')) {
        const content = command.match(/echo "([^"]*)"/)?.[1] ?? '';
        return {
          exitCode: 0,
          stdout: content + '\n',
          stderr: '',
          timedOut: false,
        };
      }
      if (command === 'pwd') {
        const dir = options?.cwd ?? '/home';
        return { exitCode: 0, stdout: dir + '\n', stderr: '', timedOut: false };
      }
      if (command.startsWith('cat ')) {
        const path = command.replace('cat ', '').trim();
        const content = files.get(path);
        if (content !== undefined) {
          return {
            exitCode: 0,
            stdout: content + '\n',
            stderr: '',
            timedOut: false,
          };
        }
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'No such file',
          timedOut: false,
        };
      }
      if (command.startsWith('rm ')) {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }

      // Unknown command
      if (command.includes('__nonexistent_command')) {
        return {
          exitCode: 127,
          stdout: '',
          stderr: 'command not found',
          timedOut: false,
        };
      }

      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },

    async uploadFiles(filesMap: Record<string, string>) {
      for (const [path, content] of Object.entries(filesMap)) {
        files.set(path, content);
      }
    },

    async downloadFiles(paths: string[]) {
      const result: Record<string, string> = {};
      for (const p of paths) {
        const content = files.get(p);
        if (content !== undefined) {
          result[p] = content;
        }
      }
      return result;
    },

    async cleanup() {
      files.clear();
    },

    async isAvailable() {
      return true;
    },

    /** Expose files for testing */
    _getFiles() {
      return new Map(files);
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter helpers
// ---------------------------------------------------------------------------

/**
 * Try to import MockSandbox from @dzipagent/codegen.
 * Returns null if the package is not available (not a dependency of evals).
 */
async function createCodegenMockSandbox(): Promise<unknown> {
  try {
    const mod = await import('@dzipagent/codegen');
    const { MockSandbox } = mod as { MockSandbox: new () => unknown };
    const sandbox = new MockSandbox();

    // Configure basic responses so the contract suite passes
    const sb = sandbox as {
      configure(
        matcher: RegExp | string,
        result: {
          exitCode: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
        },
      ): unknown;
    };
    sb.configure('echo "hello"', {
      exitCode: 0,
      stdout: 'hello\n',
      stderr: '',
      timedOut: false,
    });
    sb.configure('true', {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    sb.configure('false', {
      exitCode: 1,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    sb.configure(/echo "err" >&2/, {
      exitCode: 0,
      stdout: '',
      stderr: 'err\n',
      timedOut: false,
    });
    sb.configure(/sleep/, {
      exitCode: 137,
      stdout: '',
      stderr: 'killed',
      timedOut: true,
    });
    sb.configure('__nonexistent_command_xyz_12345', {
      exitCode: 127,
      stdout: '',
      stderr: 'command not found',
      timedOut: false,
    });
    sb.configure('pwd', {
      exitCode: 0,
      stdout: '/tmp\n',
      stderr: '',
      timedOut: false,
    });
    sb.configure(/echo "isolation_test"/, {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    sb.configure(/cat \/tmp\/__contract_isolation/, {
      exitCode: 0,
      stdout: 'isolation_test\n',
      stderr: '',
      timedOut: false,
    });
    sb.configure(/rm -f/, {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });

    return sandbox;
  } catch {
    return null;
  }
}

/**
 * Check if Docker is available on this machine.
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    await exec('docker', ['info'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

interface AdapterEntry {
  name: string;
  create: () => Promise<unknown> | unknown;
  cleanup?: (adapter: unknown) => Promise<void>;
}

const adapters: AdapterEntry[] = [
  {
    name: 'InlineMockSandbox',
    create: () => createInlineMockSandbox(),
  },
];

// ===========================================================================
// Contract suite tests — run SANDBOX_CONTRACT against each adapter
// ===========================================================================

describe('Sandbox contract tests', () => {
  describe.each(adapters)('$name', ({ create, cleanup }) => {
    let adapter: unknown;
    let report: ComplianceReport;

    beforeEach(async () => {
      adapter = await create();
    });

    afterEach(async () => {
      if (cleanup && adapter) {
        await cleanup(adapter);
      }
    });

    it('should pass all required contract tests', async () => {
      report = await runContractSuite({
        suite: SANDBOX_CONTRACT,
        adapter,
      });

      const requiredTests = report.tests.filter((t) => t.category === 'required');
      const failedRequired = requiredTests.filter((t) => t.status === 'failed');

      if (failedRequired.length > 0) {
        const failures = failedRequired
          .map((f) => `  ${f.testId}: ${f.error ?? 'unknown error'}`)
          .join('\n');
        console.log(`Failed required tests:\n${failures}`);
      }

      expect(failedRequired).toHaveLength(0);
    });

    it('should pass all recommended contract tests', async () => {
      report = await runContractSuite({
        suite: SANDBOX_CONTRACT,
        adapter,
      });

      const recommendedTests = report.tests.filter(
        (t) => t.category === 'recommended',
      );
      const failedRecommended = recommendedTests.filter(
        (t) => t.status === 'failed',
      );

      if (failedRecommended.length > 0) {
        const failures = failedRecommended
          .map((f) => `  ${f.testId}: ${f.error ?? 'unknown error'}`)
          .join('\n');
        console.log(`Failed recommended tests:\n${failures}`);
      }

      expect(failedRecommended).toHaveLength(0);
    });

    it('should achieve full compliance', async () => {
      report = await runContractSuite({
        suite: SANDBOX_CONTRACT,
        adapter,
      });

      expect(report.complianceLevel).toBe('full');
      expect(report.compliancePercent).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // MockSandbox from @dzipagent/codegen — conditional
  // -------------------------------------------------------------------------

  describe('MockSandbox (@dzipagent/codegen)', () => {
    let adapter: unknown;
    let available = false;

    beforeEach(async () => {
      adapter = await createCodegenMockSandbox();
      available = adapter !== null;
    });

    afterEach(async () => {
      if (adapter && typeof (adapter as Record<string, unknown>)['cleanup'] === 'function') {
        await (adapter as { cleanup(): Promise<void> }).cleanup();
      }
    });

    it('should pass all contract tests when available', async () => {
      if (!available) {
        console.log(
          'Skipping: @dzipagent/codegen MockSandbox not available (not a direct dependency)',
        );
        return;
      }

      const report = await runContractSuite({
        suite: SANDBOX_CONTRACT,
        adapter,
      });

      const failures = report.tests.filter((t) => t.status === 'failed');
      if (failures.length > 0) {
        for (const f of failures) {
          console.log(`FAILED: ${f.testId} -- ${f.error ?? 'unknown'}`);
        }
      }

      // MockSandbox may not pass all optional tests; check required at minimum
      const requiredFailures = report.tests.filter(
        (t) => t.category === 'required' && t.status === 'failed',
      );
      expect(requiredFailures).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // DockerSandbox — skipped if Docker is not available
  // -------------------------------------------------------------------------

  describe('DockerSandbox (skipped without Docker)', () => {
    let dockerAvailable = false;

    beforeEach(async () => {
      dockerAvailable = await isDockerAvailable();
    }, 10_000);

    it(
      'should report contract compliance when Docker is available',
      async () => {
        if (!dockerAvailable) {
          console.log('Skipping: Docker is not available on this machine');
          return;
        }

        // Dynamic import since codegen is not a direct dependency
        let adapter: unknown;
        try {
          const mod = await import('@dzipagent/codegen');
          const { DockerSandbox } = mod as {
            DockerSandbox: new (config?: {
              timeoutMs?: number;
            }) => unknown;
          };
          adapter = new DockerSandbox({ timeoutMs: 30_000 });
        } catch {
          console.log('Skipping: @dzipagent/codegen not available');
          return;
        }

        const report = await runContractSuite({
          suite: SANDBOX_CONTRACT,
          adapter,
          testTimeoutMs: 60_000,
        });

        // Log results for visibility -- Docker may fail due to
        // image availability, Docker daemon config, etc.
        const failures = report.tests.filter((t) => t.status === 'failed');
        if (failures.length > 0) {
          console.log(
            `DockerSandbox: ${String(report.summary.passed)}/${String(report.summary.total)} passed ` +
            `(compliance: ${report.complianceLevel})`,
          );
          for (const f of failures) {
            console.log(`  FAILED: ${f.testId} -- ${f.error ?? 'unknown'}`);
          }
        }

        // The report should be structurally valid regardless of pass/fail
        expect(report.adapterType).toBe('sandbox');
        expect(report.summary.total).toBeGreaterThan(0);
        expect(typeof report.compliancePercent).toBe('number');

        // Cleanup
        if (
          adapter &&
          typeof (adapter as Record<string, unknown>)['cleanup'] === 'function'
        ) {
          await (adapter as { cleanup(): Promise<void> }).cleanup();
        }
      },
      120_000,
    );
  });
});

// ===========================================================================
// Targeted behavioral tests — deeper than the contract suite
// ===========================================================================

describe('Sandbox behavioral tests', () => {
  let sandbox: ReturnType<typeof createInlineMockSandbox>;

  beforeEach(() => {
    sandbox = createInlineMockSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  describe('execute()', () => {
    it('should return stdout from echo commands', async () => {
      const result = await sandbox.execute('echo "hello world"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello world');
      expect(result.timedOut).toBe(false);
    });

    it('should return stderr from redirected output', async () => {
      const result = await sandbox.execute('echo "error message" >&2');
      expect(result.stderr).toContain('error message');
      expect(result.exitCode).toBe(0);
    });

    it('should return exit code 0 for successful commands', async () => {
      const result = await sandbox.execute('true');
      expect(result.exitCode).toBe(0);
    });

    it('should return non-zero exit code for failing commands', async () => {
      const result = await sandbox.execute('false');
      expect(result.exitCode).not.toBe(0);
    });

    it('should return exit code 127 for non-existent commands', async () => {
      const result = await sandbox.execute('__nonexistent_command');
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('command not found');
    });

    it('should report ExecResult shape correctly', async () => {
      const result = await sandbox.execute('true');
      expect(typeof result.exitCode).toBe('number');
      expect(typeof result.stdout).toBe('string');
      expect(typeof result.stderr).toBe('string');
      expect(typeof result.timedOut).toBe('boolean');
    });
  });

  describe('timeout handling', () => {
    it('should set timedOut=true for commands exceeding timeout', async () => {
      const result = await sandbox.execute('sleep 60', { timeoutMs: 100 });
      expect(result.timedOut).toBe(true);
    });

    it('should not set timedOut for fast commands', async () => {
      const result = await sandbox.execute('echo "fast"');
      expect(result.timedOut).toBe(false);
    });
  });

  describe('working directory', () => {
    it('should use cwd option when provided', async () => {
      const result = await sandbox.execute('pwd', { cwd: '/tmp' });
      expect(result.stdout).toContain('/tmp');
    });

    it('should use default cwd when not provided', async () => {
      const result = await sandbox.execute('pwd');
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });
  });

  describe('file upload and download', () => {
    it('should round-trip file content via upload then download', async () => {
      const filePath = '/tmp/test-file.txt';
      const content = 'hello from test\nline 2';

      await sandbox.uploadFiles({ [filePath]: content });
      const downloaded = await sandbox.downloadFiles([filePath]);

      expect(downloaded[filePath]).toBe(content);
    });

    it('should upload multiple files at once', async () => {
      await sandbox.uploadFiles({
        '/tmp/a.txt': 'content A',
        '/tmp/b.txt': 'content B',
        '/tmp/c.txt': 'content C',
      });

      const downloaded = await sandbox.downloadFiles([
        '/tmp/a.txt',
        '/tmp/b.txt',
        '/tmp/c.txt',
      ]);

      expect(downloaded['/tmp/a.txt']).toBe('content A');
      expect(downloaded['/tmp/b.txt']).toBe('content B');
      expect(downloaded['/tmp/c.txt']).toBe('content C');
    });

    it('should return empty object for non-existent files', async () => {
      const downloaded = await sandbox.downloadFiles(['/tmp/nonexistent.txt']);
      expect(downloaded['/tmp/nonexistent.txt']).toBeUndefined();
    });

    it('should overwrite files on re-upload', async () => {
      const filePath = '/tmp/overwrite.txt';

      await sandbox.uploadFiles({ [filePath]: 'version 1' });
      await sandbox.uploadFiles({ [filePath]: 'version 2' });

      const downloaded = await sandbox.downloadFiles([filePath]);
      expect(downloaded[filePath]).toBe('version 2');
    });
  });

  describe('cleanup()', () => {
    it('should clear uploaded files after cleanup', async () => {
      await sandbox.uploadFiles({ '/tmp/file.txt': 'data' });
      await sandbox.cleanup();

      const downloaded = await sandbox.downloadFiles(['/tmp/file.txt']);
      expect(downloaded['/tmp/file.txt']).toBeUndefined();
    });
  });

  describe('isAvailable()', () => {
    it('should return a boolean', async () => {
      const available = await sandbox.isAvailable();
      expect(typeof available).toBe('boolean');
    });

    it('should return true for the mock sandbox', async () => {
      expect(await sandbox.isAvailable()).toBe(true);
    });
  });
});

// ===========================================================================
// Custom contract extension
// ===========================================================================

describe('Extended Sandbox contract (custom suite)', () => {
  it('should run a custom contract for multi-file operations', async () => {
    const customSuite = new ContractSuiteBuilder('sandbox', 'Custom Sandbox')
      .description('Extended sandbox tests')
      .required(
        'multi-file-upload',
        'Upload and download multiple files',
        'uploadFiles/downloadFiles handles multiple files in one call',
        async (adapter) =>
          timedTest(async () => {
            const sb = adapter as ReturnType<typeof createInlineMockSandbox>;

            const testFiles: Record<string, string> = {};
            for (let i = 0; i < 10; i++) {
              testFiles[`/tmp/multi-${String(i)}.txt`] = `content ${String(i)}`;
            }

            await sb.uploadFiles(testFiles);
            const paths = Object.keys(testFiles);
            const downloaded = await sb.downloadFiles(paths);

            for (const [path, expected] of Object.entries(testFiles)) {
              if (downloaded[path] !== expected) {
                return {
                  passed: false,
                  error: `Mismatch for ${path}: expected "${expected}", got "${String(downloaded[path])}"`,
                };
              }
            }

            return { passed: true, details: { fileCount: paths.length } };
          }),
      )
      .required(
        'execute-captures-all-fields',
        'Execute result has all required fields',
        'ExecResult includes exitCode, stdout, stderr, timedOut',
        async (adapter) =>
          timedTest(async () => {
            const sb = adapter as ReturnType<typeof createInlineMockSandbox>;
            const result = await sb.execute('echo "test"');

            const fields = ['exitCode', 'stdout', 'stderr', 'timedOut'] as const;
            for (const field of fields) {
              if (!(field in result)) {
                return {
                  passed: false,
                  error: `ExecResult missing field: ${field}`,
                };
              }
            }

            return { passed: true };
          }),
      )
      .build();

    const sandbox = createInlineMockSandbox();
    const report = await runContractSuite({
      suite: customSuite,
      adapter: sandbox,
    });

    expect(report.complianceLevel).toBe('full');
    expect(report.summary.failed).toBe(0);
  });
});
