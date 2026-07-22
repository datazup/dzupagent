/**
 * Stable memory-entry-ID derivation — resolves a citation identifier from a
 * raw retrieved record, independent of any store backend or the tracker facade.
 */

/**
 * Derive a stable memory entry ID from a record. Looks for common id fields
 * (`_key`, `id`, `key`) and falls back to a hash of the record's content
 * hash if present in provenance, else a synthetic `idx:{rank}` marker.
 */
export function deriveMemoryEntryId(
  record: Record<string, unknown>,
  fallbackRank: number
): string {
  if (typeof record["_key"] === "string" && record["_key"])
    return record["_key"];
  if (typeof record["id"] === "string" && record["id"]) return record["id"];
  if (typeof record["key"] === "string" && record["key"]) return record["key"];

  const prov = record["_provenance"];
  if (prov && typeof prov === "object") {
    const hash = (prov as Record<string, unknown>)["contentHash"];
    if (typeof hash === "string" && hash) return `hash:${hash}`;
  }

  return `idx:${fallbackRank}`;
}
