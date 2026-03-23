/**
 * Markdown code block extraction from LLM responses.
 */

export interface CodeBlock {
  language: string
  content: string
}

/**
 * Parse all code blocks from a markdown string.
 * Handles ```language\n...\n``` fences.
 */
export function parseCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  const regex = /```(\w*)\n([\s\S]*?)```/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      language: match[1] ?? '',
      content: (match[2] ?? '').trim(),
    })
  }

  return blocks
}

/**
 * Extract the largest code block from an LLM response.
 * If no code blocks found, returns the entire response trimmed.
 */
export function extractLargestCodeBlock(text: string): string {
  const blocks = parseCodeBlocks(text)
  if (blocks.length === 0) return text.trim()

  let largest = blocks[0]!
  for (const block of blocks) {
    if (block.content.length > largest.content.length) {
      largest = block
    }
  }

  return largest.content
}

/**
 * Detect programming language from a file path extension.
 */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    vue: 'vue',
    json: 'json',
    prisma: 'prisma',
    css: 'css',
    scss: 'scss',
    html: 'html',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    py: 'python',
    rs: 'rust',
    go: 'go',
    toml: 'toml',
    xml: 'xml',
    svg: 'svg',
    graphql: 'graphql',
    gql: 'graphql',
    env: 'dotenv',
  }
  return langMap[ext] ?? 'text'
}
