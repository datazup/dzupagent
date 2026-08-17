/**
 * Type-level lock for `createForgeTool`'s output typing.
 *
 * WHY THIS FILE IS SHAPED LIKE THIS: vitest does NOT typecheck, and this
 * package's `vitest.config.ts` has no `typecheck` block, so `expectTypeOf`
 * assertions are runtime no-ops under `vitest run`. What actually enforces
 * everything below is the compiler, via `tsconfig.flipcheck.json` — which,
 * unlike `tsconfig.json`, does NOT exclude `**\/__tests__/**` — run by
 * `scripts/check-test-typecheck.mjs` against a budget of 0 errors for `core`.
 *
 * So: the `it()` blocks cover runtime behaviour, and the surrounding
 * declarations are the real lock. If `ForgeToolConfig`'s `TOutput` default
 * regresses to `z.ZodType<string>`, the positive declarations stop compiling
 * and the flipcheck gate goes red.
 *
 * Contract under lock:
 *   1. Omitting `outputSchema` must NOT constrain `execute`'s return type. The
 *      runtime deliberately supports non-string returns
 *      (`typeof result === 'string' ? result : JSON.stringify(result)`), so the
 *      public type must not forbid them.
 *   2. Supplying `outputSchema` must still infer AND enforce the return type.
 *   3. `toModelOutput` must receive the real output type in both cases — in
 *      particular it must NOT be widened to `unknown` when `outputSchema` is
 *      omitted, because five call sites in `packages/connectors-browser`
 *      annotate that parameter as `string`.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import { z } from 'zod'
import { createForgeTool } from '../create-tool.js'
import type { ForgeToolConfig } from '../create-tool.js'

const inputSchema = z.object({ a: z.number(), b: z.number() })

/* ------------------------------------------------------------------ *
 * DIRECT LOCKS ON THE GENERIC DEFAULTS                                 *
 * These pin the exact thing that was wrong, independently of any       *
 * particular call site, so the lock cannot be decoupled from the type  *
 * under test by a fixture that carries its own annotation.             *
 * ------------------------------------------------------------------ */

/**
 * With no `outputSchema` type argument, `execute`'s return type must be
 * `Promise<unknown>` — i.e. unconstrained. This was `Promise<string>`, which
 * is the defect: it forbade the object returns the runtime supports.
 */
expectTypeOf<
  ForgeToolConfig<typeof inputSchema>['execute']
>().returns.toEqualTypeOf<Promise<unknown>>()

/** With an `outputSchema` type argument, the return type must track it. */
expectTypeOf<
  ForgeToolConfig<typeof inputSchema, z.ZodType<{ sum: number }>>['execute']
>().returns.toEqualTypeOf<Promise<{ sum: number }>>()

/** And `toModelOutput` must be typed by that same schema. */
expectTypeOf<
  NonNullable<
    ForgeToolConfig<typeof inputSchema, z.ZodType<{ sum: number }>>['toModelOutput']
  >
>().parameter(0).toEqualTypeOf<{ sum: number }>()

/* ------------------------------------------------------------------ *
 * POSITIVE LOCKS — these must COMPILE.                                 *
 * ------------------------------------------------------------------ */

/** No `outputSchema` + object return. This is the regression under lock. */
const noSchemaObjectTool = createForgeTool({
  id: 'no-schema-object',
  description: 'Adds numbers and returns an object',
  inputSchema,
  execute: async ({ a, b }) => ({ sum: a + b }),
})

/** No `outputSchema` + array return. */
const noSchemaArrayTool = createForgeTool({
  id: 'no-schema-array',
  description: 'Returns an array',
  inputSchema,
  execute: async ({ a, b }) => [a, b],
})

/** No `outputSchema` + string return — the previously-only-legal path. */
const noSchemaStringTool = createForgeTool({
  id: 'no-schema-string',
  description: 'Returns a string',
  inputSchema,
  execute: async ({ a, b }) => `${a}+${b}`,
})

/**
 * No `outputSchema` + `toModelOutput` reading a field off the object return.
 * Locks that the output type is INFERRED FROM `execute` and not widened to
 * `unknown`; if it were `unknown`, `out.sum` would be TS18046.
 */
const noSchemaToModelOutputTool = createForgeTool({
  id: 'no-schema-to-model-output',
  description: 'Formats an object return',
  inputSchema,
  execute: async ({ a, b }) => ({ sum: a + b }),
  toModelOutput: (out) => `sum=${out.sum}`,
})

/**
 * Source-compatibility lock for the five `packages/connectors-browser` call
 * sites: no `outputSchema`, `execute` explicitly annotated `Promise<string>`,
 * and `toModelOutput`'s parameter explicitly annotated `string`. Widening the
 * output type to a bare `unknown` breaks exactly this shape with TS2322,
 * because an explicit annotation cannot be rescued by contextual typing.
 */
const browserConnectorShapedTool = createForgeTool({
  id: 'browser-connector-shaped',
  description: 'Mirrors the connectors-browser call shape',
  inputSchema,
  execute: async ({ a, b }): Promise<string> => JSON.stringify({ sum: a + b }),
  toModelOutput: (output: string): string => output,
})

/** `outputSchema` supplied: return type is inferred and `toModelOutput` sees it. */
const withSchemaTool = createForgeTool({
  id: 'with-schema',
  description: 'Validated object return',
  inputSchema,
  outputSchema: z.object({ sum: z.number() }),
  execute: async ({ a, b }) => ({ sum: a + b }),
  toModelOutput: (out) => `sum=${out.sum}`,
})

