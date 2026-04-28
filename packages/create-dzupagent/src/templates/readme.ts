import type { PackageManagerType, DatabaseProvider, AuthProvider } from '../types.js'
import { getInstallCommand, getDevCommand } from '../utils.js'

export interface ReadmeOptions {
  projectName: string
  template: string
  features: string[]
  database: DatabaseProvider
  auth: AuthProvider
  packageManager: PackageManagerType
}

/**
 * Generate a README.md with getting started instructions.
 */
export function generateReadme(options: ReadmeOptions): string {
  const pm = options.packageManager
  const installCmd = getInstallCommand(pm)
  const devCmd = getDevCommand(pm)

  const featureList = options.features.length > 0
    ? options.features.map((f) => `- ${formatFeatureName(f)}`).join('\n')
    : '- Base template (no additional features)'

  const sections: string[] = [
    `# ${options.projectName}`,
    '',
    `Built with [DzupAgent](https://github.com/dzupagent) using the \`${options.template}\` template.`,
    '',
    '## Features',
    '',
    featureList,
    '',
    '## Quick Start',
    '',
    '```bash',
    '# Copy environment file and configure',
    'cp .env.example .env',
    '',
  ]

  // Docker option
  if (options.database !== 'none') {
    sections.push(
      '# Start infrastructure with Docker',
      'docker compose up -d',
      '',
    )
  }

  sections.push(
    '# Install dependencies',
    installCmd,
    '',
    '# Start development server',
    devCmd,
    '```',
    '',
  )

  // Database section
  if (options.database === 'postgres') {
    sections.push(
      '## Database',
      '',
      'This project uses PostgreSQL. The `docker-compose.yml` includes a Postgres service.',
      '',
      '```bash',
      '# Push schema to database',
    )
    if (pm === 'npm') {
      sections.push('npm run db:push')
    } else {
      sections.push(`${pm} db:push`)
    }
    sections.push('```', '')
  }

  // Auth section
  if (options.auth !== 'none') {
    sections.push(
      '## Authentication',
      '',
      options.auth === 'api-key'
        ? 'This project uses API key authentication. Set `DZIP_API_KEY` in your `.env` file.'
        : 'This project uses JWT authentication. Set `JWT_SECRET` in your `.env` file.',
      '',
    )
  }

  // Environment variables
  sections.push(
    '## Environment Variables',
    '',
    'See `.env.example` for all required configuration variables.',
    '',
  )

  // Build & Deploy
  sections.push(
    '## Build',
    '',
    '```bash',
  )
  if (pm === 'npm') {
    sections.push('npm run build')
  } else {
    sections.push(`${pm} build`)
  }
  sections.push('```', '')

  if (options.database !== 'none') {
    sections.push(
      '## Docker Deployment',
      '',
      '```bash',
      'docker compose up -d --build',
      '```',
      '',
    )
  }

  sections.push(
    '## License',
    '',
    'MIT',
    '',
  )

  return sections.join('\n')
}

function formatFeatureName(slug: string): string {
  const names: Record<string, string> = {
    auth: 'Authentication',
    dashboard: 'Dashboard API',
    billing: 'Billing (Stripe)',
    teams: 'Team Management',
    ai: 'AI / LLM Integration',
  }
  return names[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1)
}
