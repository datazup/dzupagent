/**
 * Split text on markdown heading boundaries (## and ###).
 * Keeps the heading with its content.
 */
export function splitOnHeadings(text: string): string[] {
  const parts = text.split(/(?=^#{2,3}\s)/m)
  return parts.filter((p) => p.trim().length > 0)
}
