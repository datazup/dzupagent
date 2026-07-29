/**
 * Index helpers that narrow away `noUncheckedIndexedAccess` without `!`.
 *
 * Tests index arrays constantly, usually right after asserting the length.
 * A non-null assertion would silence the compiler and the runtime together —
 * an out-of-range read would then surface as `Cannot read properties of
 * undefined` several lines later, pointing at a property access rather than
 * at the bad index. These keep the check and report the index that missed.
 */

/** An indexable sequence: a plain array or any numeric TypedArray. */
interface Indexed<T> {
  readonly length: number;
  readonly [index: number]: T | undefined;
}

/** Element at `index`, asserting it exists. */
export function at<T>(items: Indexed<T>, index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(
      `expected an element at index ${index}, but the sequence has length ${items.length}`
    );
  }
  return item;
}

/** First element, asserting the sequence is non-empty. */
export function first<T>(items: Indexed<T>): T {
  return at(items, 0);
}
