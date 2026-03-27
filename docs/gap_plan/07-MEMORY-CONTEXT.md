# 07 — Memory & Context Improvements

> **Gaps addressed**: G-21 (working memory), G-22 (observational memory), G-23 (system reminders), G-30 (frozen snapshots)

---

## 1. Working Memory — Structured Persistent State (G-21)

### Problem
DzipAgent's `MemoryService` stores key-value pairs in namespaces. No way to persist **structured data** (user preferences, project config, accumulated knowledge) with schema validation across sessions.

### Solution

```typescript
// core/src/memory/working-memory.ts
import { z } from 'zod';

export interface WorkingMemoryConfig<T extends z.ZodType> {
  schema: T;
  namespace: string;
  store: MemoryService;
  /** Auto-save after each update (default: true) */
  autoSave?: boolean;
}

export class WorkingMemory<T extends z.ZodType> {
  private state: z.infer<T>;
  private dirty = false;

  constructor(private config: WorkingMemoryConfig<T>) {
    // Initialize with schema defaults
    this.state = config.schema.parse({});
  }

  /** Load state from store */
  async load(scope: Record<string, string>): Promise<z.infer<T>> {
    const stored = await this.config.store.get(this.config.namespace, scope);
    if (stored) {
      // Validate against schema — merge with defaults for new fields
      this.state = this.config.schema.parse(stored);
    }
    return this.state;
  }

  /** Get current state (typed) */
  get(): z.infer<T> {
    return structuredClone(this.state);
  }

  /** Update state (partial merge) */
  async update(
    scope: Record<string, string>,
    partial: Partial<z.infer<T>>
  ): Promise<z.infer<T>> {
    this.state = this.config.schema.parse({ ...this.state, ...partial });
    this.dirty = true;

    if (this.config.autoSave !== false) {
      await this.save(scope);
    }

    return this.state;
  }

  /** Persist to store */
  async save(scope: Record<string, string>): Promise<void> {
    if (!this.dirty) return;
    await this.config.store.put(this.config.namespace, scope, 'state', this.state);
    this.dirty = false;
  }

  /** Inject as system prompt context */
  toPromptContext(): string {
    return `## Working Memory\n\`\`\`json\n${JSON.stringify(this.state, null, 2)}\n\`\`\``;
  }
}
```

### Usage

```typescript
const projectMemory = new WorkingMemory({
  schema: z.object({
    preferredStack: z.string().optional(),
    projectGoals: z.array(z.string()).default([]),
    completedFeatures: z.array(z.string()).default([]),
    userPreferences: z.object({
      codeStyle: z.enum(['functional', 'oop']).default('functional'),
      testFramework: z.string().default('vitest'),
    }).default({}),
  }),
  namespace: 'working',
  store: memoryService,
});

// Load at session start
await projectMemory.load({ tenantId, projectId });

// Update during conversation
await projectMemory.update({ tenantId, projectId }, {
  preferredStack: 'vue3-express-prisma',
  completedFeatures: [...projectMemory.get().completedFeatures, 'auth'],
});

// Inject into agent prompt
const agent = new DzipAgent({
  instructions: `You are a code generator.\n\n${projectMemory.toPromptContext()}`,
  ...
});
```

---

## 2. Observational Memory — Automatic Fact Extraction (G-22)

### Problem
Memory is raw put/get/search. No automatic extraction of insights from conversations. Mastra has observational memory; Hermes has learning loop nudges.

### Solution

```typescript
// core/src/memory/observation-extractor.ts
export interface ObservationConfig {
  /** Model to use for extraction (cheap tier) */
  model: BaseChatModel;
  /** Minimum messages before triggering extraction */
  minMessages: number;        // default: 10
  /** Debounce: minimum interval between extractions */
  debounceMs: number;         // default: 30_000
  /** Maximum observations per session */
  maxObservations: number;    // default: 50
}

export interface Observation {
  text: string;
  category: 'fact' | 'preference' | 'decision' | 'convention' | 'constraint';
  confidence: number;  // 0-1
  source: 'extracted' | 'explicit';  // extracted from conversation or explicitly stated
  createdAt: number;
}

export class ObservationExtractor {
  private lastExtractedAt = 0;
  private extractionCount = 0;

  constructor(private config: ObservationConfig) {}

  /** Check if extraction should be triggered */
  shouldExtract(messageCount: number): boolean {
    if (messageCount < this.config.minMessages) return false;
    if (this.extractionCount >= this.config.maxObservations) return false;
    if (Date.now() - this.lastExtractedAt < this.config.debounceMs) return false;
    return true;
  }

  /** Extract observations from recent messages */
  async extract(messages: BaseMessage[]): Promise<Observation[]> {
    this.lastExtractedAt = Date.now();

    const response = await this.config.model.invoke([
      new SystemMessage(EXTRACTION_PROMPT),
      new HumanMessage(
        `Recent conversation:\n\n${messages.map(m => `${m._getType()}: ${m.content}`).join('\n\n')}`
      ),
    ]);

    // Parse structured output
    const parsed = this.parseObservations(response.content.toString());
    this.extractionCount += parsed.length;

    return parsed;
  }
}

