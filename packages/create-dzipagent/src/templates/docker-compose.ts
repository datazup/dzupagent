import type { DatabaseProvider } from '../types.js'

export interface DockerComposeOptions {
  projectName: string
  database: DatabaseProvider
  features: string[]
  includeQdrant: boolean
}

/**
 * Generate a docker-compose.yml based on project configuration.
 */
export function generateDockerCompose(options: DockerComposeOptions): string {
  const services: string[] = []
  const volumes: string[] = []

  // App service
  services.push(`  app:
    build: .
    ports:
      - "\${PORT:-4000}:4000"
    env_file: .env
    depends_on:${options.database === 'postgres' ? '\n      postgres:\n        condition: service_healthy' : ''}${needsRedis(options) ? '\n      redis:\n        condition: service_healthy' : ''}
    restart: unless-stopped`)

  // PostgreSQL
  if (options.database === 'postgres') {
    services.push(`
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: ${options.projectName}
      POSTGRES_USER: forge
      POSTGRES_PASSWORD: forge_secret
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U forge"]
      interval: 5s
      timeout: 3s
      retries: 5`)
    volumes.push('  pgdata:')
  }

  // Redis
  if (needsRedis(options)) {
    services.push(`
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5`)
  }

  // Qdrant (vector DB for AI features)
  if (options.includeQdrant) {
    services.push(`
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:6333/healthz"]
      interval: 5s
      timeout: 3s
      retries: 5`)
    volumes.push('  qdrant_data:')
  }

  const volumeSection =
    volumes.length > 0 ? `\nvolumes:\n${volumes.join('\n')}\n` : ''

  return `version: "3.9"
services:
${services.join('\n')}
${volumeSection}`
}

function needsRedis(options: DockerComposeOptions): boolean {
  return (
    options.database === 'postgres' ||
    options.features.includes('ai') ||
    options.features.includes('billing')
  )
}
