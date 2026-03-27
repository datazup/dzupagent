# 04 — Server & Runtime Infrastructure

> **Gaps addressed**: G-02 (server/API), G-04 (run persistence), G-05 (approval gates), G-20 (agent persistence)

---

## 1. Problem Statement

DzipAgent is a **library without a runtime**. Consumers must build their own HTTP server, WebSocket streaming, run management, and persistence layer. Gnana ships a complete Hono server with REST API, WebSocket, auth, and workspace management out of the box.

The `@dzipagent/server` package provides an **optional, batteries-included runtime** that can be used standalone or integrated into existing Express/Hono apps.

---

## 2. Server Architecture

### 2.1 Hono App Factory

```typescript
// server/src/app.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';

export interface ForgeServerConfig {
  agentStore: AgentStore;
  runStore: RunStore;
  eventBus: DzipEventBus;
  modelRegistry: ModelRegistry;
  memoryService?: MemoryService;
  auth?: AuthConfig;
  cors?: CorsConfig;
}

export function createForgeApp(config: ForgeServerConfig): Hono {
  const app = new Hono();

  // Middleware
  app.use('*', cors(config.cors));
  if (config.auth) app.use('*', authMiddleware(config.auth));

  // Routes
  app.route('/api/agents', createAgentRoutes(config));
  app.route('/api/runs', createRunRoutes(config));
  app.route('/api/tools', createToolRoutes(config));
  app.route('/api/health', createHealthRoutes(config));

  return app;
}
```

### 2.2 REST API Endpoints

#### Agent Management
```
GET    /api/agents           List agent definitions
POST   /api/agents           Create agent definition
GET    /api/agents/:id       Get agent by ID
PATCH  /api/agents/:id       Update agent definition
DELETE /api/agents/:id       Delete agent
GET    /api/agents/:id/versions  List agent version history
```

#### Run Management
```
POST   /api/runs             Trigger a run (agentId + input)
GET    /api/runs             List runs (filter by agent, status, date)
GET    /api/runs/:id         Get run details (status, output, logs)
POST   /api/runs/:id/cancel  Cancel a running execution
GET    /api/runs/:id/logs    Get run logs
GET    /api/runs/:id/stream  SSE stream of run events
```

#### Approval Management (G-05)
```
GET    /api/runs/:id/approval   Get approval request details
POST   /api/runs/:id/approve    Approve a pending run
POST   /api/runs/:id/reject     Reject a pending run (with reason)
```

#### Tool Management
```
GET    /api/tools             List all available tools (custom + MCP)
GET    /api/tools/:name       Get tool details + schema
```

#### Health
```
GET    /api/health            Liveness check
GET    /api/health/ready      Readiness check (DB, providers)
```

---

## 3. Run Persistence (G-04)

### 3.1 Run Lifecycle

```
┌──────┐    ┌─────────┐    ┌──────────────────┐    ┌───────────┐    ┌───────────┐
│queued│ -> │ running  │ -> │awaiting_approval │ -> │ approved  │ -> │ completed │
└──────┘    └─────────┘    └──────────────────┘    └───────────┘    └───────────┘
               │                    │                                      │
               │                    ▼                                      │
               │              ┌──────────┐                                 │
               │              │ rejected │                                 │
               │              └──────────┘                                 │
               ▼                                                           │
          ┌────────┐                                                       │
          │ failed │  <────────────────────────────────────────────────────┘
          └────────┘                                   (on error)
```

### 3.2 Postgres Run Store

```typescript
// server/src/persistence/postgres-run-store.ts
export class PostgresRunStore implements RunStore {
  constructor(private db: DrizzleClient) {}

  async create(input: CreateRunInput): Promise<Run> {
    const [run] = await this.db.insert(runs).values({
      id: crypto.randomUUID(),
      agentId: input.agentId,
      status: 'queued',
      input: input.input,
      metadata: input.metadata ?? {},
      startedAt: new Date(),
    }).returning();
    return run;
  }

  async update(id: string, update: Partial<Run>): Promise<void> {
    await this.db.update(runs).set(update).where(eq(runs.id, id));
  }

  async addLog(runId: string, entry: LogEntry): Promise<void> {
    await this.db.insert(runLogs).values({
      runId,
      level: entry.level,
      message: entry.message,
      phase: entry.phase,
      data: entry.data,
      timestamp: new Date(),
    });
  }

  async list(filter?: RunFilter): Promise<Run[]> {
    let query = this.db.select().from(runs);
    if (filter?.agentId) query = query.where(eq(runs.agentId, filter.agentId));
    if (filter?.status) query = query.where(eq(runs.status, filter.status));
    return query.orderBy(desc(runs.startedAt)).limit(filter?.limit ?? 50);
  }
}
```

