import { mergeHooks, runHooks, runModifierHook } from '../hooks/hook-runner.js'
import type { AgentHooks } from '../hooks/hook-types.js'
import type { DzupEventBus } from '../events/event-bus.js'

/**
 * `AgentHooks` restated as a mapped type.
 *
 * `mergeHooks` is constrained to `Record<string, ...>`, and TypeScript only
 * grants an implicit index signature to *type aliases*, never to interfaces.
 * `AgentHooks` is an interface, so `mergeHooks<AgentHooks>` fails with TS2344
 * ("Type 'AgentHooks' does not satisfy the constraint ..."). That is precisely
 * why `mergeHooks` had no production call site: every existing caller worked
 * around it by re-declaring a local `type Hooks = { ... }` alias in its own
 * test file. A homomorphic mapped type over the interface produces a type
 * alias, which does get the implicit index signature, so the framework's own
 * hook surface can finally be passed straight through.
 */
type AgentHookMap = { [K in keyof AgentHooks]: AgentHooks[K] }

/** Exact shape `mergeHooks<AgentHookMap>` returns: one contributor array per key. */
type MergedHooks = Partial<
  Record<keyof AgentHooks, Array<(...args: never[]) => Promise<unknown>>>
>

/**
 * Read one key's contributors back at the precise `AgentHooks` element type.
 *
 * `mergeHooks` erases entries to `(...args: never[]) => Promise<unknown>`,
 * which `runHooks` accepts as-is but `runModifierHook<T>` does not for the
 * value-returning hooks (`afterToolCall` needs `Promise<string | void>`,
 * `beforeModelCall` needs `Promise<BaseMessage[] | void>`). The assertion is
 * sound because `mergeHooks` only ever pushes functions it read off the
 * `Partial<AgentHooks>` inputs under this same key — it never synthesises or
 * re-keys one — so the runtime value is exactly `AgentHooks[K]`.
 */
function contributorsOf<K extends keyof AgentHooks>(
  merged: MergedHooks,
  key: K,
): NonNullable<AgentHooks[K]>[] {
  return (merged[key] ?? []) as NonNullable<AgentHooks[K]>[]
}

/**
 * Build one fan-out dispatcher for a hook whose return value is discarded.
 *
 * Returns `undefined` when no plugin and no agent config contributed that key,
 * so the composed object OMITS it. That absence is load-bearing: the run
 * boundary reads `config.hooks?.onRunStart` and short-circuits when it is
 * undefined, so an unregistered hook costs nothing and stays observably
 * distinct from a registered one.
 *
 * The rest parameter is what keeps this cast-free across all ten void keys —
 * `(...args: unknown[]) => Promise<void>` is assignable to every one of them.
 */
function voidFanOut(
  merged: MergedHooks,
  key: keyof AgentHooks,
  eventBus: DzupEventBus | undefined,
): ((...args: unknown[]) => Promise<void>) | undefined {
  const contributors = merged[key]
  if (!contributors || contributors.length === 0) return undefined
  return async (...args: unknown[]): Promise<void> => {
    await runHooks(contributors, eventBus, key, ...args)
  }
}

/** Options for {@link composeAgentHooks}. */
export interface ComposeAgentHooksOptions {
  /**
   * Bus that receives `hook:error` when a contributed hook throws.
   *
   * Error isolation itself is not re-implemented here — it is whatever
   * `runHooks` / `runModifierHook` already do: the throw is swallowed, a
   * `hook:error` carrying `hookName` is emitted, and the remaining
   * contributors still run.
   */
  eventBus?: DzupEventBus
}

