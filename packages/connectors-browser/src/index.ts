/**
 * @dzupagent/connectors-browser — Browser automation tools for DzupAgent.
 *
 * Provides Playwright-based crawling, form/element/a11y extraction,
 * and LangChain-compatible tool wrappers via createBrowserConnector.
 */

export {
  createBrowserConnector,
  type BrowserConnectorConfig,
} from './browser-connector.js'
export {
  normalizeBrowserTool,
  normalizeBrowserTools,
  type BrowserConnectorTool,
} from './connector-contract.js'

// Browser management
export { BrowserManager } from './browser/browser-manager.js'
export { AuthHandler } from './browser/auth-handler.js'

// Crawling
export { PageCrawler } from './crawler/page-crawler.js'
export { extractLinks } from './crawler/link-extractor.js'
export { normalizeUrl, isSameOrigin, matchesPattern, isHashRoute } from './crawler/url-utils.js'

// Data extraction
export { extractAccessibilityTree } from './extraction/accessibility-tree.js'
export { captureScreenshot } from './extraction/screenshot-capture.js'
export { extractForms } from './extraction/form-extractor.js'
export { extractInteractiveElements } from './extraction/element-extractor.js'

// Types
export type {
  CrawlOptions,
  CrawlResult,
  AccessibilityNode,
  FormInfo,
  FormField,
  ElementInfo,
  AuthCredentials,
  ScreenshotResult,
  BrowserLaunchOptions,
} from './types.js'
