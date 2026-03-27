/**
 * Contract Compliance Rule — verifies that generated classes implement
 * their declared interfaces completely.
 *
 * Uses regex-based analysis (no AST required). Checks that for each
 * `class Foo implements Bar`, all methods/properties declared in
 * interface Bar appear in class Foo.
 */

import type { GuardrailRule, GuardrailContext, GuardrailResult, GuardrailViolation, GeneratedFile } from '../guardrail-types.js'

interface InterfaceMember {
  name: string
  kind: 'method' | 'property'
}

interface ParsedInterface {
  name: string
  members: InterfaceMember[]
}

interface ParsedClass {
  name: string
  implements: string[]
  memberNames: Set<string>
  line: number
}

const INTERFACE_RE = /^\s*(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[^{]+)?\s*\{/
const INTERFACE_METHOD_RE = /^\s+(\w+)\s*(?:<[^>]*>)?\s*\(/
const INTERFACE_PROP_RE = /^\s+(?:readonly\s+)?(\w+)\s*[?:]/
const CLASS_RE = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+([^{]+))?\s*\{/
const CLASS_MEMBER_RE = /^\s+(?:private\s+|protected\s+|public\s+|static\s+|readonly\s+|async\s+|abstract\s+|override\s+)*(\w+)\s*(?:[(<:=;])/

function extractInterfaces(files: GeneratedFile[]): Map<string, ParsedInterface> {
  const interfaces = new Map<string, ParsedInterface>()

  for (const file of files) {
    const lines = file.content.split('\n')
    let currentInterface: ParsedInterface | undefined
    let braceDepth = 0

    for (const line of lines) {
      if (currentInterface) {
        // Extract members before counting braces on this line
        if (braceDepth === 1) {
          const methodMatch = INTERFACE_METHOD_RE.exec(line)
          if (methodMatch) {
            currentInterface.members.push({ name: methodMatch[1]!, kind: 'method' })
          } else {
            const propMatch = INTERFACE_PROP_RE.exec(line)
            if (propMatch) {
              currentInterface.members.push({ name: propMatch[1]!, kind: 'property' })
            }
          }
        }

        for (const ch of line) {
          if (ch === '{') braceDepth++
          if (ch === '}') braceDepth--
        }

        if (braceDepth <= 0) {
          interfaces.set(currentInterface.name, currentInterface)
          currentInterface = undefined
          braceDepth = 0
          continue
        }

        continue
      }

      const ifaceMatch = INTERFACE_RE.exec(line)
      if (ifaceMatch) {
        currentInterface = { name: ifaceMatch[1]!, members: [] }
        braceDepth = 0
        for (const ch of line) {
          if (ch === '{') braceDepth++
          if (ch === '}') braceDepth--
        }
        if (braceDepth <= 0 && line.includes('{')) {
          interfaces.set(currentInterface.name, currentInterface)
          currentInterface = undefined
          braceDepth = 0
        }
      }
    }
  }

  return interfaces
}

function extractClasses(files: GeneratedFile[]): Array<ParsedClass & { file: string }> {
  const classes: Array<ParsedClass & { file: string }> = []

  for (const file of files) {
    const lines = file.content.split('\n')
    let currentClass: (ParsedClass & { file: string }) | undefined
    let braceDepth = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!

      if (currentClass) {
        // Extract members BEFORE counting braces on this line,
        // because a method declaration opens a brace on the same line
        // (e.g., `greet(name: string): string {` goes from depth 1 to 2).
        if (braceDepth === 1) {
          const memberMatch = CLASS_MEMBER_RE.exec(line)
          if (memberMatch) {
            currentClass.memberNames.add(memberMatch[1]!)
          }
        }

        for (const ch of line) {
          if (ch === '{') braceDepth++
          if (ch === '}') braceDepth--
        }

        if (braceDepth <= 0) {
          classes.push(currentClass)
          currentClass = undefined
          braceDepth = 0
          continue
        }

        continue
      }

      const classMatch = CLASS_RE.exec(line)
      if (classMatch) {
        const implementsList = classMatch[2]
          ? classMatch[2].split(',').map((s) => s.trim()).filter(Boolean)
          : []

        currentClass = {
          name: classMatch[1]!,
          implements: implementsList,
          memberNames: new Set(),
          line: i + 1,
          file: file.path,
        }

        braceDepth = 0
        for (const ch of line) {
          if (ch === '{') braceDepth++
          if (ch === '}') braceDepth--
        }
        if (braceDepth <= 0 && line.includes('{')) {
          classes.push(currentClass)
          currentClass = undefined
          braceDepth = 0
        }
      }
    }
  }

  return classes
}

export function createContractComplianceRule(): GuardrailRule {
  return {
    id: 'contract-compliance',
    name: 'ContractComplianceRule',
    description: 'Verifies that generated classes implement all members of their declared interfaces',
    severity: 'error',
    category: 'contracts',
    check(context: GuardrailContext): GuardrailResult {
      const violations: GuardrailViolation[] = []
      const interfaces = extractInterfaces(context.files)
      const classes = extractClasses(context.files)

      for (const cls of classes) {
        for (const ifaceName of cls.implements) {
          const iface = interfaces.get(ifaceName)
          if (!iface) continue // Interface not in generated files — skip

          for (const member of iface.members) {
            if (!cls.memberNames.has(member.name)) {
              violations.push({
                ruleId: 'contract-compliance',
                file: cls.file,
                line: cls.line,
                message: `Class "${cls.name}" implements "${ifaceName}" but is missing ${member.kind} "${member.name}".`,
                severity: 'error',
                suggestion: `Add ${member.kind} "${member.name}" to class "${cls.name}".`,
                autoFixable: false,
              })
            }
          }
        }
      }

      return { passed: violations.length === 0, violations }
    },
  }
}
