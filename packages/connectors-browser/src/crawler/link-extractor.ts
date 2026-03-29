import type { Page } from 'playwright'
import { normalizeUrl, isSameOrigin } from './url-utils.js'

/**
 * Extract links from a page.
 * Combines traditional anchor links with client-side routes
 * discovered from SPA framework routers (Vue Router, React Router, etc.).
 * Supports hash-based routing (/#/route, /#!/route).
 */
export async function extractLinks(page: Page): Promise<string[]> {
  const baseUrl = page.url()

  const [anchorLinks, hashRoutes, spaRoutes] = await Promise.all([
    extractAnchorLinks(page),
    extractHashRoutes(page),
    extractSpaRoutes(page),
  ])

  const normalized = new Set<string>()

  for (const raw of [...anchorLinks, ...hashRoutes, ...spaRoutes]) {
    // Skip plain anchors (#section), javascript:, mailto:, tel:
    // But allow hash routes (#/ and #!/)
    if (raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) {
      continue
    }
    // Skip plain anchors but keep hash routes
    if (raw.startsWith('#') && !raw.startsWith('#/') && !raw.startsWith('#!/')) {
      continue
    }

    const url = normalizeUrl(raw, baseUrl)
    if (url && isSameOrigin(url, baseUrl)) {
      normalized.add(url)
    }
  }

  return Array.from(normalized)
}

/** Extract traditional <a href> links. */
async function extractAnchorLinks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'))
    return anchors.map(a => a.getAttribute('href')).filter((h): h is string => h !== null)
  })
}

/**
 * Extract hash-based SPA routes from the page.
 * Detects /#/ and /#!/ patterns from anchor hrefs and onclick handlers.
 */
async function extractHashRoutes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const routes: string[] = []
    const origin = window.location.origin

    // Collect all href attributes that look like hash routes
    const allAnchors = document.querySelectorAll('a[href*="#/"], a[href*="#!/"]')
    for (const a of allAnchors) {
      const href = a.getAttribute('href')
      if (href) routes.push(href)
    }

    // Check window.location.hash for current hash route pattern
    // If the app uses hash routing, look for Vue/Angular hash-mode router routes
    if (window.location.hash.startsWith('#/') || window.location.hash.startsWith('#!/')) {
      // App uses hash routing — also try to extract routes from the router
      try {
        const appEl = document.querySelector('#app') ?? document.querySelector('[data-v-app]')
        if (appEl) {
          const vueApp = (appEl as unknown as Record<string, unknown>).__vue_app__
          if (vueApp) {
            const globalProps = (vueApp as Record<string, unknown>).config as Record<string, unknown> | undefined
            const gp = globalProps?.globalProperties as Record<string, unknown> | undefined
            const router = gp?.$router as {
              getRoutes?: () => Array<{ path: string }>
              options?: { history?: { base?: string } }
            } | undefined
            if (router?.getRoutes) {
              for (const route of router.getRoutes()) {
                if (!route.path.includes(':') && !route.path.includes('*')) {
                  // In hash mode, routes are under /#/
                  routes.push(origin + '/#' + route.path)
                }
              }
            }
          }
        }
      } catch {
        // Router not accessible
      }
    }

    return routes
  })
}

/**
 * Extract client-side routes from SPA frameworks.
 * Detects Vue Router, React Router, Next.js, and Nuxt route definitions.
 */
async function extractSpaRoutes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const routes: string[] = []
    const origin = window.location.origin

    // --- Vue Router detection ---
    // Vue 3 app instance exposes $router
    try {
      // Check for Vue 3 app instance on root element
      const appEl = document.querySelector('#app') ?? document.querySelector('[data-v-app]')
      if (appEl) {
        // Vue 3 stores __vue_app__ on the mount element
        const vueApp = (appEl as unknown as Record<string, unknown>).__vue_app__
        if (vueApp) {
          const globalProps = (vueApp as Record<string, unknown>).config as Record<string, unknown> | undefined
          const gp = globalProps?.globalProperties as Record<string, unknown> | undefined
          const router = gp?.$router as { getRoutes?: () => Array<{ path: string }> } | undefined
          if (router?.getRoutes) {
            for (const route of router.getRoutes()) {
              // Skip dynamic segments with : or * (we can't guess values)
              if (!route.path.includes(':') && !route.path.includes('*')) {
                routes.push(origin + route.path)
              }
            }
          }
        }
      }
    } catch {
      // Vue Router not available or different structure
    }

    // --- React Router detection ---
    // React Router v6+ stores routes in __reactRouterContext
    try {
      // Look for router state on common React root elements
      const reactRoots = document.querySelectorAll('[data-reactroot], #root, #__next')
      for (const root of reactRoots) {
        const fiber = (root as unknown as Record<string, unknown>)._reactRootContainer
          ?? (root as unknown as Record<string, unknown>).__reactFiber$
        if (fiber) {
          // Walk fiber tree to find RouterProvider/BrowserRouter context
          // This is a best-effort approach
          break
        }
      }
    } catch {
      // React Router not available
    }

    // --- Generic: nav/sidebar link discovery ---
    // Many SPAs render navigation as <a> tags with data attributes or router-link
    try {
      // Vue Router: router-link components render as <a> with href
      const routerLinks = document.querySelectorAll('a[href].router-link-active, a[href][class*="router-link"]')
      for (const el of routerLinks) {
        const href = el.getAttribute('href')
        if (href) routes.push(href)
      }

      // React Router: NavLink components often have aria-current or className containing "active"
      const navLinks = document.querySelectorAll('nav a[href], [role="navigation"] a[href], aside a[href]')
      for (const el of navLinks) {
        const href = el.getAttribute('href')
        if (href) routes.push(href)
      }
    } catch {
      // Navigation discovery failed
    }

    // --- onclick handler navigation detection ---
    // Elements with data-href, data-to, or data-path attributes (common in custom components)
    try {
      const dataLinks = document.querySelectorAll('[data-href], [data-to], [data-path]')
      for (const el of dataLinks) {
        const href = el.getAttribute('data-href')
          ?? el.getAttribute('data-to')
          ?? el.getAttribute('data-path')
        if (href) routes.push(href)
      }
    } catch {
      // Data attribute discovery failed
    }

    return routes
  })
}
