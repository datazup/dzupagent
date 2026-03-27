/**
 * AWS Lambda adapter — converts Lambda events to Hono Request/Response.
 *
 * Uses Hono's built-in `app.fetch()` with a standard Request object
 * constructed from the Lambda API Gateway v2 proxy event.
 */
import type { Hono } from 'hono'

interface LambdaEvent {
  readonly requestContext?: { readonly http?: { readonly method?: string; readonly path?: string } }
  readonly rawPath?: string
  readonly rawQueryString?: string
  readonly headers?: Record<string, string | undefined>
  readonly body?: string | null
  readonly isBase64Encoded?: boolean
}

interface LambdaResult {
  statusCode: number
  headers: Record<string, string>
  body: string
  isBase64Encoded: boolean
}

/** Export a Hono app as an AWS Lambda handler (API Gateway v2 payload format). */
export function toLambdaHandler(
  app: Hono,
): (event: unknown) => Promise<LambdaResult> {
  return async (event: unknown): Promise<LambdaResult> => {
    const e = event as LambdaEvent
    const method = e.requestContext?.http?.method ?? 'GET'
    const path = e.rawPath ?? '/'
    const qs = e.rawQueryString ? `?${e.rawQueryString}` : ''
    const url = `https://lambda.local${path}${qs}`

    const headers = new Headers()
    if (e.headers) {
      for (const [k, v] of Object.entries(e.headers)) {
        if (v !== undefined) headers.set(k, v)
      }
    }

    let body: string | undefined
    if (e.body) {
      body = e.isBase64Encoded
        ? Buffer.from(e.body, 'base64').toString('utf-8')
        : e.body
    }

    const request = new Request(url, {
      method,
      headers,
      body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
    })

    const response = await app.fetch(request)
    const responseBody = await response.text()

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v
    })

    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: responseBody,
      isBase64Encoded: false,
    }
  }
}
