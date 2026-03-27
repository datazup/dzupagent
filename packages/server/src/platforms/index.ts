/**
 * Platform adapters barrel — re-exports all serverless platform handlers.
 */
export { toLambdaHandler } from './lambda.js'
export { toVercelHandler } from './vercel.js'
export { toCloudflareHandler } from './cloudflare.js'
