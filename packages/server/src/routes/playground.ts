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
 *   distDir: resolve(__dirname, '../../forgeagent-playground/dist'),
 * }))
 * ```
 */
import { Hono } from 'hono'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname } from 'node:path'

export interface PlaygroundRouteConfig {
  /** Absolute path to the built playground dist/ directory */
  distDir: string
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

export function createPlaygroundRoutes(config: PlaygroundRouteConfig): Hono {
  const app = new Hono()

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
      return new Response(content, {
        headers: {
          'Content-Type': getMimeType(ext),
          'Cache-Control': cacheControl,
        },
      })
    } catch {
      return null
    }
  }

  // Serve static assets (JS, CSS, images, fonts)
  app.get('/assets/:path{.+}', async (c) => {
    const assetRelative = c.req.param('path')
    const filePath = resolve(config.distDir, 'assets', assetRelative)
    const response = await serveFile(filePath, 'public, max-age=31536000, immutable')
    return response ?? c.notFound()
  })

  // Catch-all: serve static files or SPA fallback
  app.get('/:path{.*}', async (c) => {
    const requestPath = c.req.param('path') || 'index.html'

    // Try to serve the exact file if it looks like a static asset
    if (isStaticAsset(requestPath)) {
      const filePath = resolve(config.distDir, requestPath)
      const response = await serveFile(filePath, 'public, max-age=3600')
      if (response) return response
      return c.notFound()
    }

    // SPA fallback: serve index.html for all non-asset routes
    const indexPath = resolve(config.distDir, 'index.html')
    const response = await serveFile(indexPath, 'no-cache')
    if (response) {
      // Override content-type to text/html for the SPA fallback
      return c.html(await readFile(indexPath, 'utf-8'))
    }
    return c.text('Playground not built. Run: yarn workspace @forgeagent/playground build', 404)
  })

  return app
}
