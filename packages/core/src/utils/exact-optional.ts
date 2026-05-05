/**
 * Strict-optional helpers for TypeScript's `exactOptionalPropertyTypes` mode.
 *
 * Domain-independent — usable from any package. Use `omitUndefined` to
 * strip explicitly-undefined keys from an object literal so the resulting
 * shape satisfies a target type whose optional keys forbid `undefined`.
 *
 * @example
 *   interface Cfg { name?: string }            // { name?: string } (no undefined)
 *   const cfg: Cfg = omitUndefined({ name: maybeString })
 */
type UndefinedKeys<T extends object> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never
}[keyof T]

type DefinedOptional<T extends object> = Partial<{
  [K in UndefinedKeys<T>]: Exclude<T[K], undefined>
}>

export type OmitUndefined<T extends object> = Omit<T, UndefinedKeys<T>> & DefinedOptional<T>

export function omitUndefined<TExpected extends object>(
  value: { [K in keyof TExpected]?: TExpected[K] | undefined },
): TExpected
export function omitUndefined<const T extends object>(value: T): OmitUndefined<T>
export function omitUndefined(value: object): object {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  )
}
