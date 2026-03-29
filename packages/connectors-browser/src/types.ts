export interface CrawlOptions {
  maxPages: number
  maxDepth: number
  includePatterns?: string[] | undefined
  excludePatterns?: string[] | undefined
  waitForIdle?: number | undefined
}

export interface CrawlResult {
  url: string
  title: string
  depth: number
  links: string[]
  accessibilityTree: AccessibilityNode[]
  screenshot: Buffer
  screenshotMimeType: string
  forms: FormInfo[]
  interactiveElements: ElementInfo[]
  loadTimeMs: number
}

export interface AccessibilityNode {
  role: string
  name: string
  value?: string | undefined
  description?: string | undefined
  depth: number
  disabled?: boolean | undefined
  checked?: boolean | undefined
  expanded?: boolean | undefined
  selected?: boolean | undefined
  required?: boolean | undefined
}

export interface FormInfo {
  action: string
  method: string
  fields: FormField[]
}

export interface FormField {
  name: string
  type: string
  label: string | null
  placeholder: string | null
  required: boolean
  options?: string[] | undefined
}

export interface ElementInfo {
  role: string
  label: string
  enabled: boolean
  visible: boolean
  location: string
  ariaAttributes: Record<string, string>
}

export interface AuthCredentials {
  loginUrl?: string | undefined
  username: string
  password: string
  usernameSelector?: string | undefined
  passwordSelector?: string | undefined
}

export interface ScreenshotResult {
  buffer: Buffer
  mimeType: string
  width: number
  height: number
}

export interface BrowserLaunchOptions {
  headless?: boolean | undefined
  viewport?: { width: number; height: number } | undefined
  proxy?: { server: string } | undefined
}
