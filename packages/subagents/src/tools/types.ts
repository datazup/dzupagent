/**
 * Provider-neutral tool descriptor. Hosts adapt these to their concrete tool
 * type (`StructuredToolInterface`, `DomainToolDefinition`, …). Keeping the shape
 * minimal preserves the package's layer-2 portability — it does not depend on any
 * particular tool framework.
 *
 * Defined in this leaf module (rather than `subagent-tools.ts`) so that both
 * `subagent-tools.ts` and `fanout-tool.ts` can import the type without forming
 * an import cycle: `subagent-tools.ts` value-imports functions from
 * `fanout-tool.ts` in a single direction, and both files type-import this
 * descriptor from `./types.js`.
 */
export interface SubagentToolDescriptor<
  TArgs = Record<string, unknown>,
  TResult = unknown
> {
  name: string;
  description: string;
  /** JSON-schema-ish parameter description for host binding/validation. */
  parameters: Record<string, unknown>;
  invoke(args: TArgs): Promise<TResult>;
}
