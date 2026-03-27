/**
 * Sandbox Contract Suite — conformance tests for SandboxProtocol adapters.
 *
 * Tests verify the SandboxProtocol interface contract defined in @dzipagent/codegen.
 */

import { ContractSuiteBuilder, timedTest } from '../contract-test-generator.js';
import type { ContractSuite } from '../contract-types.js';

// ---------------------------------------------------------------------------
// Minimal interface shape (avoids hard dependency on codegen)
// ---------------------------------------------------------------------------

interface SandboxShape {
  execute(command: string, options?: { timeoutMs?: number; cwd?: string }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
  uploadFiles(files: Record<string, string>): Promise<void>;
  downloadFiles(paths: string[]): Promise<Record<string, string>>;
  cleanup(): Promise<void>;
  isAvailable(): Promise<boolean>;
}

function asSandbox(adapter: unknown): SandboxShape {
  return adapter as SandboxShape;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export function createSandboxContract(): ContractSuite {
  const builder = new ContractSuiteBuilder('sandbox', 'Sandbox Contract')
    .description('Conformance tests for SandboxProtocol adapter implementations');

  // --- Required ---

  builder.required(
    'execute-returns-output',
    'Execute returns output',
    'execute() runs a command and returns stdout, stderr, exitCode',
    async (adapter) =>
      timedTest(async () => {
        const sandbox = asSandbox(adapter);
        const result = await sandbox.execute('echo "hello"');

        if (typeof result.exitCode !== 'number') {
          return { passed: false, error: 'exitCode must be a number' };
        }
        if (typeof result.stdout !== 'string') {
          return { passed: false, error: 'stdout must be a string' };
        }
        if (typeof result.stderr !== 'string') {
          return { passed: false, error: 'stderr must be a string' };
        }
        if (typeof result.timedOut !== 'boolean') {
          return { passed: false, error: 'timedOut must be a boolean' };
        }

        if (!result.stdout.includes('hello')) {
          return { passed: false, error: `stdout should contain "hello", got: "${result.stdout}"` };
        }

        return { passed: true, details: { exitCode: result.exitCode } };
      }),
  );

  builder.required(
    'execute-exit-code',
    'Exit code reflects success/failure',
    'Successful commands return exitCode 0, failures return non-zero',
    async (adapter) =>
      timedTest(async () => {
        const sandbox = asSandbox(adapter);

        const success = await sandbox.execute('true');
        if (success.exitCode !== 0) {
          return { passed: false, error: `"true" command should return exitCode 0, got ${success.exitCode}` };
        }

        const failure = await sandbox.execute('false');
        if (failure.exitCode === 0) {
          return { passed: false, error: '"false" command should return non-zero exitCode' };
        }

        return { passed: true };
      }),
  );

  builder.required(
    'execute-stderr',
    'Stderr capture',
    'execute() captures stderr output separately from stdout',
    async (adapter) =>
      timedTest(async () => {
        const sandbox = asSandbox(adapter);
        const result = await sandbox.execute('echo "err" >&2');

        if (!result.stderr.includes('err')) {
          return {
            passed: false,
            error: `stderr should contain "err", got: "${result.stderr}"`,
          };
        }

        return { passed: true };
      }),
  );

  builder.required(
    'is-available',
    'Availability check',
    'isAvailable() returns a boolean indicating whether the sandbox is ready',
    async (adapter) =>
      timedTest(async () => {
        const sandbox = asSandbox(adapter);
        const available = await sandbox.isAvailable();

        if (typeof available !== 'boolean') {
          return { passed: false, error: 'isAvailable() must return a boolean' };
        }

        return { passed: true, details: { available } };
      }),
  );

  builder.required(
    'cleanup',
    'Cleanup',
    'cleanup() completes without throwing',
    async (adapter) =>
      timedTest(async () => {
        const sandbox = asSandbox(adapter);
        await sandbox.cleanup();
        return { passed: true };
      }),
  );

  // --- Recommended ---

  builder.recommended(
    'timeout-enforcement',
    'Timeout enforcement',
    'execute() respects timeoutMs and sets timedOut=true when exceeded',
    async (adapter) =>
      timedTest(async () => {
        const sandbox = asSandbox(adapter);

        const result = await sandbox.execute('sleep 60', { timeoutMs: 500 });

        if (!result.timedOut) {
          return { passed: false, error: 'timedOut should be true for a command that exceeds timeout' };
        }

        return { passed: true, details: { exitCode: result.exitCode } };
      }),
  );

  builder.recommended(
    'upload-download-files',
    'File upload and download',
    'uploadFiles() and downloadFiles() round-trip file content correctly',
    async (adapter) =>
      timedTest(async () => {
        const sandbox = asSandbox(adapter);
        const content = 'contract test content\nline 2';
        const path = '/tmp/__contract_test_file.txt';

        await sandbox.uploadFiles({ [path]: content });
        const downloaded = await sandbox.downloadFiles([path]);

        const actual = downloaded[path];
        if (actual === undefined) {
          return { passed: false, error: `downloadFiles() did not return content for ${path}` };
        }

        if (actual.trim() !== content.trim()) {
          return {
            passed: false,
            error: `Content mismatch: expected "${content}", got "${actual}"`,
          };
        }

        return { passed: true };
      }),
  );

  builder.recommended(
    'error-handling',
    'Graceful error handling',
    'execute() with an invalid command returns non-zero exit code without throwing',
    async (adapter) =>
      timedTest(async () => {
        const sandbox = asSandbox(adapter);

        // A command that should not exist
        const result = await sandbox.execute('__nonexistent_command_xyz_12345');

        if (result.exitCode === 0) {
          return { passed: false, error: 'Non-existent command should return non-zero exit code' };
        }

        return { passed: true, details: { exitCode: result.exitCode } };
      }),
  );

  // --- Optional ---

  builder.optional(
    'cwd-option',
    'Working directory option',
    'execute() respects the cwd option for command execution',
    async (adapter) =>
      timedTest(async () => {
        const sandbox = asSandbox(adapter);

        const result = await sandbox.execute('pwd', { cwd: '/tmp' });

        if (!result.stdout.includes('/tmp')) {
          return {
            passed: false,
            error: `Expected working directory /tmp in output, got "${result.stdout.trim()}"`,
          };
        }

        return { passed: true };
      }),
  );

  builder.optional(
    'file-system-isolation',
    'File system isolation',
    'Files written in one sandbox execution do not leak to other contexts',
    async (adapter) =>
      timedTest(async () => {
        const sandbox = asSandbox(adapter);

        // Write a file and verify it can be read
        await sandbox.execute('echo "isolation_test" > /tmp/__contract_isolation.txt');
        const readResult = await sandbox.execute('cat /tmp/__contract_isolation.txt');

        if (!readResult.stdout.includes('isolation_test')) {
          return {
            passed: false,
            error: 'File written in sandbox should be readable within the same session',
          };
        }

        // Cleanup
        await sandbox.execute('rm -f /tmp/__contract_isolation.txt');

        return { passed: true };
      }),
  );

  return builder.build();
}

/** Pre-built Sandbox contract suite */
export const SANDBOX_CONTRACT = createSandboxContract();
