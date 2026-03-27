/**
 * Tests for the Contract Test Kit — tests the testing infrastructure itself.
 *
 * Uses mock adapters to verify the contract runner, reporter, builder,
 * and all four built-in contract suites work correctly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ContractSuiteBuilder,
  timedTest,
} from '../contracts/contract-test-generator.js';
import {
  runContractSuite,
  runContractSuites,
} from '../contracts/contract-test-runner.js';
import {
  complianceBadge,
  complianceSummary,
  complianceToCIAnnotations,
  complianceToJSON,
  complianceToMarkdown,
} from '../contracts/contract-test-reporter.js';
import { VECTOR_STORE_CONTRACT } from '../contracts/suites/vector-store-contract.js';
import { SANDBOX_CONTRACT } from '../contracts/suites/sandbox-contract.js';
import { LLM_PROVIDER_CONTRACT } from '../contracts/suites/llm-provider-contract.js';
import { EMBEDDING_PROVIDER_CONTRACT } from '../contracts/suites/embedding-provider-contract.js';
import type {
  ComplianceReport,
  ContractSuite,
  ContractTestResult,
} from '../contracts/contract-types.js';

// ===========================================================================
// Mock adapters
// ===========================================================================

/** A minimal in-memory VectorStore that passes all contract tests */
function createMockVectorStore() {
  const collections = new Map<string, Map<string, { vector: number[]; metadata: Record<string, unknown>; text?: string }>>();

  return {
    provider: 'mock',

    async createCollection(name: string, _config: { dimensions: number }) {
      collections.set(name, new Map());
    },

    async deleteCollection(name: string) {
      collections.delete(name);
    },

    async listCollections() {
      return [...collections.keys()];
    },

    async collectionExists(name: string) {
      return collections.has(name);
    },

    async upsert(collection: string, entries: Array<{ id: string; vector: number[]; metadata: Record<string, unknown>; text?: string }>) {
      const coll = collections.get(collection);
      if (!coll) throw new Error(`Collection ${collection} does not exist`);
      for (const entry of entries) {
        coll.set(entry.id, { vector: entry.vector, metadata: entry.metadata, text: entry.text });
      }
    },

    async search(collection: string, query: { vector: number[]; limit: number }) {
      const coll = collections.get(collection);
      if (!coll) return [];

      // Cosine similarity ranking
      const results = [...coll.entries()].map(([id, entry]) => {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < query.vector.length; i++) {
          dot += (query.vector[i] ?? 0) * (entry.vector[i] ?? 0);
          normA += (query.vector[i] ?? 0) ** 2;
          normB += (entry.vector[i] ?? 0) ** 2;
        }
        const score = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
        return { id, score, metadata: entry.metadata, text: entry.text };
      });

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, query.limit);
    },

    async delete(collection: string, filter: { ids: string[] }) {
      const coll = collections.get(collection);
      if (!coll) return;
      if ('ids' in filter) {
        for (const id of filter.ids) {
          coll.delete(id);
        }
      }
    },

    async count(collection: string) {
      return collections.get(collection)?.size ?? 0;
    },

    async healthCheck() {
      return { healthy: true, latencyMs: 1, provider: 'mock' };
    },

    async close() {
      collections.clear();
    },
  };
}

