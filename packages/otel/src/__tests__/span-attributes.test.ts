/**
 * Dedicated tests for span-attributes.ts.
 *
 * The noop-and-span-attributes.test.ts file already spot-checks individual
 * keys. This file focuses on structural properties, grouping invariants,
 * and semantic correctness that are distinct from those checks.
 */

import { describe, it, expect } from 'vitest'
import { ForgeSpanAttr } from '../span-attributes.js'
import type { ForgeSpanAttrKey } from '../span-attributes.js'

// ------------------------------------------------------------------ key catalogue

const ALL_KEYS = Object.keys(ForgeSpanAttr) as (keyof typeof ForgeSpanAttr)[]
const ALL_VALUES = Object.values(ForgeSpanAttr) as string[]

// ------------------------------------------------------------------ structural invariants

describe('ForgeSpanAttr: structural invariants', () => {
  it('exports a non-empty const object', () => {
    expect(typeof ForgeSpanAttr).toBe('object')
    expect(ALL_KEYS.length).toBeGreaterThan(0)
  })

  it('contains exactly 30 attribute keys', () => {
    // Guard against accidental additions or deletions
    expect(ALL_KEYS).toHaveLength(30)
  })

  it('every value is a non-empty string', () => {
    for (const v of ALL_VALUES) {
      expect(typeof v).toBe('string')
      expect(v.length).toBeGreaterThan(0)
    }
  })

  it('no value contains whitespace', () => {
    for (const v of ALL_VALUES) {
      expect(v).not.toMatch(/\s/)
    }
  })

  it('no duplicate attribute values exist', () => {
    const unique = new Set(ALL_VALUES)
    expect(unique.size).toBe(ALL_VALUES.length)
  })

  it('all values use lowercase dot-separated segments', () => {
    for (const v of ALL_VALUES) {
      // e.g. 'forge.agent.id' — only lowercase letters, dots, underscores
      expect(v).toMatch(/^[a-z0-9_.]+$/)
    }
  })
})

// ------------------------------------------------------------------ namespace grouping

describe('ForgeSpanAttr: namespace grouping', () => {
  it('agent identity attributes all share forge.agent. or forge.run. or forge.pipeline. or forge.tenant. prefix', () => {
    const agentGroup = [
      ForgeSpanAttr.AGENT_ID,
      ForgeSpanAttr.AGENT_NAME,
      ForgeSpanAttr.RUN_ID,
      ForgeSpanAttr.PHASE,
      ForgeSpanAttr.TENANT_ID,
    ]
    for (const v of agentGroup) {
      expect(v).toMatch(/^forge\.(agent|run|pipeline|tenant)\./)
    }
  })

  it('tool attributes all share forge.tool. prefix', () => {
    const toolGroup = [
      ForgeSpanAttr.TOOL_NAME,
      ForgeSpanAttr.TOOL_DURATION_MS,
      ForgeSpanAttr.TOOL_INPUT_SIZE,
      ForgeSpanAttr.TOOL_OUTPUT_SIZE,
    ]
    for (const v of toolGroup) {
      expect(v).toMatch(/^forge\.tool\./)
    }
  })

  it('memory attributes all share forge.memory. prefix', () => {
    const memGroup = [
      ForgeSpanAttr.MEMORY_NAMESPACE,
      ForgeSpanAttr.MEMORY_OPERATION,
      ForgeSpanAttr.MEMORY_RESULT_COUNT,
    ]
    for (const v of memGroup) {
      expect(v).toMatch(/^forge\.memory\./)
    }
  })

  it('cost and token attributes share forge.cost. or forge.tokens. prefix', () => {
    expect(ForgeSpanAttr.COST_CENTS).toMatch(/^forge\.cost\./)
    expect(ForgeSpanAttr.TOKEN_COUNT).toMatch(/^forge\.tokens\./)
  })

  it('budget attributes all share forge.budget. prefix', () => {
    const budgetGroup = [
      ForgeSpanAttr.BUDGET_TOKENS_USED,
      ForgeSpanAttr.BUDGET_TOKENS_LIMIT,
      ForgeSpanAttr.BUDGET_COST_USED,
      ForgeSpanAttr.BUDGET_COST_LIMIT,
      ForgeSpanAttr.BUDGET_ITERATIONS,
      ForgeSpanAttr.BUDGET_ITERATIONS_LIMIT,
    ]
    for (const v of budgetGroup) {
      expect(v).toMatch(/^forge\.budget\./)
    }
  })

  it('error attributes all share forge.error. prefix', () => {
    expect(ForgeSpanAttr.ERROR_CODE).toMatch(/^forge\.error\./)
    expect(ForgeSpanAttr.ERROR_RECOVERABLE).toMatch(/^forge\.error\./)
  })

  it('GenAI attributes all share gen_ai. prefix', () => {
    const genAiGroup = [
      ForgeSpanAttr.GEN_AI_SYSTEM,
      ForgeSpanAttr.GEN_AI_REQUEST_MODEL,
      ForgeSpanAttr.GEN_AI_RESPONSE_MODEL,
      ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE,
      ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS,
      ForgeSpanAttr.GEN_AI_USAGE_INPUT_TOKENS,
      ForgeSpanAttr.GEN_AI_USAGE_OUTPUT_TOKENS,
      ForgeSpanAttr.GEN_AI_USAGE_TOTAL_TOKENS,
    ]
    for (const v of genAiGroup) {
      expect(v).toMatch(/^gen_ai\./)
    }
  })
})

