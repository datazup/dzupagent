/**
 * Playground static file serving routes.
 *
 * Serves pre-built playground SPA assets from a configurable directory.
 * Provides SPA fallback: all non-API, non-asset routes serve index.html.
 *
 * @example
 * ```ts
 * import { createPlaygroundRoutes } from './routes/playground.js'
 *
 * app.route('/playground', createPlaygroundRoutes({
 *   distDir: resolve(__dirname, '../../dzupagent-playground/dist'),
 * }))
 * ```
 */
import { Hono } from 'hono'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

export interface PlaygroundRouteConfig {
  /** Absolute path to the built playground dist/ directory */
  distDir: string
  /** HTML response hardening for the playground SPA. Pass `false` to disable. */
  securityHeaders?: PlaygroundSecurityHeadersConfig | false
}

export interface PlaygroundSecurityHeadersConfig {
  /** Defaults to `DENY`; pass `false` to disable. */
  xFrameOptions?: string | false
  /** Defaults to a self-hosted asset CSP with `frame-ancestors 'none'`; pass `false` to disable. */
  contentSecurityPolicy?: string | false
  /** Defaults to `nosniff`; pass `false` to disable. */
  xContentTypeOptions?: string | false
  /** Defaults to `no-referrer`; pass `false` to disable. */
  referrerPolicy?: string | false
}

/** Map file extensions to MIME types */
function getMimeType(ext: string): string {
  const mimes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
  }
  return mimes[ext] ?? 'application/octet-stream'
}

/** Check if a path has a static file extension */
function isStaticAsset(path: string): boolean {
  const ext = extname(path)
  return ext.length > 0 && ext !== '.html'
}

function resolveWithinRoot(rootDir: string, ...segments: string[]): string | null {
  const root = resolve(rootDir)
  const resolved = resolve(root, ...segments)
  if (resolved === root || resolved.startsWith(`${root}${sep}`)) {
    return resolved
  }
  return null
}

export function createPlaygroundRoutes(config: PlaygroundRouteConfig): Hono {
  const app = new Hono()
  const htmlSecurityHeaders = resolvePlaygroundSecurityHeaders(config.securityHeaders)

  /**
   * Resolve a request path to a relative file path within distDir.
   * Hono's `c.req.path` returns the full URL path (including mount prefix),
   * while route patterns in sub-apps are matched after stripping the prefix.
   * We use the wildcard param to get the path relative to the route.
   */
  async function serveFile(filePath: string, cacheControl: string): Promise<Response | null> {
    try {
      await stat(filePath)
      const content = await readFile(filePath)
      const ext = extname(filePath)
      const headers = new Headers({
        'Content-Type': getMimeType(ext),
        'Cache-Control': cacheControl,
      })
      if (ext === '.html') {
        for (const [name, value] of htmlSecurityHeaders) {
          headers.set(name, value)
        }
      }
      return new Response(content, {
        headers,
      })
    } catch {
      return null
    }
  }

  // Serve static assets (JS, CSS, images, fonts)
  app.get('/assets/:path{.+}', async (c) => {
    const assetRelative = c.req.param('path')
    const filePath = resolveWithinRoot(config.distDir, 'assets', assetRelative)
    if (!filePath) return c.notFound()
    const response = await serveFile(filePath, 'public, max-age=31536000, immutable')
    return response ?? c.notFound()
  })

  // Catch-all: serve static files or SPA fallback
  app.get('/:path{.*}', async (c) => {
    const requestPath = c.req.param('path') || 'index.html'

    // Try to serve the exact file if it looks like a static asset
    if (isStaticAsset(requestPath)) {
      const filePath = resolveWithinRoot(config.distDir, requestPath)
      if (!filePath) return c.notFound()
      const response = await serveFile(filePath, 'public, max-age=3600')
      if (response) return response
      return c.notFound()
    }

    // SPA fallback: serve index.html for all non-asset routes
    const indexPath = resolve(config.distDir, 'index.html')
    const response = await serveFile(indexPath, 'no-cache')
    if (response) {
      return response
    }
    return c.text(
      [
        '/playground is a static asset host, but index.html was not found.',
        'Configure runtimeConfig.playground.distDir to a built playground dist directory,',
        "or build the consuming app's playground assets and point distDir there.",
      ].join(' '),
      404
    )
  })

  return app
}

function resolvePlaygroundSecurityHeaders(
  config?: PlaygroundSecurityHeadersConfig | false,
): Array<[string, string]> {
  if (config === false) {
    return []
  }

  const headers: Array<[string, string | false | undefined]> = [
    ['X-Frame-Options', config?.xFrameOptions ?? 'DENY'],
    [
      'Content-Security-Policy',
      config?.contentSecurityPolicy
        ?? "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
    ],
    ['X-Content-Type-Options', config?.xContentTypeOptions ?? 'nosniff'],
    ['Referrer-Policy', config?.referrerPolicy ?? 'no-referrer'],
  ]
  return headers.flatMap(([name, value]) => typeof value === 'string' ? [[name, value]] : [])
}