const EXTRACTION_PROMPT = `Extract key observations from this conversation. For each, provide:
- text: The observation (concise, factual)
- category: fact | preference | decision | convention | constraint
- confidence: 0-1 (how certain is this observation)

Return as JSON array. Only extract clearly stated or strongly implied observations.
Deduplicate — don't repeat observations from previous extractions.`;
```

### Integration with MemoryService

```typescript
// In DzipAgent, after each conversation turn:
if (observationExtractor.shouldExtract(messages.length)) {
  const observations = await observationExtractor.extract(recentMessages);
  for (const obs of observations) {
    await memoryService.put('observations', scope, obs.text, obs, {
      index: ['text'],
    });
  }
}
```

---

## 3. System Reminders — Periodic Instruction Re-injection (G-23)

### Problem
During long multi-step sessions, the LLM can "forget" instructions that were only in the system prompt. Claude Code uses `<system-reminder>` tags to periodically re-inject key instructions.

### Solution

```typescript
// core/src/context/system-reminder.ts
export interface SystemReminderConfig {
  /** Re-inject every N messages */
  intervalMessages: number;       // default: 15
  /** Content to re-inject */
  reminders: ReminderContent[];
  /** Tag format */
  tagName: string;                // default: 'system-reminder'
}

export interface ReminderContent {
  id: string;
  content: string;
  /** Only inject when condition is met */
  condition?: (state: AgentState) => boolean;
}

export class SystemReminderInjector {
  private lastInjectedAt = 0;

  constructor(private config: SystemReminderConfig) {}

  /** Check if reminders should be injected */
  shouldInject(messagesSinceLastInjection: number): boolean {
    return messagesSinceLastInjection >= this.config.intervalMessages;
  }

  /** Create reminder messages to inject */
  createReminders(state: AgentState): BaseMessage[] {
    const tag = this.config.tagName;
    const applicableReminders = this.config.reminders.filter(
      r => !r.condition || r.condition(state)
    );

    if (applicableReminders.length === 0) return [];

    const content = applicableReminders
      .map(r => `<${tag}>\n${r.content}\n</${tag}>`)
      .join('\n\n');

    this.lastInjectedAt = Date.now();

    return [new SystemMessage(content)];
  }
}
```

### Usage

```typescript
const reminders = new SystemReminderInjector({
  intervalMessages: 15,
  reminders: [
    {
      id: 'core-rules',
      content: 'Remember: TypeScript strict mode, no `any`, ESM modules, Tailwind CSS 4.',
    },
    {
      id: 'current-task',
      content: 'Current task: Implement authentication flow.',
      condition: (state) => state.metadata?.currentTask === 'auth',
    },
    {
      id: 'budget-status',
      content: (state) => `Budget: ${state.budget?.percent ?? 0}% used.`,
      condition: (state) => (state.budget?.percent ?? 0) > 50,
    },
  ],
});
```

---

## 4. Frozen Snapshot for Prompt Cache Optimization (G-30)

### Problem
Hermes freezes memory at session start and never mutates it mid-session. This preserves the Anthropic prompt cache prefix, achieving ~75% cost reduction. DzipAgent updates memory during sessions, potentially invalidating the cache.

### Solution

```typescript
// core/src/memory/memory-service.ts — ENHANCED

export class MemoryService {
  private frozenSnapshots = new Map<string, unknown>();
  private frozen = false;

  /** Freeze memory at session start — all reads return the snapshot */
  async freezeForSession(namespaces: string[], scope: Record<string, string>): Promise<void> {
    for (const ns of namespaces) {
      const data = await this.get(ns, scope);
      this.frozenSnapshots.set(ns, data);
    }
    this.frozen = true;
  }

  /** Read: return frozen snapshot if available */
  async get(namespace: string, scope: Record<string, string>, key?: string): Promise<unknown> {
    if (this.frozen && this.frozenSnapshots.has(namespace)) {
      return this.frozenSnapshots.get(namespace);
    }
    return this._realGet(namespace, scope, key);
  }

  /** Write: accumulate in a write-buffer; flush on session end */
  async put(namespace: string, scope: Record<string, string>, key: string, value: unknown): Promise<void> {
    if (this.frozen) {
      // Buffer writes for later
      this.writeBuffer.push({ namespace, scope, key, value });
      return;
    }
    return this._realPut(namespace, scope, key, value);
  }

  /** End session: flush buffered writes */
  async unfreeze(): Promise<void> {
    this.frozen = false;
    for (const { namespace, scope, key, value } of this.writeBuffer) {
      await this._realPut(namespace, scope, key, value);
    }
    this.writeBuffer = [];
    this.frozenSnapshots.clear();
  }
}
```

This ensures the system prompt (which includes memory context) remains identical throughout the session, maximizing cache hits.

---

## 5. Confidence-Scored Memory (Enhancement to G-21/G-22)

### Problem
Stored facts have no confidence score. No way to prioritize high-confidence memories or decay old ones.

### Solution

```typescript
// core/src/memory/memory-types.ts — ENHANCED
export interface MemoryRecord {
  key: string;
  value: unknown;
  confidence: number;          // 0-1
  category: MemoryCategory;
  createdAt: number;
  accessedAt: number;
  accessCount: number;
}

export type MemoryCategory =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'convention'
  | 'constraint'
  | 'goal'
  | 'knowledge';

// Decay function: confidence decreases over time if not accessed
export function decayConfidence(record: MemoryRecord, now: number): number {
  const daysSinceAccess = (now - record.accessedAt) / (24 * 60 * 60 * 1000);
  const decayFactor = Math.exp(-0.05 * daysSinceAccess); // ~5% decay per day
  return record.confidence * decayFactor;
}
```

---

## 6. Implementation Estimates

| Component | Files | ~LOC | Priority |
|-----------|-------|------|----------|
| Working memory | 1 | 100 | P1 |
| Observation extractor | 1 | 120 | P2 |
| System reminder injector | 1 | 80 | P1 |
| Frozen snapshot pattern | existing file | 50 | P2 |
| Confidence scoring | existing files | 40 | P2 |
| Memory categories | existing file | 20 | P2 |
| **Total** | **~4 new files** | **~410 LOC** | |
