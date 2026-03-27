/**
 * Contract Test Generator — creates contract suites from adapter interface definitions.
 *
 * Provides a builder pattern for defining contract test suites with
 * required, recommended, and optional test categories.
 */

import type {
  AdapterType,
  ContractSuite,
  ContractTest,
  ContractTestCategory,
  ContractTestResult,
} from './contract-types.js';

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builder for constructing ContractSuite instances with a fluent API.
 *
 * @example
 * ```ts
 * const suite = new ContractSuiteBuilder('vector-store', 'VectorStore Contract')
 *   .description('Tests VectorStore adapter conformance')
 *   .required('put-and-get', 'put() then get()', 'Stores and retrieves documents', async (adapter) => {
 *     // ... test logic
 *     return { passed: true, duration: 10 };
 *   })
 *   .build();
 * ```
 */
export class ContractSuiteBuilder {
  private readonly _adapterType: AdapterType;
  private readonly _name: string;
  private _description = '';
  private readonly _tests: ContractTest[] = [];
  private _setup?: () => Promise<void>;
  private _teardown?: () => Promise<void>;

  constructor(adapterType: AdapterType, name: string) {
    this._adapterType = adapterType;
    this._name = name;
  }

  /** Set the suite description */
  description(desc: string): this {
    this._description = desc;
    return this;
  }

  /** Add a required test */
  required(
    id: string,
    name: string,
    description: string,
    run: (adapter: unknown) => Promise<ContractTestResult>,
  ): this {
    return this.addTest(id, name, description, 'required', run);
  }

  /** Add a recommended test */
  recommended(
    id: string,
    name: string,
    description: string,
    run: (adapter: unknown) => Promise<ContractTestResult>,
  ): this {
    return this.addTest(id, name, description, 'recommended', run);
  }

  /** Add an optional test */
  optional(
    id: string,
    name: string,
    description: string,
    run: (adapter: unknown) => Promise<ContractTestResult>,
  ): this {
    return this.addTest(id, name, description, 'optional', run);
  }

  /** Set a setup function to run before all tests */
  beforeAll(fn: () => Promise<void>): this {
    this._setup = fn;
    return this;
  }

  /** Set a teardown function to run after all tests */
  afterAll(fn: () => Promise<void>): this {
    this._teardown = fn;
    return this;
  }

  /** Build the ContractSuite */
  build(): ContractSuite {
    if (this._tests.length === 0) {
      throw new Error(`ContractSuite "${this._name}" has no tests`);
    }

    return {
      adapterType: this._adapterType,
      name: this._name,
      description: this._description,
      tests: [...this._tests],
      setup: this._setup,
      teardown: this._teardown,
    };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private addTest(
    id: string,
    name: string,
    description: string,
    category: ContractTestCategory,
    run: (adapter: unknown) => Promise<ContractTestResult>,
  ): this {
    const fullId = `${this._adapterType}:${id}`;

    // Check for duplicate IDs
    if (this._tests.some((t) => t.id === fullId)) {
      throw new Error(`Duplicate test ID: "${fullId}" in suite "${this._name}"`);
    }

    this._tests.push({ id: fullId, name, description, category, run });
    return this;
  }
}

// ---------------------------------------------------------------------------
// Helper: timed test wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a test function to automatically measure duration and catch errors.
 * Use this when defining contract test `run` functions.
 */
export async function timedTest(
  fn: () => Promise<Partial<ContractTestResult>>,
): Promise<ContractTestResult> {
  const start = performance.now();
  try {
    const result = await fn();
    const duration = performance.now() - start;
    return {
      passed: result.passed ?? true,
      duration,
      error: result.error,
      details: result.details,
    };
  } catch (err) {
    const duration = performance.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { passed: false, duration, error: message };
  }
}
