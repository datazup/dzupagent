import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { agentAsTool } from '../tools/agent-as-tool.js'
import { createHumanContactTool } from '../tools/human-contact-tool.js'
import {
  hasExplicitToolTier,
  resolveToolTier,
} from '../tools/tool-tier-registry.js'
import {
  createCheckMailTool,
  createSendMailTool,
} from '../mailbox/mail-tools.js'
import type {
  AgentMailbox,
  MailMessage,
  MailboxQuery,
} from '../mailbox/types.js'

function createMailbox(): AgentMailbox {
  return {
    agentId: 'tier-test-agent',
    send: vi.fn(async (to, subject, body): Promise<MailMessage> => ({
      id: 'message-1',
      from: 'tier-test-agent',
      to,
      subject,
      body,
      createdAt: 1,
    })),
    receive: vi.fn(async (_query?: MailboxQuery) => []),
    subscribe: vi.fn(() => () => {}),
    ack: vi.fn(async () => {}),
  }
}

async function listProductionTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return []
      return listProductionTypeScriptFiles(absolute)
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [absolute]
      : []
  }))
  return files.flat()
}

function hasRawToolProducer(source: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  let found = false

  const visit = (node: ts.Node): void => {
    if (
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'tool') ||
      (ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'DynamicStructuredTool')
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

describe('Agent-owned framework tool tier metadata', () => {
  it('classifies every built-in producer by its real effect boundary', async () => {
    const mailbox = createMailbox()
    const tools = [
      { tool: createHumanContactTool(), tier: 'full-access' },
      {
        tool: await agentAsTool({
          id: 'subagent',
          description: 'A nested agent',
          generate: async () => ({ content: 'done' }),
        }),
        tier: 'full-access',
      },
      { tool: createSendMailTool({ mailbox }), tier: 'full-access' },
      { tool: createCheckMailTool({ mailbox }), tier: 'read-only' },
    ] as const

    for (const entry of tools) {
      expect(hasExplicitToolTier(entry.tool), entry.tool.name).toBe(true)
      expect(resolveToolTier(entry.tool), entry.tool.name).toEqual({
        requiredTier: entry.tier,
        source: 'explicit',
      })
    }
  })

  it('guards new raw LangChain tool producers against silent defaults', async () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
    const files = await listProductionTypeScriptFiles(sourceRoot)
    const producers: string[] = []

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (hasRawToolProducer(source, file)) {
        producers.push(path.relative(sourceRoot, file).split(path.sep).join('/'))
        expect(source, file).toMatch(/\bsetToolTier\s*\(/)
      }
    }

    expect(producers.sort()).toEqual([
      'mailbox/mail-tools.ts',
      'tools/agent-as-tool.ts',
      'tools/human-contact-tool.ts',
    ])
  })
})