/** A minimal mock SandboxProtocol */
function createMockSandbox() {
  const files = new Map<string, string>();

  return {
    async execute(command: string, options?: { timeoutMs?: number; cwd?: string }) {
      // Simulate timeout
      if (options?.timeoutMs && command.includes('sleep')) {
        return { exitCode: 137, stdout: '', stderr: 'killed', timedOut: true };
      }

      // Simulate basic commands
      if (command === 'true') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      if (command === 'false') return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
      if (command.startsWith('echo "') && command.includes('>&2')) {
        const content = command.match(/echo "([^"]*)"/)?.[1] ?? '';
        return { exitCode: 0, stdout: '', stderr: content + '\n', timedOut: false };
      }
      if (command.includes('>') && command.startsWith('echo ')) {
        // File redirect: echo "content" > path
        const match = command.match(/echo "([^"]*)" > (.+)/);
        if (match) {
          files.set(match[2]!.trim(), match[1]!);
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        }
      }
      if (command.startsWith('echo "')) {
        const content = command.match(/echo "([^"]*)"/)?.[1] ?? '';
        return { exitCode: 0, stdout: content + '\n', stderr: '', timedOut: false };
      }
      if (command === 'pwd') {
        const dir = options?.cwd ?? '/home';
        return { exitCode: 0, stdout: dir + '\n', stderr: '', timedOut: false };
      }
      if (command.startsWith('cat ')) {
        const path = command.replace('cat ', '').trim();
        const content = files.get(path);
        if (content !== undefined) {
          return { exitCode: 0, stdout: content + '\n', stderr: '', timedOut: false };
        }
        return { exitCode: 1, stdout: '', stderr: 'No such file', timedOut: false };
      }
      if (command.startsWith('rm ')) {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }

      // Unknown command
      if (command.includes('__nonexistent_command')) {
        return { exitCode: 127, stdout: '', stderr: 'command not found', timedOut: false };
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
  };
}

/** A minimal mock LLM Provider */
function createMockLLMProvider() {
  const provider = {
    async invoke(messages: Array<{ content: string; role?: string }>) {
      const lastMsg = messages[messages.length - 1];
      let content = 'Hello, I am a mock LLM.';

      if (lastMsg?.content.includes('OK')) content = 'OK';
      if (lastMsg?.content.includes('HELLO')) content = 'HELLO';
      if (lastMsg?.content.includes('name')) {
        // Look for name in context
        const nameMsg = messages.find((m) => m.content.includes('ContractTestBot'));
        if (nameMsg) content = 'Your name is ContractTestBot.';
      }

      return {
        content,
        usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        tool_calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
      };
    },

    async *stream(messages: Array<{ content: string }>) {
      const _msgs = messages;
      yield { content: 'Hello' };
      yield { content: ', ' };
      yield { content: 'world' };
    },

    bindTools(_tools: Array<{ name: string; description: string; schema: unknown }>) {
      return {
        ...provider,
        async invoke(messages: Array<{ content: string; role?: string }>) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg?.content.toLowerCase().includes('weather')) {
            return {
              content: '',
              usage_metadata: { input_tokens: 15, output_tokens: 10, total_tokens: 25 },
              tool_calls: [{ name: 'get_weather', args: { city: 'Paris' } }],
            };
          }
          return provider.invoke(messages);
        },
        bindTools: provider.bindTools,
        stream: provider.stream,
      };
    },
  };

  return provider;
}

/** A minimal mock EmbeddingProvider */
function createMockEmbeddingProvider(dimensions = 8) {
  // Deterministic embedding: hash text to vector
  function hashEmbed(text: string): number[] {
    const vec: number[] = [];
    for (let i = 0; i < dimensions; i++) {
      let h = 0;
      for (let j = 0; j < text.length; j++) {
        h = ((h << 5) - h + text.charCodeAt(j) + i * 17) | 0;
      }
      vec.push(Math.sin(h) * 0.5 + 0.5);
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / (norm || 1));
  }

  return {
    modelId: 'mock-embed-v1',
    dimensions,

    async embed(texts: string[]) {
      return texts.map(hashEmbed);
    },

    async embedQuery(text: string) {
      return hashEmbed(text);
    },
  };
}

// ===========================================================================
// ContractSuiteBuilder tests
// ===========================================================================