/** The pre-existing explicit-type-argument form must keep working. */
const explicitTypeArgsTool = createForgeTool<
  typeof inputSchema,
  z.ZodType<{ sum: number }>
>({
  id: 'explicit-type-args',
  description: 'Explicit TOutput',
  inputSchema,
  execute: async ({ a, b }) => ({ sum: a + b }),
  toModelOutput: (out) => `sum=${out.sum}`,
})

/* ------------------------------------------------------------------ *
 * NEGATIVE LOCKS — these must REMAIN type errors.                      *
 * Each `@ts-expect-error` is itself checked: if the error disappears,   *
 * tsc reports TS2578 "Unused '@ts-expect-error' directive" and the      *
 * flipcheck gate goes red. That is what makes these non-vacuous.        *
 * ------------------------------------------------------------------ */

/** `outputSchema` present + wrong return shape must still be rejected. */
const wrongShapeTool = createForgeTool({
  id: 'wrong-shape',
  description: 'Return shape contradicts outputSchema',
  inputSchema,
  outputSchema: z.object({ sum: z.number() }),
  // @ts-expect-error - execute returns { sum: string }, outputSchema says number
  execute: async ({ a, b }) => ({ sum: `${a + b}` }),
})

/** `outputSchema` present + missing property must still be rejected. */
const missingPropTool = createForgeTool({
  id: 'missing-prop',
  description: 'Return omits a schema-required property',
  inputSchema,
  outputSchema: z.object({ sum: z.number(), label: z.string() }),
  // @ts-expect-error - execute omits `label`, which outputSchema requires
  execute: async ({ a, b }) => ({ sum: a + b }),
})

/**
 * No `outputSchema`: `toModelOutput` must NOT be handed `any`. If the inferred
 * output type were `any`, `out.nope` would compile and this directive would be
 * reported unused. This is the anti-vacuity lock for `noSchemaToModelOutputTool`.
 */
const noSchemaBadFieldTool = createForgeTool({
  id: 'no-schema-bad-field',
  description: 'Reads a field that does not exist on the inferred output',
  inputSchema,
  execute: async ({ a, b }) => ({ sum: a + b }),
  // @ts-expect-error - `nope` does not exist on the inferred `{ sum: number }`
  toModelOutput: (out) => `${out.nope}`,
})

/** `outputSchema` present: `toModelOutput` must be typed by the schema. */
const withSchemaBadFieldTool = createForgeTool({
  id: 'with-schema-bad-field',
  description: 'Reads a field absent from outputSchema',
  inputSchema,
  outputSchema: z.object({ sum: z.number() }),
  execute: async ({ a, b }) => ({ sum: a + b }),
  // @ts-expect-error - `nope` is not part of the outputSchema-inferred output
  toModelOutput: (out) => `${out.nope}`,
})

/* ------------------------------------------------------------------ *
 * RUNTIME COVERAGE                                                     *
 * The `JSON.stringify` arm of createForgeTool was previously reachable  *
 * only when `outputSchema` was supplied — through the no-schema path    *
 * the type system forbade any non-string return, so that arm was dead.  *
 * ------------------------------------------------------------------ */

describe('createForgeTool output typing', () => {
  it('JSON-stringifies an object return when no outputSchema is given', async () => {
    const result = await noSchemaObjectTool.invoke({ a: 3, b: 4 })

    expect(typeof result).toBe('string')
    expect(result).toBe('{"sum":7}')
    expect(JSON.parse(result as string)).toEqual({ sum: 7 })
  })

  it('JSON-stringifies an array return when no outputSchema is given', async () => {
    const result = await noSchemaArrayTool.invoke({ a: 1, b: 2 })

    expect(result).toBe('[1,2]')
  })

  it('passes a string return through unchanged when no outputSchema is given', async () => {
    const result = await noSchemaStringTool.invoke({ a: 1, b: 2 })

    expect(result).toBe('1+2')
  })

  it('routes an object return through toModelOutput when no outputSchema is given', async () => {
    const result = await noSchemaToModelOutputTool.invoke({ a: 5, b: 6 })

    expect(result).toBe('sum=11')
  })

  it('supports the connectors-browser call shape end to end', async () => {
    const result = await browserConnectorShapedTool.invoke({ a: 1, b: 2 })

    expect(result).toBe('{"sum":3}')
  })

  it('still validates against outputSchema when one is given', async () => {
    const result = await withSchemaTool.invoke({ a: 2, b: 3 })

    expect(result).toBe('sum=5')
  })

  it('still rejects output that violates outputSchema at runtime', async () => {
    const badTool = createForgeTool({
      id: 'runtime-bad',
      description: 'Violates its own outputSchema at runtime',
      inputSchema,
      outputSchema: z.object({ sum: z.number() }),
      execute: async () => ({ sum: 'not-a-number' }) as unknown as { sum: number },
    })

    await expect(badTool.invoke({ a: 1, b: 1 })).rejects.toThrow()
  })

  it('honours an explicitly supplied TOutput type argument', async () => {
    const result = await explicitTypeArgsTool.invoke({ a: 4, b: 4 })

    expect(result).toBe('sum=8')
  })

  it('keeps the negative-lock tools constructible at runtime', () => {
    // These exist to pin compiler behaviour; assert they are still real tools
    // so the declarations cannot be deleted without a runtime failure too.
    expect(wrongShapeTool.name).toBe('wrong-shape')
    expect(missingPropTool.name).toBe('missing-prop')
    expect(noSchemaBadFieldTool.name).toBe('no-schema-bad-field')
    expect(withSchemaBadFieldTool.name).toBe('with-schema-bad-field')
  })
})
