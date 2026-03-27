/**
 * Extracts API contracts from generated backend code in a VFS.
 * Parses route definitions, Zod schemas, and type exports without LLM calls.
 *
 * Extracted from apps/api feature-generator.graph.ts extractContract().
 */

import type { ApiEndpoint, ApiContract } from './contract-types.js'

const MAX_SECTION_LENGTH = 6000

export class ApiExtractor {
  /** Extract API contract from a virtual filesystem snapshot. */
  extract(vfs: Record<string, string>): ApiContract {
    const endpoints: ApiEndpoint[] = []
    let sharedTypes = ''
    let zodSchemas = ''

    // Route/controller pattern: router.get('/path', ...) or app.post('/path', ...)
    const routeRegex = /(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi

    // Type/interface export pattern
    const typeExportRegex = /export\s+(?:interface|type)\s+(\w+)/g

    for (const [filePath, content] of Object.entries(vfs)) {
      // Extract route endpoints from route/controller files
      if (filePath.includes('.routes.') || filePath.includes('.controller.') || filePath.includes('/routes/')) {
        routeRegex.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = routeRegex.exec(content)) !== null) {
          const method = match[1]!
          const path = match[2]!

          // Try to find a description comment above the route
          const lineIdx = content.substring(0, match.index).split('\n').length - 1
          const lines = content.split('\n')
          const prevLine = lines[lineIdx - 1]?.trim() ?? ''
          const description = prevLine.startsWith('//')
            ? prevLine.replace(/^\/\/\s*/, '')
            : `${method.toUpperCase()} ${path}`

          // Check for auth middleware
          const routeLineEnd = content.indexOf('\n', match.index)
          const routeLine = content.substring(
            match.index,
            routeLineEnd >= 0 ? routeLineEnd : content.length,
          )
          const auth = /auth|authenticate|protect|requireAuth/i.test(routeLine)

          endpoints.push({ method, path, auth, description })
        }
      }

      // Collect Zod schemas
      if (
        filePath.includes('.validator.') ||
        filePath.includes('.schema.') ||
        filePath.includes('/validators/') ||
        filePath.includes('/schemas/')
      ) {
        zodSchemas += `// --- ${filePath} ---\n${content}\n\n`
      }

      // Collect shared type definitions
      if (
        filePath.includes('.types.') ||
        filePath.includes('/types/') ||
        filePath.includes('.dto.')
      ) {
        sharedTypes += `// --- ${filePath} ---\n${content}\n\n`
      }
    }

    // If no structured types found, try extracting exported types from service files
    if (!sharedTypes) {
      for (const [filePath, content] of Object.entries(vfs)) {
        if (filePath.includes('.service.') || filePath.includes('.controller.')) {
          const typeMatches: string[] = []
          typeExportRegex.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = typeExportRegex.exec(content)) !== null) {
            // Extract the full type/interface block
            const startIdx = content.lastIndexOf('\n', match.index) + 1
            let braceCount = 0
            let endIdx = startIdx
            for (let i = match.index; i < content.length; i++) {
              if (content[i] === '{') braceCount++
              if (content[i] === '}') braceCount--
              if (braceCount === 0 && i > match.index + 10) {
                endIdx = i + 1
                break
              }
            }
            if (endIdx > startIdx) {
              typeMatches.push(content.substring(startIdx, endIdx))
            }
          }
          if (typeMatches.length > 0) {
            sharedTypes += `// --- ${filePath} ---\n${typeMatches.join('\n\n')}\n\n`
          }
        }
      }
    }

    // Truncate to prevent excessive context
    if (sharedTypes.length > MAX_SECTION_LENGTH) {
      sharedTypes = sharedTypes.substring(0, MAX_SECTION_LENGTH) + '\n// ... (truncated)'
    }
    if (zodSchemas.length > MAX_SECTION_LENGTH) {
      zodSchemas = zodSchemas.substring(0, MAX_SECTION_LENGTH) + '\n// ... (truncated)'
    }

    return { endpoints, sharedTypes, zodSchemas }
  }
}
