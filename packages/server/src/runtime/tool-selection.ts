export function hasCategory(requested: Set<string>, category: string): boolean {
  return requested.has(category) || requested.has(`${category}:*`) || requested.has(`connector:${category}`)
}

export function pickEnabled(
  requested: Set<string>,
  names: Set<string>,
  category: string,
): string[] {
  if (hasCategory(requested, category)) return [...names]
  return [...names].filter((name) => requested.has(name))
}
