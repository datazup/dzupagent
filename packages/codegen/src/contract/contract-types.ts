/**
 * API contract types extracted from generated backend code.
 */

export interface ApiEndpoint {
  method: string
  path: string
  auth: boolean
  description: string
  requestBody?: string
  responseBody?: string
}

export interface ApiContract {
  endpoints: ApiEndpoint[]
  sharedTypes: string
  zodSchemas: string
}
