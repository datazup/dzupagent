/**
 * slugify.ts — skillName suffix sanitiser for the skill-chain lowerer.
 *
 * @module lower/lower-skill-chain/slugify
 */

/**
 * Reduce a free-form string to a safe skillName suffix.
 * Keeps ASCII alphanumerics and underscores; collapses others to `_`.
 */
export function slugify(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 48) : "unspecified";
}
