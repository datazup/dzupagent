import type { HttpFetcherConfig, FetchResult, ExtractionConfig } from './types.js'
import { ContentExtractor } from './content-extractor.js'
import { fetchWithOutboundUrlPolicy, validateOutboundUrl } from '@dzupagent/core'

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
]

const DEFAULT_CONFIG: HttpFetcherConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
  respectRobotsTxt: true,
  followRedirects: true,
  maxRedirects: 5,
}

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`Blocked by robots.txt: ${url}`)
    this.name = 'RobotsDisallowedError'
  }
}

/** Whether an HTTP status code is retryable */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

/**
 * Lightweight HTTP fetcher using native Node.js `fetch()`.
 *
 * Features:
 * - Retry with exponential backoff
 * - User-agent rotation
 * - Redirect following with hop limit
 */
export class HttpFetcher {
  private readonly config: HttpFetcherConfig
  private readonly userAgents: string[]
  private readonly extractor: ContentExtractor
  private userAgentIndex = 0
  private readonly robotsCache = new Map<string, { fetchedAt: number; rules: RobotsRules | null }>()

  constructor(config?: Partial<HttpFetcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.userAgents = this.config.userAgents ?? DEFAULT_USER_AGENTS
    this.extractor = new ContentExtractor()
  }

  /** Fetch a URL and return extracted content */
  async fetch(
    url: string,
    options?: { timeout?: number; extraction?: Partial<ExtractionConfig> },
  ): Promise<FetchResult> {
    const timeout = options?.timeout ?? 30_000
    const startTime = Date.now()

    const response = await this.fetchWithRetry(url, timeout)
    const html = await response.text()
    const contentType = response.headers.get('content-type') ?? 'text/html'

    const extracted = this.extractor.extract(html, {
      mode: 'all',
      cleanHtml: true,
      ...options?.extraction,
    })

    return {
      url: response.url || url,
      status: response.status,
      contentType,
      text: extracted.text,
      title: extracted.title,
      description: extracted.description,
      author: extracted.author,
      publishedDate: extracted.publishedDate,
      html,
      durationMs: Date.now() - startTime,
      method: 'http',
    }
  }

