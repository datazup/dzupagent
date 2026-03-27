/**
 * Built-in guardrail rules barrel export.
 */

export { createLayeringRule } from './layering-rule.js'
export { createImportRestrictionRule } from './import-restriction-rule.js'
export type { ImportRestrictionConfig } from './import-restriction-rule.js'
export { createNamingConventionRule } from './naming-convention-rule.js'
export { createSecurityRule } from './security-rule.js'
export { createTypeSafetyRule } from './type-safety-rule.js'
export { createContractComplianceRule } from './contract-compliance-rule.js'

import type { GuardrailRule } from '../guardrail-types.js'
import { createLayeringRule } from './layering-rule.js'
import { createImportRestrictionRule } from './import-restriction-rule.js'
import { createNamingConventionRule } from './naming-convention-rule.js'
import { createSecurityRule } from './security-rule.js'
import { createTypeSafetyRule } from './type-safety-rule.js'
import { createContractComplianceRule } from './contract-compliance-rule.js'

/**
 * Create all built-in guardrail rules with default configuration.
 */
export function createBuiltinRules(): GuardrailRule[] {
  return [
    createLayeringRule(),
    createImportRestrictionRule(),
    createNamingConventionRule(),
    createSecurityRule(),
    createTypeSafetyRule(),
    createContractComplianceRule(),
  ]
}