describe('ContractSuiteBuilder', () => {
  it('should build a suite with required, recommended, and optional tests', () => {
    const suite = new ContractSuiteBuilder('vector-store', 'Test Suite')
      .description('A test suite')
      .required('r1', 'Required Test', 'desc', async () => ({ passed: true, duration: 1 }))
      .recommended('rec1', 'Recommended Test', 'desc', async () => ({ passed: true, duration: 1 }))
      .optional('opt1', 'Optional Test', 'desc', async () => ({ passed: true, duration: 1 }))
      .build();

    expect(suite.adapterType).toBe('vector-store');
    expect(suite.name).toBe('Test Suite');
    expect(suite.description).toBe('A test suite');
    expect(suite.tests).toHaveLength(3);
    expect(suite.tests[0]!.category).toBe('required');
    expect(suite.tests[1]!.category).toBe('recommended');
    expect(suite.tests[2]!.category).toBe('optional');
  });

  it('should prefix test IDs with adapter type', () => {
    const suite = new ContractSuiteBuilder('sandbox', 'S')
      .required('test-1', 'T', 'D', async () => ({ passed: true, duration: 0 }))
      .build();

    expect(suite.tests[0]!.id).toBe('sandbox:test-1');
  });

  it('should throw on duplicate test IDs', () => {
    const builder = new ContractSuiteBuilder('sandbox', 'S')
      .required('dup', 'T', 'D', async () => ({ passed: true, duration: 0 }));

    expect(() =>
      builder.required('dup', 'T2', 'D2', async () => ({ passed: true, duration: 0 })),
    ).toThrow('Duplicate test ID');
  });

  it('should throw when building with no tests', () => {
    const builder = new ContractSuiteBuilder('sandbox', 'Empty');
    expect(() => builder.build()).toThrow('has no tests');
  });

  it('should support setup and teardown', () => {
    const setupFn = vi.fn(async () => {});
    const teardownFn = vi.fn(async () => {});

    const suite = new ContractSuiteBuilder('sandbox', 'S')
      .beforeAll(setupFn)
      .afterAll(teardownFn)
      .required('t', 'T', 'D', async () => ({ passed: true, duration: 0 }))
      .build();

    expect(suite.setup).toBe(setupFn);
    expect(suite.teardown).toBe(teardownFn);
  });
});

// ===========================================================================
// timedTest helper
// ===========================================================================

