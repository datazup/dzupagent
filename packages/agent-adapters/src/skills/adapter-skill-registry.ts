/**
 * Registry of adapter skill compilers.
 *
 * Pre-registers compilers for all known providers so callers can
 * compile an AdapterSkillBundle for any supported provider via
 * a single `compile()` call.
 */

import type { AdapterProviderId } from '../types.js'
import type { AdapterSkillBundle, AdapterSkillCompiler, CompiledAdapterSkill } from './adapter-skill-types.js'
import type { AdapterSkillVersionStore, VersionedProjection } from './adapter-skill-version-store.js'
import { CodexSkillCompiler } from './compilers/codex-skill-compiler.js'
import { ClaudeSkillCompiler } from './compilers/claude-skill-compiler.js'
import { CliSkillCompiler } from './compilers/cli-skill-compiler.js'

export class AdapterSkillRegistry {
  private compilers = new Map<AdapterProviderId, AdapterSkillCompiler>()
  private bundles = new Map<string, AdapterSkillBundle>()

  /** Register a compiler for a provider. Overwrites any existing registration. */
  register(compiler: AdapterSkillCompiler): void {
    this.compilers.set(compiler.providerId, compiler)
  }

  /**
   * Register a skill bundle so it can be looked up by bundleId later.
   * Overwrites any existing registration for the same bundleId.
   */
  registerBundle(bundle: AdapterSkillBundle): { ok: true } {
    this.bundles.set(bundle.bundleId, bundle)
    return { ok: true }
  }

  /** Look up a previously registered bundle by bundleId. */
  getBundle(bundleId: string): AdapterSkillBundle | undefined {
    return this.bundles.get(bundleId)
  }

  /** Look up a compiler by provider ID. */
  getCompiler(providerId: AdapterProviderId): AdapterSkillCompiler | undefined {
    return this.compilers.get(providerId)
  }

  /**
   * Compile a bundle for the specified provider.
   * Throws if no compiler is registered for the provider.
   */
  compile(bundle: AdapterSkillBundle, providerId: AdapterProviderId): CompiledAdapterSkill {
    const compiler = this.compilers.get(providerId)
    if (!compiler) {
      throw new Error(`No skill compiler registered for provider '${providerId}'`)
    }
    return compiler.compile(bundle)
  }

  /** List all provider IDs that have a registered compiler. */
  listProviders(): AdapterProviderId[] {
    return [...this.compilers.keys()]
  }

  /**
   * Compile a bundle, auto-version it, and persist via the supplied store.
   *
   * The version number is derived from the latest stored version for the
   * same (bundleId, providerId) pair, incremented by one.
   */
  compileAndStore(
    bundle: AdapterSkillBundle,
    providerId: AdapterProviderId,
    versionStore: AdapterSkillVersionStore,
  ): VersionedProjection {
    const compiled = this.compile(bundle, providerId)
    const latest = versionStore.getLatest(bundle.bundleId, providerId)
    const newVersion = (latest?.version ?? 0) + 1
    const now = new Date().toISOString()

    // Mark previous latest as superseded
    if (latest) {
      latest.supersededAt = now
      latest.supersededBy = `v${newVersion}`
    }

    const projection: VersionedProjection = {
      projectionId: `${bundle.bundleId}-${providerId}-v${newVersion}`,
      bundleId: bundle.bundleId,
      providerId,
      version: newVersion,
      compiled,
      hash: compiled.hash,
      createdAt: now,
    }

    versionStore.save(projection)
    return projection
  }

  /**
   * Rollback a projection to a previous version via the store.
   *
   * Delegates to the store's rollback implementation, which creates a new
   * version entry containing the compiled output from the target version.
   */
  rollback(
    bundleId: string,
    providerId: AdapterProviderId,
    targetVersion: number,
    versionStore: AdapterSkillVersionStore,
  ): VersionedProjection {
    return versionStore.rollback(bundleId, providerId, targetVersion)
  }
}

/**
 * Create an AdapterSkillRegistry pre-loaded with compilers
 * for all known providers.
 */
export function createDefaultSkillRegistry(): AdapterSkillRegistry {
  const registry = new AdapterSkillRegistry()

  registry.register(new CodexSkillCompiler())
  registry.register(new ClaudeSkillCompiler())

  // CLI-family providers
  const cliProviders: AdapterProviderId[] = ['gemini', 'qwen', 'crush', 'goose', 'openrouter']
  for (const pid of cliProviders) {
    registry.register(new CliSkillCompiler(pid))
  }

  return registry
}
