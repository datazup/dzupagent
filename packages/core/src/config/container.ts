/**
 * Lightweight DI container for ForgeAgent service wiring.
 *
 * Every service is a lazy singleton: the factory runs on the first
 * `get()` call, and the result is cached for all subsequent calls.
 *
 * @example
 * ```ts
 * const container = createContainer()
 *   .register('eventBus', () => createEventBus())
 *   .register('registry', () => new ModelRegistry())
 *   .register('memory', (c) => new MemoryService(c.get('store')));
 *
 * const bus = container.get<ForgeEventBus>('eventBus');
 * ```
 */

type Factory<T> = (container: ForgeContainer) => T;

export class ForgeContainer {
  private readonly factories = new Map<string, Factory<unknown>>();
  private readonly instances = new Map<string, unknown>();

  /** Register a factory for a named service (lazy singleton). */
  register<T>(name: string, factory: Factory<T>): this {
    this.factories.set(name, factory as Factory<unknown>);
    // Clear cached instance so re-registration takes effect.
    this.instances.delete(name);
    return this;
  }

  /** Get or create a service by name. Throws if not registered. */
  get<T>(name: string): T {
    if (this.instances.has(name)) {
      return this.instances.get(name) as T;
    }
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`ForgeContainer: service "${name}" is not registered.`);
    }
    const instance = factory(this);
    this.instances.set(name, instance);
    return instance as T;
  }

  /** Check if a service is registered. */
  has(name: string): boolean {
    return this.factories.has(name);
  }

  /** List all registered service names. */
  list(): string[] {
    return [...this.factories.keys()];
  }

  /** Reset all cached instances (useful for testing). Factories are kept. */
  reset(): void {
    this.instances.clear();
  }
}

/** Create a new empty container. */
export function createContainer(): ForgeContainer {
  return new ForgeContainer();
}
