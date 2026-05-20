/**
 * Compile-time profile registry contract for the Flow DSL.
 *
 * A "profile" is a named bundle of agent-execution defaults — model id,
 * provider, instructions preamble, allowed toolset, and policy overlay —
 * that an `agent` node references by name via `agent.profile`.
 *
 * Stage 1.5 moves profile resolution from runtime (codev-app's
 * `agent-runtime-deps`) into the compiler so the emitted AST is
 * **profile-free**. Consumers that pass a `profileRegistry` to the compiler
 * get a flattened artifact where every `agent` node carries its own
 * `model`, `provider`, `instructions`, `tools[]`, and `policy` — no
 * indirect refs survive to the runtime.
 *
 * The compiler-side interface is intentionally minimal and **duck-typed**:
 * a host application's own registry (e.g. codev-app's
 * `InMemoryProfileRegistry`) implements both its own consumer contract and
 * this interface by shape, without an explicit `implements` clause and
 * without the framework taking a dependency on app code. This keeps the
 * framework / app layering clean (framework → app is forbidden; app →
 * framework is fine).
 *
 * ### Precedence rule
 *
 * Node-level fields always win. Profile fields fill gaps:
 *
 *   final.model        = node.model        ?? profile.model
 *   final.provider     = node.provider     ?? profile.provider
 *   final.instructions = node.instructions ?? profile.instructions (when empty)
 *   final.toolset      = node.toolset      ?? profile.toolset
 *   final.policy       = node.policy ⊕ profile.policy (shallow merge,
 *                                                       node fields win)
 *
 * After flattening the compiler strips `node.profile` from the AST so the
 * lowered artifact and the downstream runtime never see an unresolved ref.
 *
 * ### Compile-time only
 *
 * `ProfileRegistry.lookup` is **synchronous** by contract. Profiles are
 * expected to be in-process workspace defaults; async/DB-backed lookups
 * should be cached into an in-memory snapshot before constructing the
 * compiler. Aligning sync-only with the existing toolset/persona resolver
 * idioms (which support async) is intentional — profiles are configuration,
 * not runtime resolution work.
 */

/**
 * Flat profile shape consumed by the compiler.
 *
 * All fields are optional so a profile can supply any subset of agent
 * defaults. A profile that supplies nothing is legal but a no-op.
 */
export interface ResolvedProfile {
  /** Default `agent.model` (ModelRegistry id). */
  model?: string
  /** Default `agent.provider` (routing hint). */
  provider?: string
  /**
   * Default `agent.instructions` preamble. Only used when the node's
   * `instructions` is the empty string (the parser allows authoring an
   * intentionally empty preamble to opt in to profile-supplied defaults).
   */
  instructions?: string
  /**
   * Default `agent.toolset` name. The compiler's toolset resolver will
   * still expand this into `tools[]` in the next semantic sub-pass; the
   * profile only contributes the reference, not the expansion.
   */
  toolset?: string
  /**
   * Default `agent.policy`. Shallow-merged with node-level policy
   * (node fields win on collision).
   */
  policy?: ResolvedProfilePolicy
}

/**
 * Subset of `AgentPolicy` (defined in `@dzupagent/flow-ast`) that a profile
 * is allowed to supply. Mirrors the public AgentPolicy shape but is
 * redeclared locally so flow-compiler does not need a type-only import
 * from flow-ast for this interface (the AST module already re-exports it,
 * so consumers can pass an `AgentPolicy` value directly — duck-typing).
 */
export interface ResolvedProfilePolicy {
  timeoutMs?: number
  budgetCents?: number
  maxToolCalls?: number
  workingDirectory?: string
  approval?: {
    requiredFor?: string[]
  }
  audit?: {
    captureToolCalls?: boolean
    captureDiffs?: boolean
  }
}

/**
 * Optional scope passed to `lookup()`. The compiler currently has no
 * tenant context of its own, but a future API may thread one through — the
 * scope hook keeps that path open without a breaking change.
 */
export interface ProfileLookupScope {
  tenantId?: string
}

/**
 * Compile-time profile resolver. Implementations should return `undefined`
 * for unknown refs — the compiler turns the absent result into an
 * `UNRESOLVED_PROFILE_REF` Stage 3 error.
 */
export interface ProfileRegistry {
  /**
   * Resolve a profile reference by name. Synchronous by contract — see
   * the module doc-comment for the rationale.
   *
   * Implementations should return a fresh object (or a defensive copy);
   * the compiler will not mutate the returned value, but downstream
   * consumers may.
   */
  lookup(ref: string, scope?: ProfileLookupScope): ResolvedProfile | undefined
}
