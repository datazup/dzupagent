/**
 * useStatusBadge -- shared mapping helpers from semantic statuses / capability
 * states / marketplace categories to playground design-system badge classes.
 *
 * Views should call these helpers instead of inlining raw Tailwind palette
 * classes such as `bg-blue-100 text-blue-700`. The classes returned here are
 * the semantic `pg-badge-*` utilities defined in `assets/main.css`, which
 * derive their colors from the playground theme tokens and therefore react
 * correctly to dark / light mode overrides.
 *
 * The helpers are intentionally pure functions (not Vue composables that hold
 * reactive state) so they can be used both inside `<script setup>` and in
 * unit tests without any setup.
 */

/** Semantic variant names used by the playground badge utilities. */
export type BadgeVariant =
  | 'neutral'
  | 'muted'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'accent'
  | 'violet'
  | 'cyan'
  | 'rose'

/** Map a semantic variant name to the corresponding playground utility class. */
export function badgeVariantClass(variant: BadgeVariant): string {
  return `pg-badge-${variant}`
}

/**
 * Map a run / eval status string to the badge variant. Unknown statuses fall
 * back to `muted`. Aliases (`queued` → `pending`, `executing` → `running`)
 * are normalised here so callers don't have to.
 */
export function statusBadgeVariant(status: string): BadgeVariant {
  switch (status) {
    case 'pending':
    case 'queued':
      return 'neutral'
    case 'running':
    case 'executing':
      return 'info'
    case 'completed':
    case 'success':
      return 'success'
    case 'failed':
    case 'rejected':
    case 'error':
      return 'danger'
    case 'cancelled':
      return 'muted'
    case 'awaiting_approval':
      return 'warning'
    default:
      return 'muted'
  }
}

/** Class helper for status badges (run history, eval dashboard, etc.). */
export function statusBadgeClass(status: string): string {
  return badgeVariantClass(statusBadgeVariant(status))
}

/**
 * Map a capability status (`active` / `degraded` / `dropped` / `unsupported`)
 * to a badge variant. Unknown values fall back to `muted`.
 */
export function capabilityBadgeVariant(cap: string): BadgeVariant {
  switch (cap) {
    case 'active':
      return 'success'
    case 'degraded':
      return 'warning'
    case 'dropped':
      return 'danger'
    case 'unsupported':
      return 'muted'
    default:
      return 'muted'
  }
}

/** Class helper for capability matrix badges. */
export function capabilityBadgeClass(cap: string): string {
  return badgeVariantClass(capabilityBadgeVariant(cap))
}

/**
 * Map a marketplace agent category to a badge variant. The mapping mirrors
 * the legacy color palette used in `AgentCard.vue` but routes through the
 * semantic playground tokens.
 */
export function categoryBadgeVariant(category: string): BadgeVariant {
  switch (category) {
    case 'observability':
      return 'info'
    case 'memory':
      return 'violet'
    case 'security':
      return 'warning'
    case 'codegen':
      return 'success'
    case 'integration':
      return 'cyan'
    case 'testing':
      return 'rose'
    default:
      return 'muted'
  }
}

/** Class helper for marketplace category badges. */
export function categoryBadgeClass(category: string): string {
  return badgeVariantClass(categoryBadgeVariant(category))
}
