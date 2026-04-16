import type { z } from 'zod'

/** Context passed to a step executor at runtime. */
export interface StepContext {
  /** The agent's run session ID */
  sessionId: string
  /** Agent tools available during execution */
  tools: unknown[]
  /** Optional memory service reference */
  memory?: unknown
  /** Run metrics (token count, cost) */
  runMetrics?: {
    totalTokens: number
    estimatedCostUsd: number
  }
  /** Outputs from previously executed steps, keyed by step type */
  previousOutputs: Record<string, unknown>
}

/**
 * Descriptor for a custom step type.
 * @typeParam TConfig - Zod schema type for step configuration
 * @typeParam TOutput - Output type of step execution
 */
export interface StepTypeDescriptor<TConfig = unknown, TOutput = unknown> {
  /** Unique step type identifier (e.g., 'synthesize_report', 'web_search') */
  readonly type: string
  /** Zod schema for validating step configuration */
  readonly configSchema: z.ZodType<TConfig>
  /** Zod schema for validating step output */
  readonly outputSchema: z.ZodType<TOutput>
  /** Execute the step with the given config and context */
  execute(config: TConfig, ctx: StepContext): Promise<TOutput>
  /** Optional: name of the Playground component to render for this step type */
  playgroundComponent?: string
}

/**
 * Registry for custom pipeline step types.
 *
 * @example
 * ```ts
 * const registry = new StepTypeRegistry()
 * registry.register({
 *   type: 'synthesize_report',
 *   configSchema: z.object({ topic: z.string() }),
 *   outputSchema: z.object({ markdown: z.string() }),
 *   execute: async (config, ctx) => ({ markdown: `# ${config.topic}` }),
 * })
 * const descriptor = registry.get('synthesize_report')
 * ```
 */
export class StepTypeRegistry {
  private readonly descriptors = new Map<string, StepTypeDescriptor>()

  /**
   * Register a custom step type.
   * @throws if a step type with the same name is already registered
   */
  register<TConfig, TOutput>(descriptor: StepTypeDescriptor<TConfig, TOutput>): void {
    if (this.descriptors.has(descriptor.type)) {
      throw new Error(`Step type '${descriptor.type}' is already registered`)
    }
    this.descriptors.set(descriptor.type, descriptor as StepTypeDescriptor)
  }

  /**
   * Retrieve a registered step type descriptor.
   * Returns undefined if not found.
   */
  get(type: string): StepTypeDescriptor | undefined {
    return this.descriptors.get(type)
  }

  /**
   * List all registered step type identifiers.
   */
  list(): string[] {
    return Array.from(this.descriptors.keys())
  }

  /**
   * Check if a step type is registered.
   */
  has(type: string): boolean {
    return this.descriptors.has(type)
  }

  /**
   * Execute a registered step type by type identifier.
   * @throws if step type is not registered
   * @throws if config fails schema validation
   */
  async execute(type: string, rawConfig: unknown, ctx: StepContext): Promise<unknown> {
    const descriptor = this.descriptors.get(type)
    if (!descriptor) {
      throw new Error(`Unknown step type '${type}'. Registered types: ${this.list().join(', ')}`)
    }
    const config = descriptor.configSchema.parse(rawConfig)
    const output = await descriptor.execute(config, ctx)
    return descriptor.outputSchema.parse(output)
  }

  /**
   * Unregister a step type (useful in tests).
   */
  unregister(type: string): boolean {
    return this.descriptors.delete(type)
  }
}

/** Singleton default registry — can be overridden per-agent */
export const defaultStepTypeRegistry = new StepTypeRegistry()
