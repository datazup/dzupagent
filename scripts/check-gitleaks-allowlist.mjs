#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_PATH = join(__dirname, '..', '.gitleaks.toml')

function extractPathsArrayBody(block) {
  const pathsKey = /paths\s*=\s*\[/.exec(block)
  if (!pathsKey) return null
  const bodyStart = pathsKey.index + pathsKey[0].length
  let cursor = bodyStart
  let depth = 1
  let inTripleQuoted = false

  while (cursor < block.length) {
    if (block.startsWith("'''", cursor)) {
      inTripleQuoted = !inTripleQuoted
      cursor += 3
      continue
    }
    const char = block[cursor]
    if (!inTripleQuoted) {
      if (char === '[') depth += 1
      if (char === ']') {
        depth -= 1
        if (depth === 0) {
          return block.slice(bodyStart, cursor)
        }
      }
    }
    cursor += 1
  }

  return null
}

export function extractAllowlistPathPatterns(rawConfig) {
  const patterns = []
  const allowlistBlocks = String(rawConfig)
    .split(/\n(?=\[\[allowlists\]\])/g)
    .filter((block) => block.trimStart().startsWith('[[allowlists]]'))

  for (const block of allowlistBlocks) {
    const pathsBody = extractPathsArrayBody(block)
    if (!pathsBody) continue
    for (const match of pathsBody.matchAll(/'''([\s\S]*?)'''/g)) {
      patterns.push(match[1])
    }
  }

  return patterns
}

export function checkGitleaksAllowlist(rawConfig) {
  const patterns = extractAllowlistPathPatterns(rawConfig)
  const issues = []

  for (const pattern of patterns) {
    try {
      new RegExp(pattern)
    } catch (error) {
      issues.push({
        pattern,
        issue: `invalid regex: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
      issues.push({
        pattern,
        issue: 'allowlist path regex must be anchored with ^ and $',
      })
    }
  }

  return { patterns, issues }
}

export function renderReport(result, configPath = DEFAULT_CONFIG_PATH) {
  const lines = [
    `Gitleaks allowlist check: ${configPath}`,
    `- Path regexes: ${result.patterns.length}`,
  ]

  if (result.issues.length === 0) {
    lines.push('- Status: ok')
    return lines.join('\n')
  }

  lines.push('- Status: failed')
  for (const issue of result.issues) {
    lines.push(`- ${issue.pattern}: ${issue.issue}`)
  }
  return lines.join('\n')
}

export function runCheck(configPath = DEFAULT_CONFIG_PATH) {
  if (!existsSync(configPath)) {
    throw new Error(`gitleaks config not found: ${configPath}`)
  }
  const raw = readFileSync(configPath, 'utf8')
  return checkGitleaksAllowlist(raw)
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[\\/]/, ''))

if (isMain) {
  try {
    const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH
    const result = runCheck(configPath)
    const report = renderReport(result, configPath)
    if (result.issues.length > 0) {
      console.error(report)
      process.exit(1)
    }
    console.log(report)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
