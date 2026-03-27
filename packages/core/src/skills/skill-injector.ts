import type { SkillDefinition } from './skill-types.js'

/**
 * Appends a "Skills Available" section to a system prompt, listing each
 * skill with its name, description, and file path.
 *
 * Returns the original prompt unchanged if the skill list is empty.
 */
export function injectSkills(
  systemPrompt: string,
  skills: SkillDefinition[],
): string {
  if (skills.length === 0) return systemPrompt

  const skillList = skills
    .map(
      (s) =>
        `- **${s.name}**: ${s.description} -> read full instructions from "${s.path}" when needed`,
    )
    .join('\n')

  const skillSection = [
    '',
    '',
    '## Skills Available',
    '',
    'You have access to specialized skills. Only read the full skill instructions when you need them:',
    '',
    skillList,
    '',
    'To use a skill, read its SKILL.md file for detailed instructions.',
  ].join('\n')

  return systemPrompt + skillSection
}
