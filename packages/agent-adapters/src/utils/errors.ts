/**
 * Re-export ForgeError as DzupError for the DzupAgent branding.
 * Both names refer to the same class — ForgeError is the legacy name
 * from the pre-rename "ForgeAgent" era.
 *
 * New code should use DzupError. Existing code using ForgeError continues to work.
 */
export { ForgeError, ForgeError as DzupError } from '@dzupagent/core'
export type { ForgeErrorOptions, ForgeErrorOptions as DzupErrorOptions } from '@dzupagent/core'