/**
 * Collapse several `Partial<AgentHooks>` sets into ONE `AgentHooks` object.
 *
 * This is the adapter that was missing between `PluginRegistry.getHooks()` and
 * the run boundary. `getHooks()` returns `Partial<AgentHooks>[]` — an array —
 * while every `AgentHooks` key is a SINGLE optional function, so there was no
 * way to hand a plugin's hooks to an agent config at all. Consequently
 * `getHooks()` had zero production consumers and a plugin's `onRunStart` /
 * `onRunComplete` / `onRunError` were registered, aggregated, and never run.
 *
 * ## Ordering (contract)
 *
 * Contributors run in ARRAY ORDER, and for each key in the order their sets
 * appear. {@link PluginRegistry.toAgentHooks} fixes that order as
 * **every plugin in registration order, then the agent config's own hooks
 * last**. Two consequences, both deliberate:
 *
 *  - For the three value-returning hooks the LAST contributor decides the
 *    value that escapes, so the application's own hook has the final say and
 *    an ambient plugin can never silently overrule the app author.
 *  - Observers see plugin side effects already applied.
 *
 * ## Value threading
 *
 * `beforeToolCall`, `afterToolCall` and `beforeModelCall` are modifiers, not
 * observers: each contributor receives the value produced by the previous one,
 * and a `void`/`undefined` return passes the current value through unchanged.
 * Running these through the discard-style `runHooks` would silently drop every
 * transformation but the caller's original input, so they are threaded through
 * `runModifierHook` instead — the same primitive the single-hook call sites use.
 */
export function composeAgentHooks(
  hookSets: Array<Partial<AgentHooks> | undefined>,
  options?: ComposeAgentHooksOptions,
): AgentHooks {
  const eventBus = options?.eventBus
  const merged = mergeHooks<AgentHookMap>(...hookSets)
  const composed: AgentHooks = {}

  // --- Run lifecycle ---
  const onRunStart = voidFanOut(merged, 'onRunStart', eventBus)
  if (onRunStart) composed.onRunStart = onRunStart
  const onRunComplete = voidFanOut(merged, 'onRunComplete', eventBus)
  if (onRunComplete) composed.onRunComplete = onRunComplete
  const onRunError = voidFanOut(merged, 'onRunError', eventBus)
  if (onRunError) composed.onRunError = onRunError

  // --- Tool lifecycle (onToolError observes; the other two modify) ---
  const onToolError = voidFanOut(merged, 'onToolError', eventBus)
  if (onToolError) composed.onToolError = onToolError

  const beforeToolCall = contributorsOf(merged, 'beforeToolCall')
  if (beforeToolCall.length > 0) {
    composed.beforeToolCall = async (toolName, input, ctx) => {
      let current = input
      for (const hook of beforeToolCall) {
        current = await runModifierHook(
          hook,
          eventBus,
          'beforeToolCall',
          current,
          toolName,
          current,
          ctx,
        )
      }
      return current
    }
  }

  const afterToolCall = contributorsOf(merged, 'afterToolCall')
  if (afterToolCall.length > 0) {
    composed.afterToolCall = async (toolName, input, result, ctx) => {
      let current = result
      for (const hook of afterToolCall) {
        current = await runModifierHook(
          hook,
          eventBus,
          'afterToolCall',
          current,
          toolName,
          input,
          current,
          ctx,
        )
      }
      return current
    }
  }

  // --- Model lifecycle ---
  const beforeModelCall = contributorsOf(merged, 'beforeModelCall')
  if (beforeModelCall.length > 0) {
    composed.beforeModelCall = async (messages, modelId, ctx) => {
      let current = messages
      for (const hook of beforeModelCall) {
        current = await runModifierHook(
          hook,
          eventBus,
          'beforeModelCall',
          current,
          current,
          modelId,
          ctx,
        )
      }
      return current
    }
  }

  const afterModelCall = voidFanOut(merged, 'afterModelCall', eventBus)
  if (afterModelCall) composed.afterModelCall = afterModelCall
  const onModelError = voidFanOut(merged, 'onModelError', eventBus)
  if (onModelError) composed.onModelError = onModelError

  // --- Pipeline lifecycle ---
  const onPhaseChange = voidFanOut(merged, 'onPhaseChange', eventBus)
  if (onPhaseChange) composed.onPhaseChange = onPhaseChange
  const onApprovalRequired = voidFanOut(merged, 'onApprovalRequired', eventBus)
  if (onApprovalRequired) composed.onApprovalRequired = onApprovalRequired

  // --- Budget lifecycle ---
  const onBudgetWarning = voidFanOut(merged, 'onBudgetWarning', eventBus)
  if (onBudgetWarning) composed.onBudgetWarning = onBudgetWarning
  const onBudgetExceeded = voidFanOut(merged, 'onBudgetExceeded', eventBus)
  if (onBudgetExceeded) composed.onBudgetExceeded = onBudgetExceeded

  return composed
}