### 3.3 Database Schema (Drizzle)

```typescript
// server/src/persistence/drizzle-schema.ts
export const agentDefinitions = pgTable('dzip_agents', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  instructions: text('instructions').notNull(),
  modelTier: varchar('model_tier', { length: 50 }).notNull(),
  tools: jsonb('tools').$type<string[]>().default([]),
  guardrails: jsonb('guardrails').$type<GuardrailConfig>(),
  hooks: jsonb('hooks').$type<string[]>().default([]),
  approval: varchar('approval', { length: 20 }).default('auto'),
  version: integer('version').default(1),
  active: boolean('active').default(true),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const runs = pgTable('forge_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id').references(() => agentDefinitions.id),
  status: varchar('status', { length: 30 }).notNull().default('queued'),
  input: jsonb('input'),
  output: jsonb('output'),
  plan: jsonb('plan'),
  tokenUsageInput: integer('token_usage_input').default(0),
  tokenUsageOutput: integer('token_usage_output').default(0),
  costCents: real('cost_cents').default(0),
  error: text('error'),
  metadata: jsonb('metadata').default({}),
  startedAt: timestamp('started_at').defaultNow(),
  completedAt: timestamp('completed_at'),
});

export const runLogs = pgTable('forge_run_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
  level: varchar('level', { length: 10 }).notNull(),
  phase: varchar('phase', { length: 50 }),
  message: text('message').notNull(),
  data: jsonb('data'),
  timestamp: timestamp('timestamp').defaultNow(),
});
```

---

## 4. Human-in-the-Loop Approval (G-05)

### 4.1 Approval Gate

```typescript
// agent/src/approval/approval-gate.ts
export interface ApprovalConfig {
  mode: 'auto' | 'required' | 'conditional';
  /** For 'conditional' mode: function that decides if approval is needed */
  condition?: (plan: unknown, context: HookContext) => boolean | Promise<boolean>;
  /** Timeout before auto-rejection (default: no timeout) */
  timeoutMs?: number;
  /** Webhook URL to notify when approval is needed */
  webhookUrl?: string;
}

export class ApprovalGate {
  constructor(
    private config: ApprovalConfig,
    private eventBus: DzipEventBus,
    private runStore: RunStore,
  ) {}

  async checkApproval(runId: string, plan: unknown, ctx: HookContext): Promise<'approved' | 'rejected'> {
    if (this.config.mode === 'auto') return 'approved';

    const needsApproval = this.config.mode === 'required'
      || (this.config.condition && await this.config.condition(plan, ctx));

    if (!needsApproval) return 'approved';

    // Pause execution
    await this.runStore.update(runId, { status: 'awaiting_approval', plan });
    this.eventBus.emit({ type: 'approval:requested', runId, plan });

    // Notify via webhook if configured
    if (this.config.webhookUrl) {
      await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, plan, type: 'approval_requested' }),
      }).catch(() => {});  // non-critical
    }

    // Wait for approval/rejection (via API endpoint)
    return new Promise((resolve) => {
      const unsub1 = this.eventBus.on('approval:granted', (e) => {
        if (e.runId === runId) { unsub1(); unsub2(); resolve('approved'); }
      });
      const unsub2 = this.eventBus.on('approval:rejected', (e) => {
        if (e.runId === runId) { unsub1(); unsub2(); resolve('rejected'); }
      });

      // Timeout
      if (this.config.timeoutMs) {
        setTimeout(() => {
          unsub1(); unsub2();
          this.eventBus.emit({ type: 'approval:rejected', runId, reason: 'timeout' });
          resolve('rejected');
        }, this.config.timeoutMs);
      }
    });
  }
}
```

### 4.2 Approval API Endpoints

