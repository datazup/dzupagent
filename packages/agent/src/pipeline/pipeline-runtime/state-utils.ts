export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