// ------------------------------------------------------------------ semantic values

describe('ForgeSpanAttr: semantic value correctness', () => {
  it('TOOL_INPUT_SIZE describes byte size semantics via suffix', () => {
    expect(ForgeSpanAttr.TOOL_INPUT_SIZE).toContain('size_bytes')
  })

  it('TOOL_OUTPUT_SIZE describes byte size semantics via suffix', () => {
    expect(ForgeSpanAttr.TOOL_OUTPUT_SIZE).toContain('size_bytes')
  })

  it('TOOL_DURATION_MS encodes millisecond unit in the key name', () => {
    expect(ForgeSpanAttr.TOOL_DURATION_MS).toContain('duration_ms')
  })

  it('BUDGET_COST_USED encodes cents unit in the key name', () => {
    expect(ForgeSpanAttr.BUDGET_COST_USED).toContain('cents')
  })

  it('BUDGET_COST_LIMIT encodes cents unit in the key name', () => {
    expect(ForgeSpanAttr.BUDGET_COST_LIMIT).toContain('cents')
  })

  it('GEN_AI_USAGE_TOTAL_TOKENS is distinct from input and output tokens', () => {
    expect(ForgeSpanAttr.GEN_AI_USAGE_TOTAL_TOKENS).not.toBe(ForgeSpanAttr.GEN_AI_USAGE_INPUT_TOKENS)
    expect(ForgeSpanAttr.GEN_AI_USAGE_TOTAL_TOKENS).not.toBe(ForgeSpanAttr.GEN_AI_USAGE_OUTPUT_TOKENS)
  })

  it('GEN_AI_REQUEST_MODEL and GEN_AI_RESPONSE_MODEL are distinct', () => {
    expect(ForgeSpanAttr.GEN_AI_REQUEST_MODEL).not.toBe(ForgeSpanAttr.GEN_AI_RESPONSE_MODEL)
  })
})

// ------------------------------------------------------------------ type-level usage

describe('ForgeSpanAttr: ForgeSpanAttrKey type', () => {
  it('a value can be assigned to ForgeSpanAttrKey without type error', () => {
    const key: ForgeSpanAttrKey = ForgeSpanAttr.GEN_AI_SYSTEM
    expect(key).toBe('gen_ai.system')
  })

  it('all values satisfy the ForgeSpanAttrKey union', () => {
    // Exercise all values as ForgeSpanAttrKey assignments at runtime
    for (const v of ALL_VALUES) {
      const key: ForgeSpanAttrKey = v as ForgeSpanAttrKey
      expect(key).toBe(v)
    }
  })
})