  /** Fetch with exponential backoff retries */
  private async fetchWithRetry(url: string, timeout: number): Promise<Response> {
    let lastError: unknown = null
    let currentUrl = url
    let redirectCount = 0

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1)
        // Add jitter: 0-25% of delay
        const jitter = Math.random() * delay * 0.25
        await this.sleep(delay + jitter)
      }

      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)
        const userAgent = this.getNextUserAgent()

        if (this.config.respectRobotsTxt) {
          const allowed = await this.isAllowedByRobots(currentUrl, userAgent)
          if (!allowed) {
            clearTimeout(timeoutId)
            throw new RobotsDisallowedError(currentUrl)
          }
        }

        const response = await fetchWithOutboundUrlPolicy(currentUrl, {
          headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
          },
          signal: controller.signal,
        }, {
          policy: this.config.urlPolicy,
          maxRedirects: this.config.maxRedirects,
          followRedirects: this.config.followRedirects,
        })

        clearTimeout(timeoutId)

        // Preserve the historical no-follow mode response behavior.
        if (!this.config.followRedirects && isRedirect(response.status)) {
          const location = response.headers.get('location')
          if (location && redirectCount < this.config.maxRedirects) {
            currentUrl = new URL(location, currentUrl).href
            redirectCount++
            continue
          }
        }

        // Retry on retryable status codes
        if (isRetryableStatus(response.status) && attempt < this.config.maxRetries) {
          lastError = new Error(`HTTP ${response.status}`)
          continue
        }

        return response
      } catch (error: unknown) {
        lastError = error
        if (attempt === this.config.maxRetries) break

        // Don't retry on abort (timeout)
        if (error instanceof DOMException && error.name === 'AbortError') {
          break
        }
      }
    }

    throw new Error(
      `Failed to fetch ${url} after ${this.config.maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  }

  /** Get the next user-agent string via round-robin rotation */
  private getNextUserAgent(): string {
    const ua = this.userAgents[this.userAgentIndex % this.userAgents.length]
    this.userAgentIndex++
    return ua ?? DEFAULT_USER_AGENTS[0]!
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async isAllowedByRobots(url: string, userAgent: string): Promise<boolean> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return true
    }

    const rules = await this.getRobotsRules(parsed.origin)
    if (!rules) return true
    return evaluateRobots(rules, userAgent, parsed.pathname || '/')
  }

  private async getRobotsRules(origin: string): Promise<RobotsRules | null> {
    const ttlMs = 10 * 60 * 1000
    const now = Date.now()
    const cached = this.robotsCache.get(origin)
    if (cached && now - cached.fetchedAt < ttlMs) {
      return cached.rules
    }

    let rules: RobotsRules | null = null
    try {
      const robotsUrl = `${origin}/robots.txt`
      const validation = await validateOutboundUrl(robotsUrl, this.config.urlPolicy)
      if (!validation.ok) {
        this.robotsCache.set(origin, { fetchedAt: now, rules: null })
        return null
      }
      const response = await fetchWithOutboundUrlPolicy(validation.url, {
        headers: {
          'User-Agent': this.userAgents[0] ?? DEFAULT_USER_AGENTS[0]!,
          'Accept': 'text/plain,*/*;q=0.5',
        },
      }, {
        policy: this.config.urlPolicy,
        maxRedirects: this.config.maxRedirects,
      })
      if (response.ok) {
        rules = parseRobots(await response.text())
      }
    } catch {
      rules = null
    }

    this.robotsCache.set(origin, { fetchedAt: now, rules })
    return rules
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

interface RobotsRuleGroup {
  allow: string[]
  disallow: string[]
}

interface RobotsRules {
  groups: Map<string, RobotsRuleGroup>
}

function parseRobots(content: string): RobotsRules {
  const groups = new Map<string, RobotsRuleGroup>()
  let activeAgents: string[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? ''
    if (!line) continue
    const [rawKey, ...rest] = line.split(':')
    const key = rawKey?.trim().toLowerCase()
    const value = rest.join(':').trim()
    if (!key) continue

    if (key === 'user-agent') {
      const ua = value.toLowerCase()
      activeAgents = [ua]
      if (!groups.has(ua)) {
        groups.set(ua, { allow: [], disallow: [] })
      }
      continue
    }

    if (activeAgents.length === 0) continue
    if (key !== 'allow' && key !== 'disallow') continue

    for (const ua of activeAgents) {
      const group = groups.get(ua) ?? { allow: [], disallow: [] }
      if (key === 'allow') {
        group.allow.push(value)
      } else {
        group.disallow.push(value)
      }
      groups.set(ua, group)
    }
  }

  return { groups }
}

function evaluateRobots(rules: RobotsRules, userAgent: string, path: string): boolean {
  const group = selectGroup(rules.groups, userAgent.toLowerCase())
  if (!group) return true

  let bestAllow = -1
  let bestDisallow = -1

  for (const allow of group.allow) {
    if (!allow) continue
    if (path.startsWith(allow) && allow.length > bestAllow) {
      bestAllow = allow.length
    }
  }
  for (const disallow of group.disallow) {
    if (!disallow) continue
    if (path.startsWith(disallow) && disallow.length > bestDisallow) {
      bestDisallow = disallow.length
    }
  }

  if (bestAllow === -1 && bestDisallow === -1) return true
  return bestAllow >= bestDisallow
}

function selectGroup(groups: Map<string, RobotsRuleGroup>, userAgent: string): RobotsRuleGroup | undefined {
  for (const [pattern, group] of groups.entries()) {
    if (pattern === '*') continue
    if (userAgent.includes(pattern)) {
      return group
    }
  }
  return groups.get('*')
}
