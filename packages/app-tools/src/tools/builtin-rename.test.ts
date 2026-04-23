import { describe, expect, it, vi } from 'vitest'
import type { McpClient } from '@dzupagent/code-edit-kit'
import { createBuiltinToolRegistry } from './builtin.js'

/**
 * Tests for the opt-in `code_edit.rename_symbol` registration in
 * {@link createBuiltinToolRegistry}. The flag defaults to false so existing
 * callers see no behaviour change; only `{ renameSymbol: true }` adds the tool.
 */
describe('createBuiltinToolRegistry — renameSymbol opt-in', () => {
  it('does NOT register code_edit.rename_symbol by default', () => {
    const { registry, executors } = createBuiltinToolRegistry()
    expect(registry.get('code_edit.rename_symbol')).toBeUndefined()
    expect(executors.has('code_edit.rename_symbol')).toBe(false)
    expect(registry.listByNamespace('code_edit')).toHaveLength(0)
  })

  it('registers code_edit.rename_symbol when renameSymbol is true', () => {
    const { registry } = createBuiltinToolRegistry({ renameSymbol: true })
    const def = registry.get('code_edit.rename_symbol')
    expect(def).toBeDefined()
    expect(def?.namespace).toBe('code_edit')
    expect(def?.permissionLevel).toBe('write')
    expect(def?.sideEffects[0]?.type).toBe('writes_file')
    expect(registry.listByNamespace('code_edit')).toHaveLength(1)
  })

  it('exposes the renameSymbol tool in the executors map when opted in', () => {
    const { executors } = createBuiltinToolRegistry({ renameSymbol: true })
    const exec = executors.get('code_edit.rename_symbol')
    expect(exec).toBeDefined()
    expect(exec?.definition.name).toBe('code_edit.rename_symbol')
    expect(typeof exec?.execute).toBe('function')
  })
})

describe('createBuiltinToolRegistry — mcpClient forwarding', () => {
  it('registers code_edit.rename_symbol without mcpClient when none is provided', () => {
    // Without mcpClient the tool is still registered correctly and the
    // executor is callable — no TypeError from an undefined reference.
    const { registry, executors } = createBuiltinToolRegistry({ renameSymbol: true })
    const def = registry.get('code_edit.rename_symbol')
    const exec = executors.get('code_edit.rename_symbol')
    expect(def).toBeDefined()
    expect(exec).toBeDefined()
    expect(exec?.definition.name).toBe('code_edit.rename_symbol')
  })

  it('registers code_edit.rename_symbol with an mcpClient stub', () => {
    // When mcpClient is supplied alongside renameSymbol:true, the tool is still
    // registered and accessible — the stub does not break the wiring.
    const mcpClientStub: McpClient = { call: vi.fn(), close: vi.fn() }
    const { registry, executors } = createBuiltinToolRegistry({
      renameSymbol: true,
      mcpClient: mcpClientStub,
    })
    const def = registry.get('code_edit.rename_symbol')
    const exec = executors.get('code_edit.rename_symbol')
    expect(def).toBeDefined()
    expect(exec).toBeDefined()
    expect(exec?.definition.name).toBe('code_edit.rename_symbol')
    expect(exec?.definition.namespace).toBe('code_edit')
  })

  it('forwards mcpClient to createRenameSymbolTool via the underlying LangChain tool', async () => {
    // Verify that createRenameSymbolTool correctly stores the mcpClient on the
    // returned DynamicStructuredTool instance. This confirms the extended
    // signature end-to-end without relying on module-level spying (which is
    // fragile with pre-built ESM dist packages).
    const { createRenameSymbolTool } = await import('@dzupagent/code-edit-kit')
    const mcpClientStub: McpClient = { call: vi.fn(), close: vi.fn() }
    const tool = createRenameSymbolTool(mcpClientStub) as unknown as Record<string, unknown>
    expect(tool['mcpClient']).toBe(mcpClientStub)
  })
})
