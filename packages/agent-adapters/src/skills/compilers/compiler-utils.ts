/**
 * Shared utilities for adapter skill compilers.
 */

import type { AdapterSkillBundle } from '../adapter-skill-types.js'

/** Current projection format version. Bump when compiled output shape changes. */
export const PROJECTION_VERSION = '1.0.0'

/**
 * Deterministic string hash (DJB2 variant).
 * Not cryptographic -- used for content-addressable cache keys.
 */
export function deterministicHash(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + charCode
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  // Convert to unsigned 32-bit hex
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Sort prompt sections by priority (ascending -- lower value = higher priority)
 * and join their content with double newlines.
 */
export function buildSystemPrompt(bundle: AdapterSkillBundle): string {
  const sorted = [...bundle.promptSections].sort((a, b) => a.priority - b.priority)
  return sorted.map((s) => s.content).join('\n\n')
}

/** Extract tool names matching the given mode from a bundle's toolBindings. */
export function extractTools(
  bundle: AdapterSkillBundle,
  mode: 'required' | 'optional' | 'blocked',
): string[] {
  return bundle.toolBindings.filter((b) => b.mode === mode).map((b) => b.toolName)
}
