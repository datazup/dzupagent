import { createHash } from "node:crypto";

import {
  validateCompiledAgentDescriptor,
  type CompiledAgentDescriptor,
} from "@dzupagent/runtime-contracts/agent-blueprint";

import {
  verifyCompiledAgentDescriptorFingerprint,
} from "./compiler.js";
import type {
  InMemoryAgentHandlerRegistry,
} from "./handler-registry.js";
import {
  executeCompiledAgentBlueprint,
  type ExecuteCompiledAgentBlueprintInput,
  type ExecuteCompiledAgentBlueprintResult,
} from "./runtime.js";

export interface CompiledAgentRuntimeOptions {
  readonly descriptors: readonly CompiledAgentDescriptor[];
  readonly handlers: InMemoryAgentHandlerRegistry;
  /**
   * Aliases are host-owned catalog data. They select a compiled descriptor
   * only; they cannot load code, import a module, or change handler policy.
   */
  readonly aliases?: Readonly<Record<string, string>>;
}

export interface ResolvedCompiledAgent {
  readonly requestedId: string;
  readonly agentId: string;
  readonly resolutionSource: "id" | "alias";
  readonly descriptor: CompiledAgentDescriptor;
  readonly runtimeFingerprint: `sha256:${string}`;
}

export interface ExecuteRegisteredAgentInput
  extends Omit<ExecuteCompiledAgentBlueprintInput, "descriptor" | "handlers"> {
  readonly agentId: string;
}

export interface ExecuteRegisteredAgentResult
  extends ExecuteCompiledAgentBlueprintResult {
  readonly selection: Omit<ResolvedCompiledAgent, "descriptor">;
}

export class CompiledAgentRuntimeError extends Error {
  constructor(
    readonly code:
      | "DUPLICATE_AGENT"
      | "DUPLICATE_AGENT_NAME"
      | "UNKNOWN_AGENT"
      | "INVALID_AGENT_DESCRIPTOR"
      | "AGENT_DESCRIPTOR_FINGERPRINT_MISMATCH"
      | "INVALID_AGENT_ALIAS",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CompiledAgentRuntimeError";
  }
}

/**
 * Immutable string-selected runtime for compiled agent descriptors.
 *
 * All dynamic behavior is data selection over descriptors compiled from
 * published catalog refs. Executable behavior remains in the separately
 * supplied, host-owned handler registry. There is no eval, dynamic import, or
 * persona-name branch in this runtime.
 */
export class CompiledAgentRuntime {
  readonly #descriptors: ReadonlyMap<string, CompiledAgentDescriptor>;
  readonly #aliases: ReadonlyMap<string, string>;
  readonly #handlers: InMemoryAgentHandlerRegistry;
  readonly fingerprint: `sha256:${string}`;

  constructor(options: CompiledAgentRuntimeOptions) {
    const descriptors = new Map<string, CompiledAgentDescriptor>();
    for (const descriptor of options.descriptors) {
      assertDescriptor(descriptor);
      if (descriptors.has(descriptor.id)) {
        throw new CompiledAgentRuntimeError(
          "DUPLICATE_AGENT",
          `Agent "${descriptor.id}" is registered more than once.`,
        );
      }
      descriptors.set(descriptor.id, descriptor);
    }
    const aliases = new Map<string, string>();
    for (const [rawAlias, rawTarget] of Object.entries(options.aliases ?? {})) {
      const alias = normalizeName(rawAlias, "alias");
      const target = normalizeName(rawTarget, `target for alias "${alias}"`);
      if (descriptors.has(alias) || aliases.has(alias)) {
        throw new CompiledAgentRuntimeError(
          "DUPLICATE_AGENT_NAME",
          `Agent name "${alias}" is already registered.`,
        );
      }
      if (!descriptors.has(target)) {
        throw new CompiledAgentRuntimeError(
          "INVALID_AGENT_ALIAS",
          `Alias "${alias}" targets unknown agent "${target}".`,
        );
      }
      aliases.set(alias, target);
    }
    this.#descriptors = descriptors;
    this.#aliases = aliases;
    this.#handlers = options.handlers;
    this.fingerprint = fingerprintRuntime(descriptors, aliases);
    Object.freeze(this);
  }

  list(): readonly CompiledAgentDescriptor[] {
    return Object.freeze(
      [...this.#descriptors.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    );
  }

  resolve(requestedId: string): ResolvedCompiledAgent {
    const normalized = normalizeName(requestedId, "agent id");
    const agentId = this.#aliases.get(normalized) ?? normalized;
    const descriptor = this.#descriptors.get(agentId);
    if (!descriptor) {
      throw new CompiledAgentRuntimeError(
        "UNKNOWN_AGENT",
        `Unknown compiled agent "${normalized}".`,
      );
    }
    return Object.freeze({
      requestedId: normalized,
      agentId,
      resolutionSource: normalized === agentId ? "id" : "alias",
      descriptor,
      runtimeFingerprint: this.fingerprint,
    });
  }

  async execute(
    request: ExecuteRegisteredAgentInput,
  ): Promise<ExecuteRegisteredAgentResult> {
    const resolved = this.resolve(request.agentId);
    const result = await executeCompiledAgentBlueprint({
      ...request,
      descriptor: resolved.descriptor,
      handlers: this.#handlers,
    });
    return Object.freeze({
      ...result,
      selection: Object.freeze({
        requestedId: resolved.requestedId,
        agentId: resolved.agentId,
        resolutionSource: resolved.resolutionSource,
        runtimeFingerprint: resolved.runtimeFingerprint,
      }),
    });
  }
}

function assertDescriptor(descriptor: CompiledAgentDescriptor): void {
  const validation = validateCompiledAgentDescriptor(descriptor);
  if (!validation.valid) {
    throw new CompiledAgentRuntimeError(
      "INVALID_AGENT_DESCRIPTOR",
      validation.diagnostics
        .map(
          ({ code, path, message }) =>
            `${code} ${path}: ${message}`,
        )
        .join("; "),
    );
  }
  if (!verifyCompiledAgentDescriptorFingerprint(descriptor)) {
    throw new CompiledAgentRuntimeError(
      "AGENT_DESCRIPTOR_FINGERPRINT_MISMATCH",
      `Agent "${descriptor.id}" descriptor fingerprint does not match.`,
    );
  }
}

function normalizeName(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !isCanonicalAgentName(value)
  ) {
    throw new CompiledAgentRuntimeError(
      "INVALID_AGENT_ALIAS",
      `${label} must be a canonical kebab-case identifier.`,
    );
  }
  return value;
}

function isCanonicalAgentName(value: string): boolean {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) return false;
  return !value.endsWith("-") && !value.includes("--");
}

function fingerprintRuntime(
  descriptors: ReadonlyMap<string, CompiledAgentDescriptor>,
  aliases: ReadonlyMap<string, string>,
): `sha256:${string}` {
  const payload = {
    agents: [...descriptors.values()]
      .map(({ id, fingerprint }) => ({ id, fingerprint }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    aliases: [...aliases.entries()]
      .map(([alias, agentId]) => ({ alias, agentId }))
      .sort((left, right) => left.alias.localeCompare(right.alias)),
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")}`;
}
