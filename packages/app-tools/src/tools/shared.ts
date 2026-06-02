import type { DomainToolDefinition } from "../types.js";

/**
 * Executable wrapper around a {@link DomainToolDefinition}.
 *
 * The registry stores pure metadata (schemas, permissions). The execution map
 * returned alongside it carries the runtime behaviour. Callers look up a tool
 * by name in the registry, then dispatch execution via the parallel map.
 */
export interface ExecutableDomainTool<
  TInput = Record<string, unknown>,
  TOutput = Record<string, unknown>,
> {
  definition: DomainToolDefinition;
  execute(input: TInput): Promise<TOutput>;
}

/**
 * The collection/storage type for heterogeneous {@link ExecutableDomainTool}s.
 *
 * Tool builders return tools with *different* concrete `TInput`/`TOutput`
 * generics (e.g. `ExecutableDomainTool<ClarifyInput, ClarifyOutput>`). To hold
 * them in a single array or `Map` we need one type that *every* concrete tool
 * is assignable to, with no per-tool cast.
 *
 * `ExecutableDomainTool<never, unknown>` is that type:
 *
 * - **Input is `never` (bottom type).** `execute`'s parameter is contravariant
 *   under `strictFunctionTypes`, so `execute(input: TInput)` is assignable to
 *   `execute(input: never)` for *any* `TInput` — because every `TInput` is a
 *   supertype of `never`. A wider input here (e.g. `Record<string, unknown>`)
 *   would reject narrower concrete tools, which is exactly why the old
 *   `ExecutableDomainTool` default forced `as unknown as` laundering.
 * - **Output is `unknown` (top type).** Return position is covariant, so
 *   `Promise<TOutput>` is assignable to `Promise<unknown>` for any `TOutput`.
 *
 * Use this as the element type of every tool collection. Recovering a concrete
 * `ExecutableDomainTool<TInput, TOutput>` from this type requires a single
 * documented downcast at the execution-dispatch boundary (the existential
 * unpack), keyed by the tool's `definition.name`.
 */
export type AnyExecutableDomainTool = ExecutableDomainTool<never, unknown>;
