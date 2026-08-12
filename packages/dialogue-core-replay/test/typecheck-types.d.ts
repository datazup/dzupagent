export type DeepMutable<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? DeepMutable<Item>[]
      : T extends object
        ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
        : T;
