/**
 * Locale manager — resolves localized strings with fallback.
 */

export type Locale = 'en' | 'es' | 'fr' | 'de' | 'ja' | 'zh' | 'ko' | 'pt' | 'ru'

export interface LocaleConfig {
  defaultLocale: Locale
  fallbackLocale: Locale
}

export interface LocaleStrings {
  [key: string]: string
}

/** Built-in English strings for error messages and prompts */
export const EN_STRINGS: LocaleStrings = {
  'error.unknown': 'An unknown error occurred',
  'error.timeout': 'The operation timed out',
  'error.provider_exhausted': 'All providers have been exhausted',
  'error.circuit_open': 'Circuit breaker is open — provider temporarily unavailable',
  'error.invalid_config': 'Invalid configuration provided',
  'error.validation_failed': 'Validation failed',
  'error.not_found': 'Resource not found',
  'error.permission_denied': 'Permission denied',
  'budget.warning': 'Budget usage has reached {percent}%',
  'budget.exceeded': 'Budget limit exceeded',
  'budget.remaining': '{amount} remaining of {total} budget',
  'status.running': 'Running',
  'status.completed': 'Completed',
  'status.failed': 'Failed',
  'status.pending': 'Pending',
  'status.cancelled': 'Cancelled',
  'memory.consolidating': 'Consolidating memory namespace: {namespace}',
  'memory.write_failed': 'Failed to write to memory store',
  'hook.error': 'Hook "{name}" threw an error',
  'plugin.loaded': 'Plugin "{name}" loaded successfully',
  'plugin.failed': 'Plugin "{name}" failed to initialize',
}

const DEFAULT_CONFIG: LocaleConfig = {
  defaultLocale: 'en',
  fallbackLocale: 'en',
}

/**
 * Locale manager — resolves localized strings with fallback.
 * Supports interpolation via `{key}` placeholders.
 */
export class LocaleManager {
  private readonly config: LocaleConfig
  private readonly locales = new Map<Locale, LocaleStrings>()

  constructor(config?: Partial<LocaleConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.locales.set('en', { ...EN_STRINGS })
  }

  /** Register strings for a locale */
  register(locale: Locale, strings: LocaleStrings): void {
    const existing = this.locales.get(locale)
    if (existing) {
      Object.assign(existing, strings)
    } else {
      this.locales.set(locale, { ...strings })
    }
  }

  /** Get a localized string by key, with optional interpolation params */
  t(key: string, locale?: Locale, params?: Record<string, string>): string {
    const resolvedLocale = locale ?? this.config.defaultLocale
    const primary = this.locales.get(resolvedLocale)
    const fallback = this.locales.get(this.config.fallbackLocale)

    const raw = primary?.[key] ?? fallback?.[key] ?? key

    if (!params) return raw
    return raw.replace(/\{(\w+)\}/g, (_match, k: string) => params[k] ?? `{${k}}`)
  }

  /** Get current default locale */
  get defaultLocale(): Locale {
    return this.config.defaultLocale
  }

  /** Set default locale */
  setLocale(locale: Locale): void {
    this.config.defaultLocale = locale
  }

  /** List available locales (those with registered strings) */
  listLocales(): Locale[] {
    return [...this.locales.keys()]
  }
}