describe('timedTest', () => {
  it('should measure duration and return passed=true', async () => {
    const result = await timedTest(async () => ({ passed: true }));

    expect(result.passed).toBe(true);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('should catch errors and return passed=false', async () => {
    const result = await timedTest(async () => {
      throw new Error('boom');
    });

    expect(result.passed).toBe(false);
    expect(result.error).toBe('boom');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('should propagate details', async () => {
    const result = await timedTest(async () => ({
      passed: true,
      details: { key: 'value' },
    }));

    expect(result.details).toEqual({ key: 'value' });
  });

  it('should handle explicit failure', async () => {
    const result = await timedTest(async () => ({
      passed: false,
      error: 'check failed',
    }));

    expect(result.passed).toBe(false);
    expect(result.error).toBe('check failed');
  });
});

// ===========================================================================
// Contract test runner
// ===========================================================================

describe('runContractSuite', () => {
  let allPassSuite: ContractSuite;
  let mixedSuite: ContractSuite;

  beforeEach(() => {
    allPassSuite = new ContractSuiteBuilder('vector-store', 'All Pass')
      .description('All tests pass')
      .required('r1', 'R1', 'D', async () => timedTest(async () => ({ passed: true })))
      .required('r2', 'R2', 'D', async () => timedTest(async () => ({ passed: true })))
      .recommended('rec1', 'Rec1', 'D', async () => timedTest(async () => ({ passed: true })))
      .optional('opt1', 'Opt1', 'D', async () => timedTest(async () => ({ passed: true })))
      .build();

    mixedSuite = new ContractSuiteBuilder('sandbox', 'Mixed')
      .description('Some tests fail')
      .required('r1', 'R1', 'D', async () => timedTest(async () => ({ passed: true })))
      .required('r2', 'R2', 'D', async () => timedTest(async () => ({ passed: false, error: 'fail' })))
      .recommended('rec1', 'Rec1', 'D', async () => timedTest(async () => ({ passed: true })))
      .optional('opt1', 'Opt1', 'D', async () => timedTest(async () => ({ passed: false, error: 'opt fail' })))
      .build();
  });

  it('should produce a compliance report with all tests passing', async () => {
    const report = await runContractSuite({ suite: allPassSuite, adapter: {} });

    expect(report.suiteName).toBe('All Pass');
    expect(report.adapterType).toBe('vector-store');
    expect(report.summary.total).toBe(4);
    expect(report.summary.passed).toBe(4);
    expect(report.summary.failed).toBe(0);
    expect(report.complianceLevel).toBe('full');
    expect(report.compliancePercent).toBe(100);
    expect(report.timestamp).toBeTruthy();
    expect(report.totalDuration).toBeGreaterThanOrEqual(0);
  });

  it('should report failures correctly', async () => {
    const report = await runContractSuite({ suite: mixedSuite, adapter: {} });

    expect(report.summary.passed).toBe(2);
    expect(report.summary.failed).toBe(2);
    expect(report.complianceLevel).toBe('minimal');
    expect(report.compliancePercent).toBe(50);

    const failedTests = report.tests.filter((t) => t.status === 'failed');
    expect(failedTests).toHaveLength(2);
    expect(failedTests[0]!.error).toBe('fail');
  });

  it('should filter by category', async () => {
    const report = await runContractSuite({
      suite: allPassSuite,
      adapter: {},
      filter: { categories: ['required'] },
    });

    const nonSkipped = report.tests.filter((t) => t.status !== 'skipped');
    expect(nonSkipped).toHaveLength(2);
    expect(nonSkipped.every((t) => t.category === 'required')).toBe(true);
  });

  it('should filter by test IDs', async () => {
    const report = await runContractSuite({
      suite: allPassSuite,
      adapter: {},
      filter: { testIds: ['vector-store:r1'] },
    });

    const nonSkipped = report.tests.filter((t) => t.status !== 'skipped');
    expect(nonSkipped).toHaveLength(1);
    expect(nonSkipped[0]!.testId).toBe('vector-store:r1');
  });

  it('should run setup and teardown', async () => {
    const setup = vi.fn(async () => {});
    const teardown = vi.fn(async () => {});

    const suite = new ContractSuiteBuilder('sandbox', 'Lifecycle')
      .beforeAll(setup)
      .afterAll(teardown)
      .required('t', 'T', 'D', async () => timedTest(async () => ({ passed: true })))
      .build();

    await runContractSuite({ suite, adapter: {} });

    expect(setup).toHaveBeenCalledOnce();
    expect(teardown).toHaveBeenCalledOnce();
  });

  it('should handle test exceptions as failures', async () => {
    const suite = new ContractSuiteBuilder('sandbox', 'Throwing')
      .required('t', 'T', 'D', async () => {
        throw new Error('unexpected error');
      })
      .build();

    const report = await runContractSuite({ suite, adapter: {} });

    expect(report.summary.failed).toBe(1);
    expect(report.tests[0]!.error).toBe('unexpected error');
  });

  it('should handle test timeout', async () => {
    const suite = new ContractSuiteBuilder('sandbox', 'Timeout')
      .required('t', 'T', 'D', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { passed: true, duration: 5000 };
      })
      .build();

    const report = await runContractSuite({ suite, adapter: {}, testTimeoutMs: 100 });

    expect(report.summary.failed).toBe(1);
    expect(report.tests[0]!.error).toContain('timed out');
  });

  it('should compute compliance levels correctly', async () => {
    // All required pass, some recommended fail => partial
    const partialSuite = new ContractSuiteBuilder('sandbox', 'Partial')
      .required('r1', 'R1', 'D', async () => timedTest(async () => ({ passed: true })))
      .recommended('rec1', 'Rec1', 'D', async () => timedTest(async () => ({ passed: false, error: 'f' })))
      .build();

    const report = await runContractSuite({ suite: partialSuite, adapter: {} });
    expect(report.complianceLevel).toBe('partial');
  });

  it('should return "none" compliance when all required tests fail', async () => {
    const noneSuite = new ContractSuiteBuilder('sandbox', 'None')
      .required('r1', 'R1', 'D', async () => timedTest(async () => ({ passed: false, error: 'f' })))
      .required('r2', 'R2', 'D', async () => timedTest(async () => ({ passed: false, error: 'f' })))
      .build();

    const report = await runContractSuite({ suite: noneSuite, adapter: {} });
    expect(report.complianceLevel).toBe('none');
  });

  it('should compute byCategory counts', async () => {
    const report = await runContractSuite({ suite: mixedSuite, adapter: {} });

    expect(report.byCategory.required.total).toBe(2);
    expect(report.byCategory.required.passed).toBe(1);
    expect(report.byCategory.required.failed).toBe(1);
    expect(report.byCategory.recommended.total).toBe(1);
    expect(report.byCategory.recommended.passed).toBe(1);
    expect(report.byCategory.optional.total).toBe(1);
    expect(report.byCategory.optional.failed).toBe(1);
  });
});

describe('runContractSuites', () => {
  it('should run multiple suites and return reports for each', async () => {
    const suite1 = new ContractSuiteBuilder('vector-store', 'S1')
      .required('t', 'T', 'D', async () => timedTest(async () => ({ passed: true })))
      .build();
    const suite2 = new ContractSuiteBuilder('sandbox', 'S2')
      .required('t', 'T', 'D', async () => timedTest(async () => ({ passed: false, error: 'x' })))
      .build();

    const reports = await runContractSuites([
      { suite: suite1, adapter: {} },
      { suite: suite2, adapter: {} },
    ]);

    expect(reports).toHaveLength(2);
    expect(reports[0]!.suiteName).toBe('S1');
    expect(reports[0]!.complianceLevel).toBe('full');
    expect(reports[1]!.suiteName).toBe('S2');
    expect(reports[1]!.complianceLevel).toBe('none');
  });
});

// ===========================================================================
// Contract test reporter
// ===========================================================================

describe('Contract reporters', () => {
  let report: ComplianceReport;

  beforeEach(async () => {
    const suite = new ContractSuiteBuilder('vector-store', 'VectorStore Contract')
      .description('Test suite')
      .required('r1', 'Put and Get', 'stores and retrieves', async () =>
        timedTest(async () => ({ passed: true })),
      )
      .required('r2', 'Search', 'searches', async () =>
        timedTest(async () => ({ passed: false, error: 'no results' })),
      )
      .recommended('rec1', 'Health Check', 'checks health', async () =>
        timedTest(async () => ({ passed: true })),
      )
      .build();

    report = await runContractSuite({ suite, adapter: {} });
  });

  describe('complianceToMarkdown', () => {
    it('should produce valid markdown with headers and tables', () => {
      const md = complianceToMarkdown(report);

      expect(md).toContain('# VectorStore Contract Compliance Report');
      expect(md).toContain('**Adapter type:** vector-store');
      expect(md).toContain('**Compliance level:**');
      expect(md).toContain('## Summary');
      expect(md).toContain('## By Category');
      expect(md).toContain('## Test Results');
      expect(md).toContain('Put and Get');
      expect(md).toContain('Search');
      expect(md).toContain('Health Check');
      expect(md).toContain('PASS');
      expect(md).toContain('FAIL');
    });

    it('should include error messages in table', () => {
      const md = complianceToMarkdown(report);
      expect(md).toContain('no results');
    });
  });

  describe('complianceToJSON', () => {
    it('should produce valid JSON', () => {
      const json = complianceToJSON(report);
      const parsed = JSON.parse(json);

      expect(parsed.suiteName).toBe('VectorStore Contract');
      expect(parsed.adapterType).toBe('vector-store');
      expect(parsed.summary.total).toBe(3);
      expect(parsed.summary.passed).toBe(2);
      expect(parsed.summary.failed).toBe(1);
      expect(typeof parsed.compliancePercent).toBe('number');
      expect(parsed.tests).toHaveLength(3);
    });
  });

  describe('complianceToCIAnnotations', () => {
    it('should generate error annotations for failed required tests', () => {
      const annotations = complianceToCIAnnotations(report);

      const errors = annotations.filter((a) => a.startsWith('::error::'));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('vector-store:r2');
      expect(errors[0]).toContain('required');
    });

    it('should not generate annotations when all tests pass', async () => {
      const suite = new ContractSuiteBuilder('sandbox', 'S')
        .required('t', 'T', 'D', async () => timedTest(async () => ({ passed: true })))
        .build();

      const allPassReport = await runContractSuite({ suite, adapter: {} });
      const annotations = complianceToCIAnnotations(allPassReport);

      expect(annotations).toHaveLength(0);
    });
  });

  describe('complianceBadge', () => {
    it('should produce badge text with suite name and level', () => {
      const badge = complianceBadge(report);
      expect(badge).toContain('VectorStore Contract');
      expect(badge).toMatch(/\d+%/);
    });
  });

  describe('complianceSummary', () => {
    it('should produce a markdown summary table for multiple reports', async () => {
      const suite2 = new ContractSuiteBuilder('sandbox', 'Sandbox Contract')
        .required('t', 'T', 'D', async () => timedTest(async () => ({ passed: true })))
        .build();
      const report2 = await runContractSuite({ suite: suite2, adapter: {} });

      const summary = complianceSummary([report, report2]);

      expect(summary).toContain('# Contract Compliance Summary');
      expect(summary).toContain('VectorStore Contract');
      expect(summary).toContain('Sandbox Contract');
      expect(summary).toContain('vector-store');
      expect(summary).toContain('sandbox');
    });
  });
});

// ===========================================================================
// Built-in suite structure tests
// ===========================================================================

describe('Built-in contract suites', () => {
  describe('VECTOR_STORE_CONTRACT', () => {
    it('should be a valid contract suite', () => {
      expect(VECTOR_STORE_CONTRACT.adapterType).toBe('vector-store');
      expect(VECTOR_STORE_CONTRACT.name).toBe('VectorStore Contract');
      expect(VECTOR_STORE_CONTRACT.tests.length).toBeGreaterThan(0);
    });

    it('should have required tests', () => {
      const required = VECTOR_STORE_CONTRACT.tests.filter((t) => t.category === 'required');
      expect(required.length).toBeGreaterThanOrEqual(4);
    });

    it('should pass all tests against mock vector store', async () => {
      const store = createMockVectorStore();
      const report = await runContractSuite({
        suite: VECTOR_STORE_CONTRACT,
        adapter: store,
      });

      expect(report.complianceLevel).toBe('full');

      // Log any failures for debugging
      const failures = report.tests.filter((t) => t.status === 'failed');
      if (failures.length > 0) {
        for (const f of failures) {
          console.log(`FAILED: ${f.testId} — ${f.error}`);
        }
      }

      expect(report.summary.failed).toBe(0);
    });
  });

  describe('SANDBOX_CONTRACT', () => {
    it('should be a valid contract suite', () => {
      expect(SANDBOX_CONTRACT.adapterType).toBe('sandbox');
      expect(SANDBOX_CONTRACT.name).toBe('Sandbox Contract');
      expect(SANDBOX_CONTRACT.tests.length).toBeGreaterThan(0);
    });

    it('should have required tests', () => {
      const required = SANDBOX_CONTRACT.tests.filter((t) => t.category === 'required');
      expect(required.length).toBeGreaterThanOrEqual(3);
    });

    it('should pass all tests against mock sandbox', async () => {
      const sandbox = createMockSandbox();
      const report = await runContractSuite({
        suite: SANDBOX_CONTRACT,
        adapter: sandbox,
      });

      const failures = report.tests.filter((t) => t.status === 'failed');
      if (failures.length > 0) {
        for (const f of failures) {
          console.log(`FAILED: ${f.testId} — ${f.error}`);
        }
      }

      expect(report.complianceLevel).toBe('full');
      expect(report.summary.failed).toBe(0);
    });
  });

  describe('LLM_PROVIDER_CONTRACT', () => {
    it('should be a valid contract suite', () => {
      expect(LLM_PROVIDER_CONTRACT.adapterType).toBe('llm-provider');
      expect(LLM_PROVIDER_CONTRACT.name).toBe('LLM Provider Contract');
      expect(LLM_PROVIDER_CONTRACT.tests.length).toBeGreaterThan(0);
    });

    it('should have required tests', () => {
      const required = LLM_PROVIDER_CONTRACT.tests.filter((t) => t.category === 'required');
      expect(required.length).toBeGreaterThanOrEqual(2);
    });

    it('should pass all tests against mock LLM provider', async () => {
      const llm = createMockLLMProvider();
      const report = await runContractSuite({
        suite: LLM_PROVIDER_CONTRACT,
        adapter: llm,
      });

      const failures = report.tests.filter((t) => t.status === 'failed');
      if (failures.length > 0) {
        for (const f of failures) {
          console.log(`FAILED: ${f.testId} — ${f.error}`);
        }
      }

      expect(report.complianceLevel).toBe('full');
      expect(report.summary.failed).toBe(0);
    });
  });

  describe('EMBEDDING_PROVIDER_CONTRACT', () => {
    it('should be a valid contract suite', () => {
      expect(EMBEDDING_PROVIDER_CONTRACT.adapterType).toBe('embedding-provider');
      expect(EMBEDDING_PROVIDER_CONTRACT.name).toBe('Embedding Provider Contract');
      expect(EMBEDDING_PROVIDER_CONTRACT.tests.length).toBeGreaterThan(0);
    });

    it('should have required tests', () => {
      const required = EMBEDDING_PROVIDER_CONTRACT.tests.filter((t) => t.category === 'required');
      expect(required.length).toBeGreaterThanOrEqual(3);
    });

    it('should pass all tests against mock embedding provider', async () => {
      const provider = createMockEmbeddingProvider();
      const report = await runContractSuite({
        suite: EMBEDDING_PROVIDER_CONTRACT,
        adapter: provider,
      });

      const failures = report.tests.filter((t) => t.status === 'failed');
      if (failures.length > 0) {
        for (const f of failures) {
          console.log(`FAILED: ${f.testId} — ${f.error}`);
        }
      }

      expect(report.complianceLevel).toBe('full');
      expect(report.summary.failed).toBe(0);
    });
  });
});

// ===========================================================================
// Integration: full pipeline test
// ===========================================================================

describe('Full pipeline integration', () => {
  it('should run suite, generate markdown, JSON, and CI annotations', async () => {
    const store = createMockVectorStore();
    const report = await runContractSuite({
      suite: VECTOR_STORE_CONTRACT,
      adapter: store,
    });

    // Markdown
    const md = complianceToMarkdown(report);
    expect(md).toContain('VectorStore Contract');
    expect(md.length).toBeGreaterThan(100);

    // JSON
    const json = complianceToJSON(report);
    const parsed = JSON.parse(json);
    expect(parsed.complianceLevel).toBe('full');

    // CI annotations — should be empty for full compliance
    const annotations = complianceToCIAnnotations(report);
    expect(annotations).toHaveLength(0);

    // Badge
    const badge = complianceBadge(report);
    expect(badge).toContain('100%');
  });
});
