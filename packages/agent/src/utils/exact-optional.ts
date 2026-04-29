type UndefinedKeys<T extends object> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never
}[keyof T]

type DefinedOptional<T extends object> = Partial<{
  [K in UndefinedKeys<T>]: Exclude<T[K], undefined>
}>

export type OmitUndefined<T extends object> = Omit<T, UndefinedKeys<T>> & DefinedOptional<T>

export function omitUndefined<T extends object>(value: T): OmitUndefined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as OmitUndefined<T>
}
