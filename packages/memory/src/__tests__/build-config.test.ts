import { describe, expect, it } from 'vitest'
// NodeNext requires the explicit extension; the .js form maps to tsup.config.ts
// the same way every other relative import in this repo does.
import tsupConfig from '../../tsup.config.js'

describe('build config', () => {
  it('keeps multi-entry runtime output byte-reproducible', () => {
    if (typeof tsupConfig === 'function') {
      throw new Error('tsup.config.ts exports a factory; this test expects a plain config object')
    }
    const config = Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig
    if (!config) {
      throw new Error('tsup.config.ts exports an empty config array')
    }

    expect(config.splitting).toBe(false)
  })

  it('keeps LangChain and LangGraph packages external', () => {
    // defineConfig's return type admits three shapes — a single Options, an
    // array of them, or a factory function. This package exports one object, and
    // until the import above resolved, none of this was typechecked: reading
    // `.external` straight off the union was an error hidden behind a TS2307.
    // Narrowing by hand rather than casting means a future change to the config's
    // shape fails here loudly instead of silently reading `undefined`.
    if (typeof tsupConfig === 'function') {
      throw new Error('tsup.config.ts exports a factory; this test expects a plain config object')
    }
    const config = Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig
    if (!config) {
      throw new Error('tsup.config.ts exports an empty config array')
    }
    const external = new Set(config.external ?? [])

    expect(external.has('@langchain/core')).toBe(true)
    expect(external.has('@langchain/langgraph')).toBe(true)
    expect(external.has('@langchain/langgraph-checkpoint-postgres')).toBe(true)
    expect(external.has('@langchain/langgraph-checkpoint-postgres/store')).toBe(true)
  })
})
