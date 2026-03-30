declare module 'cookie' {
  export interface CookieSerializeOptions {
    domain?: string
    encode?: (value: string) => string
    expires?: Date
    httpOnly?: boolean
    maxAge?: number
    path?: string
    priority?: 'low' | 'medium' | 'high'
    sameSite?: boolean | 'lax' | 'strict' | 'none'
    secure?: boolean
  }

  export function parse(str: string): Record<string, string>
  export function serialize(
    name: string,
    value: string,
    options?: CookieSerializeOptions,
  ): string
}
