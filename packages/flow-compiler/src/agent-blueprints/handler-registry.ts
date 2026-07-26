import type {
  AgentHandlerDescriptor,
  AgentHandlerEffectClass,
  AgentHandlerKind,
} from "@dzupagent/runtime-contracts/agent-blueprint";

export type AgentHandler<Input = unknown, Output = unknown> = (
  input: Input,
) => Output | Promise<Output>;

export interface AgentHandlerRegistration<Input = unknown, Output = unknown>
  extends AgentHandlerDescriptor {
  readonly handler: AgentHandler<Input, Output>;
}

export interface AgentHandlerInvocationOptions {
  readonly allowedEffectClasses?: readonly AgentHandlerEffectClass[];
}

export class AgentHandlerRegistryError extends Error {
  constructor(
    readonly code:
      | "DUPLICATE_HANDLER"
      | "UNKNOWN_HANDLER"
      | "HANDLER_KIND_MISMATCH"
      | "HANDLER_EFFECT_DENIED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AgentHandlerRegistryError";
  }
}

/**
 * Safe string dispatch. Registrations are host-owned; models and catalog files
 * can select only known refs. There is no eval, dynamic import, or source text.
 */
export class InMemoryAgentHandlerRegistry {
  readonly #registrations = new Map<string, AgentHandlerRegistration>();

  constructor(registrations: readonly AgentHandlerRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: AgentHandlerRegistration): void {
    if (this.#registrations.has(registration.ref)) {
      throw new AgentHandlerRegistryError(
        "DUPLICATE_HANDLER",
        `Handler "${registration.ref}" is already registered.`,
      );
    }
    this.#registrations.set(registration.ref, Object.freeze({ ...registration }));
  }

  resolve(ref: string, expectedKind: AgentHandlerKind): AgentHandlerRegistration {
    const registration = this.#registrations.get(ref);
    if (!registration) {
      throw new AgentHandlerRegistryError(
        "UNKNOWN_HANDLER",
        `Handler "${ref}" is not registered.`,
      );
    }
    if (registration.kind !== expectedKind) {
      throw new AgentHandlerRegistryError(
        "HANDLER_KIND_MISMATCH",
        `Handler "${ref}" is ${registration.kind}; expected ${expectedKind}.`,
      );
    }
    return registration;
  }

  async invoke<Input, Output>(
    ref: string,
    expectedKind: AgentHandlerKind,
    input: Input,
    options: AgentHandlerInvocationOptions = {},
  ): Promise<Output> {
    const registration = this.resolve(ref, expectedKind);
    const allowed = options.allowedEffectClasses ?? ["none"];
    if (!allowed.includes(registration.effectClass)) {
      throw new AgentHandlerRegistryError(
        "HANDLER_EFFECT_DENIED",
        `Handler "${ref}" effect ${registration.effectClass} is not allowed.`,
      );
    }
    return (await registration.handler(input)) as Output;
  }
}
