# 09 — Connectors & Ecosystem

> **Gaps addressed**: G-08 (connector ecosystem), G-10 (AGENTS.md), plus RAG integration

---

## 1. Connector Architecture (G-08)

### Problem
Gnana ships pre-built connectors (GitHub, Slack, HTTP) as tool factories. DzipAgent requires every integration to be built from scratch.

### Design

```typescript
// connectors/src/connector-types.ts
import { DynamicStructuredTool } from '@langchain/core/tools';

export interface ConnectorConfig {
  /** Authentication credentials */
  credentials: Record<string, string>;
  /** Subset of tools to expose (default: all) */
  enabledTools?: string[];
}

export interface Connector {
  name: string;
  description: string;
  /** Create LangChain tools from this connector */
  createTools(config: ConnectorConfig): DynamicStructuredTool[];
}
```

### 1.1 GitHub Connector

```typescript
// connectors/src/github/github-connector.ts
export function createGitHubConnector(config: {
  token: string;
  enabledTools?: string[];
}): DynamicStructuredTool[] {
  const octokit = new Octokit({ auth: config.token });
  const all = [
    createGetRepoTool(octokit),
    createListIssuesTool(octokit),
    createCreateIssueTool(octokit),
    createGetFileTool(octokit),
    createCreatePRTool(octokit),
    createListPRsTool(octokit),
    createSearchCodeTool(octokit),
  ];

  if (config.enabledTools) {
    return all.filter(t => config.enabledTools!.includes(t.name));
  }
  return all;
}

function createGetFileTool(octokit: Octokit): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'github_get_file',
    description: 'Get file content from a GitHub repository',
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      ref: z.string().optional().describe('Branch or commit ref'),
    }),
    func: async ({ owner, repo, path, ref }) => {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
      if ('content' in data) {
        return Buffer.from(data.content, 'base64').toString('utf8');
      }
      return JSON.stringify(data);
    },
  });
}

// ... similar for issues, PRs, search
```

### 1.2 HTTP Connector (Generic REST API)

```typescript
// connectors/src/http/http-connector.ts
export function createHTTPConnector(config: {
  baseUrl: string;
  headers?: Record<string, string>;
  enabledMethods?: ('GET' | 'POST' | 'PUT' | 'DELETE')[];
}): DynamicStructuredTool[] {
  return [
    new DynamicStructuredTool({
      name: 'http_request',
      description: `Make HTTP requests to ${config.baseUrl}`,
      schema: z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
        path: z.string().describe('URL path (appended to base URL)'),
        body: z.unknown().optional().describe('Request body (for POST/PUT)'),
        query: z.record(z.string()).optional().describe('Query parameters'),
      }),
      func: async ({ method, path, body, query }) => {
        const url = new URL(path, config.baseUrl);
        if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

        const response = await fetch(url.toString(), {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...config.headers,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const text = await response.text();
        return `${response.status} ${response.statusText}\n\n${text}`;
      },
    }),
  ];
}
```

### 1.3 Slack Connector

```typescript
// connectors/src/slack/slack-connector.ts
export function createSlackConnector(config: {
  token: string;
}): DynamicStructuredTool[] {
  return [
    new DynamicStructuredTool({
      name: 'slack_send_message',
      description: 'Send a message to a Slack channel',
      schema: z.object({
        channel: z.string().describe('Channel ID or name'),
        text: z.string().describe('Message text'),
        thread_ts: z.string().optional().describe('Thread timestamp for replies'),
      }),
      func: async ({ channel, text, thread_ts }) => {
        const response = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channel, text, thread_ts }),
        });
        const data = await response.json();
        return data.ok ? `Message sent to ${channel}` : `Error: ${data.error}`;
      },
    }),
    // ... list_channels, search_messages, upload_file
  ];
}
```

### 1.4 Database Connector

