/**
 * Shared base class for SDK-backed adapters (Claude, Codex).
 *
 * Centralises the small set of patterns that are *truly identical* between
 * the SDK adapters:
 *
 *   - {@link configure}         — shallow merge of partial config
 *   - {@link respondInteraction} — delegate to the active resolver
 *   - {@link resolveInteractionPolicy} — per-call → config → default
 *   - {@link warmup}             — pre-load the SDK module
 *   - {@link loadOptionalSdkModule} — dynamic import + ForgeError mapping
 *
 * Behaviour that differs between adapters (event mapping, interrupt quirks,
 * health checks, capability flags) intentionally stays in the concrete
 * subclasses so subtle provider-specific semantics are preserved.
 *
 * The class is `abstract` and must not be instantiated directly. The
 * concrete adapter must implement {@link loadSdk} so the optional peer
 * dependency stays a *peer* — the base class never imports the SDK module
 * statically.
 */

import { ForgeError } from '@dzupagent/core'

import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
  InteractionPolicy,
} from '../types.js'
import { InteractionResolver } from '../interaction/interaction-resolver.js'

/**
 * Minimal contract every SDK adapter must satisfy in addition to
 * {@link AgentCLIAdapter}. The base class operates only against this
 * structural shape — it never sees the concrete SDK type.
 */
export interface SdkLoader<TSdk = unknown> {
  /** Load (and cache) the optional peer SDK module. Throws on failure. */
  loadSdk(): Promise<TSdk>
}

export abstract class BaseSdkAdapter<TSdk = unknown>
  implements AgentCLIAdapter, SdkLoader<TSdk>
{
  /** Concrete subclass declares the literal provider id. */
  abstract readonly providerId: AdapterProviderId

  /**
   * Adapter-level configuration. Concrete subclasses read it directly when
   * building SDK-specific options.
   */
  protected config: AdapterConfig

  /**
   * Active interaction resolver for the in-flight execution. Created lazily
   * (per adapter convention) and cleared in the execute loop's finally
   * block.
   */
  protected resolver: InteractionResolver | null = null

  /**
   * AbortController for the in-flight execution. Subclasses set/clear it as
   * part of their stream loop. The base class does not touch it directly to
   * avoid clobbering provider-specific abort sequencing.
   */
  protected abortController: AbortController | null = null

  constructor(config: AdapterConfig = {}) {
    this.config = { ...config }
  }

  // -------------------------------------------------------------------------
  // AgentCLIAdapter — shared concrete methods
  // -------------------------------------------------------------------------

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  respondInteraction(interactionId: string, answer: string): boolean {
    return this.resolver?.respond(interactionId, answer) ?? false
  }

  /**
   * Pre-load the SDK module to eliminate cold-start latency on the first
   * `execute()` call. Identical for all SDK adapters.
   */
  async warmup(): Promise<void> {
    await this.loadSdk()
  }

  // -------------------------------------------------------------------------
  // Abstract — concrete adapters must implement these
  // -------------------------------------------------------------------------

  /**
   * Load and cache the optional peer SDK module.
   *
   * Implementations should call {@link loadOptionalSdkModule} with the
   * package name and provider id; that helper centralises the
   * dynamic-import + ForgeError pattern.
   */
  abstract loadSdk(): Promise<TSdk>

  abstract execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined>

  abstract resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined>

  abstract interrupt(): void

  abstract healthCheck(): Promise<HealthStatus>

  abstract getCapabilities(): AdapterCapabilityProfile

  // -------------------------------------------------------------------------
  // Protected helpers shared by the concrete adapters
  // -------------------------------------------------------------------------

  /**
   * Resolve the effective {@link InteractionPolicy} for a given execution
   * input. The lookup order is per-call options → adapter config → default
   * (`auto-approve`). Identical across SDK adapters.
   */
  protected resolveInteractionPolicy(input: AgentInput): InteractionPolicy {
    const perCall = input.options?.['interactionPolicy']
    if (
      perCall !== null &&
      typeof perCall === 'object' &&
      'mode' in (perCall as object)
    ) {
      return perCall as InteractionPolicy
    }
    return this.config.interactionPolicy ?? { mode: 'auto-approve' }
  }

  /**
   * Dispose and clear the active {@link InteractionResolver}, if any. Safe
   * to call multiple times. Concrete adapters invoke this in their stream
   * loop's `finally` block.
   */
  protected disposeResolver(): void {
    this.resolver?.dispose()
    this.resolver = null
  }

  /**
   * Dynamically import an optional peer SDK module and surface the standard
   * `ADAPTER_SDK_NOT_INSTALLED` ForgeError when the package is missing.
   *
   * The dynamic import uses a variable for the module name so TypeScript
   * does not try to resolve the optional peer dep at compile time.
   */
  protected async loadOptionalSdkModule<T>(
    packageName: string,
    options: {
      providerId: AdapterProviderId
      installHint?: string
    },
  ): Promise<T> {
    try {
      // Use an indirection variable so TS does not eagerly resolve the
      // optional peer dep at compile time.
      const sdkName = packageName
      const mod = (await import(/* webpackIgnore: true */ sdkName)) as T
      return mod
    } catch (cause: unknown) {
      const installHint =
        options.installHint ??
        `Run \`npm install ${packageName}\` or \`yarn add ${packageName}\``
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message:
          `${packageName} is not installed. ` +
          `Install it with: npm install ${packageName}`,
        recoverable: false,
        suggestion: installHint,
        cause: cause instanceof Error ? cause : undefined,
        context: { providerId: options.providerId, sdkPackage: packageName },
      })
    }
  }
}
