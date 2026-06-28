import { describe, expect, it } from 'vitest'
import tsupConfig from '../../tsup.config'

describe('build config', () => {
  it('keeps LangChain and LangGraph packages external', () => {
    const config = Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig
    const external = new Set(config.external ?? [])

    expect(external.has('@langchain/core')).toBe(true)
    expect(external.has('@langchain/langgraph')).toBe(true)
    expect(external.has('@langchain/langgraph-checkpoint-postgres')).toBe(true)
    expect(external.has('@langchain/langgraph-checkpoint-postgres/store')).toBe(true)
  })
})