```typescript
// connectors/src/database/db-connector.ts
export function createDatabaseConnector(config: {
  connectionString: string;
  readOnly?: boolean;
  allowedTables?: string[];
}): DynamicStructuredTool[] {
  return [
    new DynamicStructuredTool({
      name: 'db_query',
      description: 'Execute a SQL query against the database',
      schema: z.object({
        sql: z.string().describe('SQL query to execute'),
        params: z.array(z.unknown()).optional(),
      }),
      func: async ({ sql, params }) => {
        if (config.readOnly && !sql.trim().toUpperCase().startsWith('SELECT')) {
          return 'Error: Only SELECT queries allowed (read-only mode)';
        }
        // ... execute with connection pool
      },
    }),
    new DynamicStructuredTool({
      name: 'db_schema',
      description: 'Get the database schema (tables, columns, types)',
      schema: z.object({
        table: z.string().optional().describe('Specific table name'),
      }),
      func: async ({ table }) => {
        // ... query information_schema
      },
    }),
  ];
}
```

---

## 2. AGENTS.md Hierarchical Support (G-10)

### Problem
DzipAgent has `SKILL.md` files but no support for the emerging AGENTS.md standard (used by Codex CLI, Cursor, Claude Code). No hierarchical discovery from git root to CWD.

### 2.1 AGENTS.md Parser

```typescript
// core/src/skills/agents-md-parser.ts
export interface AgentsMdConfig {
  /** Instructions to inject into system prompt */
  instructions: string[];
  /** Glob-based conditional rules */
  rules: Array<{
    glob: string;
    instructions: string[];
  }>;
  /** Tool restrictions */
  allowedTools?: string[];
  blockedTools?: string[];
}

export function parseAgentsMd(content: string): AgentsMdConfig {
  const config: AgentsMdConfig = { instructions: [], rules: [] };

  // Split by sections
  const sections = content.split(/^## /m);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const heading = lines[0]?.trim();
    const body = lines.slice(1).join('\n').trim();

    if (!heading || heading.startsWith('#')) {
      // Top-level instructions (before any ## heading)
      config.instructions.push(body);
      continue;
    }

    // Check for glob pattern in heading: ## *.test.ts
    const globMatch = heading.match(/^([*?[\]{}]+\S*)/);
    if (globMatch) {
      config.rules.push({ glob: globMatch[1], instructions: [body] });
      continue;
    }

    // Named sections
    if (heading.toLowerCase() === 'tools') {
      const toolLines = body.split('\n').filter(l => l.trim().startsWith('-'));
      for (const line of toolLines) {
        const tool = line.replace(/^-\s*/, '').trim();
        if (tool.startsWith('!')) {
          (config.blockedTools ??= []).push(tool.slice(1));
        } else {
          (config.allowedTools ??= []).push(tool);
        }
      }
    } else {
      config.instructions.push(`### ${heading}\n${body}`);
    }
  }

  return config;
}
```

### 2.2 Hierarchical Walker

```typescript
// core/src/skills/hierarchical-walker.ts
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface HierarchyLevel {
  path: string;
  source: 'global' | 'project' | 'directory';
  config: AgentsMdConfig;
}

const AGENTS_FILENAMES = ['AGENTS.md', '.agents.md', 'CLAUDE.md'];
const SKILL_FILENAMES = ['SKILL.md'];

