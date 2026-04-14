import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWriteFileTool } from '../tools/write-file.tool.js'
import { createRunTestsTool } from '../tools/run-tests.tool.js'
import { createGenerateFileTool } from '../tools/generate-file.tool.js'
import type { SandboxProtocol, ExecResult } from '../sandbox/sandbox-protocol.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSandbox(overrides: Partial<SandboxProtocol> = {}): SandboxProtocol {
  return {
    execute: vi.fn<[string], Promise<ExecResult>>().mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    }),
    uploadFiles: vi.fn().mockResolvedValue(undefined),
    downloadFiles: vi.fn().mockResolvedValue({}),
    cleanup: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// write-file tool
// ---------------------------------------------------------------------------

describe('createWriteFileTool', () => {
  it('should create a tool with the correct name', () => {
    const tool = createWriteFileTool()
    expect(tool.name).toBe('write_file')
  })

  it('should return JSON action result for a write', async () => {
    const tool = createWriteFileTool()
    const result = await tool.invoke({
      filePath: 'src/index.ts',
      content: 'console.log("hello")',
    })

    const parsed = JSON.parse(result)
    expect(parsed.action).toBe('write_file')
    expect(parsed.filePath).toBe('src/index.ts')
    expect(parsed.success).toBe(true)
    expect(parsed.size).toBe('console.log("hello")'.length)
  })

  it('should report correct size for empty content', async () => {
    const tool = createWriteFileTool()
    const result = await tool.invoke({ filePath: 'empty.ts', content: '' })

    const parsed = JSON.parse(result)
    expect(parsed.size).toBe(0)
    expect(parsed.success).toBe(true)
  })

  it('should report correct size for large content', async () => {
    const tool = createWriteFileTool()
    const largeContent = 'x'.repeat(10_000)
    const result = await tool.invoke({ filePath: 'big.ts', content: largeContent })

    const parsed = JSON.parse(result)
    expect(parsed.size).toBe(10_000)
  })

  it('should handle file paths with directories', async () => {
    const tool = createWriteFileTool()
    const result = await tool.invoke({
      filePath: 'src/deep/nested/module.ts',
      content: 'export const x = 1',
    })

    const parsed = JSON.parse(result)
    expect(parsed.filePath).toBe('src/deep/nested/module.ts')
  })
})

// ---------------------------------------------------------------------------
// run-tests tool
// ---------------------------------------------------------------------------

describe('createRunTestsTool', () => {
  it('should create a tool with the correct name', () => {
    const sandbox = createMockSandbox()
    const tool = createRunTestsTool(sandbox)
    expect(tool.name).toBe('run_tests')
  })

  it('should report failure when sandbox is unavailable', async () => {
    const sandbox = createMockSandbox({
      isAvailable: vi.fn().mockResolvedValue(false),
    })
    const tool = createRunTestsTool(sandbox)

    const result = await tool.invoke({})
    const parsed = JSON.parse(result)

    expect(parsed.action).toBe('run_tests')
    expect(parsed.success).toBe(false)
    expect(parsed.error).toContain('not available')
  })

  it('should execute with default command when none specified', async () => {
    const executeFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '{"numPassedTests": 5}',
      stderr: '',
      timedOut: false,
    })
    const sandbox = createMockSandbox({ execute: executeFn })
    const tool = createRunTestsTool(sandbox)

    await tool.invoke({})

    expect(executeFn).toHaveBeenCalledWith(
      'npx vitest run --reporter=json',
      { timeoutMs: 60000 },
    )
  })

  it('should execute with custom command', async () => {
    const executeFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
    })
    const sandbox = createMockSandbox({ execute: executeFn })
    const tool = createRunTestsTool(sandbox)

    await tool.invoke({ testCommand: 'jest --ci', timeoutMs: 30000 })

    expect(executeFn).toHaveBeenCalledWith('jest --ci', { timeoutMs: 30000 })
  })

  it('should report success when tests pass (exitCode 0)', async () => {
    const sandbox = createMockSandbox({
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'All tests passed',
        stderr: '',
        timedOut: false,
      }),
    })
    const tool = createRunTestsTool(sandbox)

    const result = await tool.invoke({})
    const parsed = JSON.parse(result)

    expect(parsed.success).toBe(true)
    expect(parsed.exitCode).toBe(0)
    expect(parsed.timedOut).toBe(false)
  })

  it('should report failure when tests fail (exitCode 1)', async () => {
    const sandbox = createMockSandbox({
      execute: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: 'FAIL src/foo.test.ts',
        stderr: 'Error: assertion failed',
        timedOut: false,
      }),
    })
    const tool = createRunTestsTool(sandbox)

    const result = await tool.invoke({})
    const parsed = JSON.parse(result)

    expect(parsed.success).toBe(false)
    expect(parsed.exitCode).toBe(1)
  })

  it('should report timeout', async () => {
    const sandbox = createMockSandbox({
      execute: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'killed',
        timedOut: true,
      }),
    })
    const tool = createRunTestsTool(sandbox)

    const result = await tool.invoke({})
    const parsed = JSON.parse(result)

    expect(parsed.timedOut).toBe(true)
  })

  it('should truncate long stdout to 5000 chars', async () => {
    const longOutput = 'x'.repeat(10_000)
    const sandbox = createMockSandbox({
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: longOutput,
        stderr: '',
        timedOut: false,
      }),
    })
    const tool = createRunTestsTool(sandbox)

    const result = await tool.invoke({})
    const parsed = JSON.parse(result)

    expect(parsed.stdout.length).toBe(5000)
  })

  it('should truncate long stderr to 2000 chars', async () => {
    const longError = 'e'.repeat(5000)
    const sandbox = createMockSandbox({
      execute: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: longError,
        timedOut: false,
      }),
    })
    const tool = createRunTestsTool(sandbox)

    const result = await tool.invoke({})
    const parsed = JSON.parse(result)

    expect(parsed.stderr.length).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// generate-file tool