```typescript
// server/src/routes/approval.ts
app.post('/api/runs/:id/approve', async (c) => {
  const runId = c.req.param('id');
  const run = await runStore.get(runId);
  if (!run || run.status !== 'awaiting_approval') {
    return c.json({ error: 'Run not awaiting approval' }, 400);
  }

  await runStore.update(runId, { status: 'approved' });
  eventBus.emit({ type: 'approval:granted', runId, approvedBy: c.get('userId') });

  return c.json({ status: 'approved' });
});

app.post('/api/runs/:id/reject', async (c) => {
  const { reason } = await c.req.json();
  const runId = c.req.param('id');
  const run = await runStore.get(runId);
  if (!run || run.status !== 'awaiting_approval') {
    return c.json({ error: 'Run not awaiting approval' }, 400);
  }

  await runStore.update(runId, { status: 'rejected', error: reason });
  eventBus.emit({ type: 'approval:rejected', runId, reason });

  return c.json({ status: 'rejected' });
});
```

---

## 5. WebSocket Event Streaming

```typescript
// server/src/ws/event-bridge.ts
/**
 * Bridge EventBus events to WebSocket clients.
 * Clients subscribe to specific runs or all events.
 */
export class EventBridge {
  private subscriptions = new Map<string, Set<WebSocket>>();

  constructor(private eventBus: DzipEventBus) {
    // Forward all events to subscribed WebSocket clients
    const eventTypes: DzipEvent['type'][] = [
      'agent:started', 'agent:completed', 'agent:failed',
      'tool:called', 'tool:result',
      'pipeline:phase_changed', 'pipeline:validation_failed',
      'approval:requested', 'approval:granted', 'approval:rejected',
      'budget:warning', 'budget:exceeded',
    ];

    for (const type of eventTypes) {
      this.eventBus.on(type, (event) => {
        const runId = 'runId' in event ? event.runId : undefined;
        this.broadcast(runId, event);
      });
    }
  }

  subscribe(ws: WebSocket, runId?: string): void {
    const key = runId ?? '*';
    if (!this.subscriptions.has(key)) this.subscriptions.set(key, new Set());
    this.subscriptions.get(key)!.add(ws);
  }

  private broadcast(runId: string | undefined, event: DzipEvent): void {
    // Send to run-specific subscribers
    if (runId) {
      const subs = this.subscriptions.get(runId);
      if (subs) for (const ws of subs) ws.send(JSON.stringify(event));
    }
    // Send to wildcard subscribers
    const wildcards = this.subscriptions.get('*');
    if (wildcards) for (const ws of wildcards) ws.send(JSON.stringify(event));
  }
}
```

---

## 6. Authentication (API Keys)

```typescript
// server/src/middleware/auth.ts
export interface AuthConfig {
  mode: 'api-key' | 'jwt' | 'none';
  apiKeyStore?: ApiKeyStore;
  jwtSecret?: string;
}

export function authMiddleware(config: AuthConfig) {
  return async (c: Context, next: Next) => {
    if (config.mode === 'none') return next();

    if (config.mode === 'api-key') {
      const key = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!key) return c.json({ error: 'Missing API key' }, 401);

      const valid = await config.apiKeyStore?.validate(key);
      if (!valid) return c.json({ error: 'Invalid API key' }, 401);

      c.set('apiKey', valid);
      return next();
    }
  };
}
```

---

## 7. Implementation Estimates

| Component | Files | ~LOC | Priority |
|-----------|-------|------|----------|
| Hono app factory | 1 | 60 | P0 |
| Agent routes | 1 | 100 | P1 |
| Run routes | 1 | 120 | P0 |
| Approval routes | 1 | 60 | P0 |
| Tool routes | 1 | 40 | P1 |
| Health routes | 1 | 30 | P1 |
| Postgres run store | 1 | 120 | P0 |
| Postgres agent store | 1 | 100 | P1 |
| Drizzle schema | 1 | 80 | P0 |
| WebSocket handler | 1 | 80 | P1 |
| Event bridge | 1 | 60 | P1 |
| Auth middleware | 1 | 50 | P1 |
| Rate limiter | 1 | 40 | P2 |
| Approval gate | 1 | 100 | P0 |
| **Total** | **~14 files** | **~1,040 LOC** | |

### New Dependencies for `@dzipagent/server`

```json
{
  "dependencies": {
    "@dzipagent/core": "0.1.0",
    "@dzipagent/agent": "0.1.0",
    "hono": "^4.0.0",
    "drizzle-orm": "^0.36.0",
    "drizzle-kit": "^0.28.0"
  },
  "peerDependencies": {
    "postgres": "^3.0.0"
  }
}
```