export function discoverAgentConfigs(cwd: string): HierarchyLevel[] {
  const levels: HierarchyLevel[] = [];

  // 1. Global (~/.config/forgeagent/AGENTS.md)
  const globalDir = join(process.env.HOME ?? '', '.config', 'forgeagent');
  for (const name of AGENTS_FILENAMES) {
    const globalPath = join(globalDir, name);
    if (existsSync(globalPath)) {
      levels.push({
        path: globalPath,
        source: 'global',
        config: parseAgentsMd(readFileSync(globalPath, 'utf8')),
      });
    }
  }

  // 2. Project root (git root → find AGENTS.md)
  const gitRoot = getGitRoot(cwd);
  if (gitRoot) {
    for (const name of [...AGENTS_FILENAMES, ...SKILL_FILENAMES]) {
      const rootPath = join(gitRoot, name);
      if (existsSync(rootPath)) {
        levels.push({
          path: rootPath,
          source: 'project',
          config: parseAgentsMd(readFileSync(rootPath, 'utf8')),
        });
      }
    }
  }

  // 3. Walk from git root to CWD, collecting any AGENTS.md files
  if (gitRoot && cwd !== gitRoot) {
    let dir = cwd;
    while (dir !== gitRoot && dir !== dirname(dir)) {
      for (const name of AGENTS_FILENAMES) {
        const dirPath = join(dir, name);
        if (existsSync(dirPath)) {
          levels.push({
            path: dirPath,
            source: 'directory',
            config: parseAgentsMd(readFileSync(dirPath, 'utf8')),
          });
        }
      }
      dir = dirname(dir);
    }
  }

  return levels;
}

/** Merge configs: later levels override earlier ones */
export function mergeAgentConfigs(levels: HierarchyLevel[]): AgentsMdConfig {
  const merged: AgentsMdConfig = { instructions: [], rules: [] };

  for (const level of levels) {
    merged.instructions.push(...level.config.instructions);
    merged.rules.push(...level.config.rules);
    if (level.config.allowedTools) {
      merged.allowedTools = [...(merged.allowedTools ?? []), ...level.config.allowedTools];
    }
    if (level.config.blockedTools) {
      merged.blockedTools = [...(merged.blockedTools ?? []), ...level.config.blockedTools];
    }
  }

  return merged;
}

function getGitRoot(cwd: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
```

---

## 3. RAG Integration (Future: `@dzipagent/rag`)

### Architecture Sketch

```typescript
// rag/src/types.ts
export interface VectorStoreAdapter {
  name: string;
  upsert(documents: Document[]): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  delete(filter: Record<string, unknown>): Promise<void>;
}

export interface Document {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
}

export interface SearchOptions {
  limit?: number;
  filter?: Record<string, unknown>;
  minScore?: number;
}

// rag/src/pipeline.ts
export class RAGPipeline {
  constructor(
    private vectorStore: VectorStoreAdapter,
    private embedder: EmbeddingModel,
    private reranker?: Reranker,
  ) {}

  /** Ingest documents: chunk → embed → store */
  async ingest(documents: Document[], chunkConfig?: ChunkConfig): Promise<void> { ... }

  /** Retrieve: query → embed → search → rerank → return */
  async retrieve(query: string, options?: RetrieveOptions): Promise<Document[]> { ... }

  /** Inject retrieved context into agent messages */
  async augment(messages: BaseMessage[], query: string): Promise<BaseMessage[]> { ... }
}
```

**Supported vector stores** (via adapters):
- Qdrant (already used in SaaS app's rag-retrieval.service.ts)
- pgvector (PostgreSQL native)
- Chroma
- Pinecone

**Priority**: P2 — RAG exists at the app layer; extract and formalize when needed.

---

## 4. Implementation Estimates

| Component | Files | ~LOC | Priority |
|-----------|-------|------|----------|
| **@dzipagent/connectors** |
| Connector types | 1 | 30 | P2 |
| GitHub connector | 1 | 200 | P2 |
| HTTP connector | 1 | 80 | P2 |
| Slack connector | 1 | 120 | P2 |
| Database connector | 1 | 100 | P2 |
| **AGENTS.md support (in core)** |
| AGENTS.md parser | 1 | 80 | P1 |
| Hierarchical walker | 1 | 100 | P1 |
| Config merger | existing file | 30 | P1 |
| **RAG (future)** |
| Types | 1 | 40 | P3 |
| Pipeline | 1 | 150 | P3 |
| Qdrant adapter | 1 | 80 | P3 |
| pgvector adapter | 1 | 80 | P3 |
| **Total** | **~12 files** | **~1,090 LOC** | |