// ---------------------------------------------------------------------------

describe('createGenerateFileTool', () => {
  function createMockCodeGenService() {
    return {
      generateFile: vi.fn().mockResolvedValue({
        content: 'export const generated = true',
        language: 'typescript',
        source: 'llm',
        tokensUsed: { inputTokens: 100, outputTokens: 50 },
      }),
    }
  }

  it('should create a tool with the correct name', () => {
    const service = createMockCodeGenService()
    const tool = createGenerateFileTool(
      service as never,
      'You are a code generator.',
    )
    expect(tool.name).toBe('generate_file')
  })

  it('should invoke codeGenService.generateFile with correct args', async () => {
    const service = createMockCodeGenService()
    const tool = createGenerateFileTool(
      service as never,
      'System prompt',
    )

    await tool.invoke({
      filePath: 'src/utils.ts',
      purpose: 'Utility functions for string manipulation',
    })

    expect(service.generateFile).toHaveBeenCalledWith(
      {
        filePath: 'src/utils.ts',
        purpose: 'Utility functions for string manipulation',
      },
      'System prompt',
    )
  })

  it('should pass reference code when provided', async () => {
    const service = createMockCodeGenService()
    const tool = createGenerateFileTool(
      service as never,
      'System prompt',
    )

    await tool.invoke({
      filePath: 'src/new.ts',
      purpose: 'Similar to existing',
      referenceCode: 'export const example = true',
    })

    expect(service.generateFile).toHaveBeenCalledWith(
      {
        filePath: 'src/new.ts',
        purpose: 'Similar to existing',
        referenceFiles: { reference: 'export const example = true' },
      },
      'System prompt',
    )
  })

  it('should return generate_file action result', async () => {
    const service = createMockCodeGenService()
    const tool = createGenerateFileTool(
      service as never,
      'prompt',
    )

    const result = await tool.invoke({
      filePath: 'src/gen.ts',
      purpose: 'Generate something',
    })

    const parsed = JSON.parse(result)
    expect(parsed.action).toBe('generate_file')
    expect(parsed.filePath).toBe('src/gen.ts')
    expect(parsed.content).toBe('export const generated = true')
    expect(parsed.language).toBe('typescript')
    expect(parsed.source).toBe('llm')
    expect(parsed.tokensUsed).toBe(150)
  })

  it('should calculate total tokensUsed correctly', async () => {
    const service = {
      generateFile: vi.fn().mockResolvedValue({
        content: 'code',
        language: 'python',
        source: 'llm',
        tokensUsed: { inputTokens: 500, outputTokens: 300 },
      }),
    }
    const tool = createGenerateFileTool(
      service as never,
      'prompt',
    )

    const result = await tool.invoke({
      filePath: 'main.py',
      purpose: 'Python script',
    })

    const parsed = JSON.parse(result)
    expect(parsed.tokensUsed).toBe(800)
  })
})
