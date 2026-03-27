# 08 — Testing & Evaluation Framework

> **Gaps addressed**: G-28 (LLM recorder), G-29 (eval framework), boundary tests

---

## 1. LLM Recorder for Deterministic Testing (G-28)

### Problem
Tests depend on live LLM calls or manual mocks. No way to record and replay interactions for deterministic CI/CD.

### Solution: `@dzipagent/test-utils`

```typescript
// test-utils/src/llm-recorder.ts
export interface RecorderConfig {
  fixtureDir: string;           // e.g., '__fixtures__/llm'
  mode: 'record' | 'replay' | 'passthrough';
  /** Hash function for deterministic fixture naming */
  hashInput?: (messages: BaseMessage[]) => string;
}

export class LLMRecorder {
  constructor(private config: RecorderConfig) {}

  /** Wrap a model with record/replay behavior */
  wrap(model: BaseChatModel): BaseChatModel {
    const self = this;

    return new Proxy(model, {
      get(target, prop) {
        if (prop === 'invoke') {
          return async (messages: BaseMessage[], options?: unknown) => {
            const hash = self.hashMessages(messages);
            const fixturePath = join(self.config.fixtureDir, `${hash}.json`);

            if (self.config.mode === 'replay') {
              return self.loadFixture(fixturePath);
            }

            const result = await target.invoke(messages, options);

            if (self.config.mode === 'record') {
              await self.saveFixture(fixturePath, {
                input: messages.map(m => ({ role: m._getType(), content: m.content })),
                output: { role: 'assistant', content: result.content },
                model: target.getName?.() ?? 'unknown',
                recordedAt: new Date().toISOString(),
              });
            }

            return result;
          };
        }
        return Reflect.get(target, prop);
      },
    });
  }

  /** Create a replay-only model from a named scenario */
  replay(scenarioName: string): BaseChatModel {
    const fixturePath = join(this.config.fixtureDir, `${scenarioName}.json`);
    return new MockChatModel(this.loadFixture(fixturePath));
  }

  private hashMessages(messages: BaseMessage[]): string {
    if (this.config.hashInput) return this.config.hashInput(messages);
    const content = messages.map(m => m.content).join('|');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  private async saveFixture(path: string, data: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2));
  }

  private loadFixture(path: string): unknown {
    return JSON.parse(readFileSync(path, 'utf8'));
  }
}
```

### Usage in Tests

```typescript
import { LLMRecorder } from '@dzipagent/test-utils';

describe('CodeGenService', () => {
  const recorder = new LLMRecorder({
    fixtureDir: '__fixtures__/llm',
    mode: process.env.LLM_RECORD ? 'record' : 'replay',
  });

  it('generates a Vue component', async () => {
    const model = recorder.wrap(new ChatAnthropic({ model: 'claude-haiku-4-5' }));
    const codeGen = new CodeGenService(model);

    const result = await codeGen.generateFile({
      filePath: 'src/components/Button.vue',
      purpose: 'Primary button component',
    });

    expect(result).toContain('<template>');
    expect(result).toContain('defineProps');
  });
});
```

### Mock Chat Model

```typescript
// test-utils/src/mock-model.ts
export class MockChatModel extends BaseChatModel {
  private responses: Array<{ content: string }>;
  private callIndex = 0;

  constructor(fixture: unknown) {
    super({});
    this.responses = Array.isArray(fixture) ? fixture : [fixture];
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const response = this.responses[this.callIndex % this.responses.length];
    this.callIndex++;
    return {
      generations: [{ text: response.content, message: new AIMessage(response.content) }],
    };
  }

  _llmType(): string { return 'mock'; }
}
```

---

## 2. Evaluation Framework (G-29)

### Problem
`QualityScorer` only evaluates code quality (typeStrictness, eslintClean, etc.). No way to evaluate agent responses for faithfulness, accuracy, or custom criteria.

### Solution: `@dzipagent/evals`

### 2.1 Scorer Types

```typescript
// evals/src/types.ts
export interface EvalInput {
  input: string;           // The prompt/task
  output: string;          // The agent's response
  reference?: string;      // Expected/golden answer (optional)
  context?: string;        // Additional context
  metadata?: Record<string, unknown>;
}

export interface EvalResult {
  scorerId: string;
  score: number;           // 0-1 normalized
  pass: boolean;           // score >= threshold
  reasoning?: string;      // Why this score
  metadata?: Record<string, unknown>;
}

export interface Scorer {
  id: string;
  type: 'llm' | 'deterministic' | 'statistical';
  threshold: number;       // Pass threshold (default: 0.7)
  evaluate(input: EvalInput): Promise<EvalResult>;
}
```

### 2.2 LLM Judge Scorer

```typescript
// evals/src/scorers/llm-judge.ts
export function createLLMJudge(config: {
  id: string;
  model: BaseChatModel;
  criteria: string;
  rubric?: string;
  threshold?: number;
}): Scorer {
  return {
    id: config.id,
    type: 'llm',
    threshold: config.threshold ?? 0.7,
    async evaluate(input: EvalInput): Promise<EvalResult> {
      const prompt = `Evaluate the following output against these criteria:

Criteria: ${config.criteria}
${config.rubric ? `Rubric:\n${config.rubric}` : ''}

Input: ${input.input}
Output: ${input.output}
${input.reference ? `Reference: ${input.reference}` : ''}

Rate on a scale of 0-10 and explain your reasoning.
Respond as JSON: { "score": <number>, "reasoning": "<string>" }`;

      const response = await config.model.invoke([new HumanMessage(prompt)]);
      const parsed = JSON.parse(response.content.toString());

      const normalizedScore = parsed.score / 10;
      return {
        scorerId: config.id,
        score: normalizedScore,
        pass: normalizedScore >= (config.threshold ?? 0.7),
        reasoning: parsed.reasoning,
      };
    },
  };
}
```

### 2.3 Deterministic Scorer

```typescript
// evals/src/scorers/deterministic.ts
export function createDeterministicScorer(config: {
  id: string;
  check: (input: EvalInput) => number;  // Returns 0-1
  threshold?: number;
}): Scorer {
  return {
    id: config.id,
    type: 'deterministic',
    threshold: config.threshold ?? 0.7,
    async evaluate(input: EvalInput): Promise<EvalResult> {
      const score = config.check(input);
      return {
        scorerId: config.id,
        score,
        pass: score >= (config.threshold ?? 0.7),
      };
    },
  };
}

// Built-in deterministic scorers
export const containsScorer = (id: string, expected: string[]) =>
  createDeterministicScorer({
    id,
    check: (input) => {
      const found = expected.filter(e => input.output.includes(e));
      return found.length / expected.length;
    },
  });

export const jsonValidScorer = createDeterministicScorer({
  id: 'json-valid',
  check: (input) => {
    try { JSON.parse(input.output); return 1; }
    catch { return 0; }
  },
});

export const lengthScorer = (id: string, minChars: number, maxChars: number) =>
  createDeterministicScorer({
    id,
    check: (input) => {
      const len = input.output.length;
      if (len < minChars || len > maxChars) return 0;
      return 1;
    },
  });
```

### 2.4 Composite Scorer

```typescript
// evals/src/scorers/composite.ts
export function createCompositeScorer(config: {
  id: string;
  scorers: Array<{ scorer: Scorer; weight: number }>;
  threshold?: number;
}): Scorer {
  return {
    id: config.id,
    type: 'llm',
    threshold: config.threshold ?? 0.7,
    async evaluate(input: EvalInput): Promise<EvalResult> {
      const results = await Promise.all(
        config.scorers.map(async ({ scorer, weight }) => ({
          result: await scorer.evaluate(input),
          weight,
        }))
      );

      const totalWeight = config.scorers.reduce((sum, s) => sum + s.weight, 0);
      const weightedScore = results.reduce(
        (sum, { result, weight }) => sum + result.score * weight,
        0
      ) / totalWeight;

      return {
        scorerId: config.id,
        score: weightedScore,
        pass: weightedScore >= (config.threshold ?? 0.7),
        reasoning: results.map(r => `${r.result.scorerId}: ${r.result.score.toFixed(2)}`).join(', '),
        metadata: { breakdown: results.map(r => r.result) },
      };
    },
  };
}
```

### 2.5 Eval Runner

```typescript
// evals/src/runner/eval-runner.ts
export class EvalRunner {
  constructor(
    private scorers: Scorer[],
    private store?: EvalResultStore,
  ) {}

  /** Evaluate a single input across all scorers */
  async evaluate(input: EvalInput): Promise<EvalResult[]> {
    const results = await Promise.all(
      this.scorers.map(s => s.evaluate(input))
    );

    if (this.store) {
      await this.store.save({ input, results, timestamp: new Date() });
    }

    return results;
  }

  /** Batch evaluation */
  async evaluateBatch(inputs: EvalInput[]): Promise<Map<number, EvalResult[]>> {
    const results = new Map<number, EvalResult[]>();
    for (let i = 0; i < inputs.length; i++) {
      results.set(i, await this.evaluate(inputs[i]));
    }
    return results;
  }

  /** Regression check: compare current scores against baseline */
  async regressionCheck(
    inputs: EvalInput[],
    baseline: Map<string, number>,  // scorerId → minimum score
  ): Promise<{ passed: boolean; regressions: string[] }> {
    const batchResults = await this.evaluateBatch(inputs);
    const regressions: string[] = [];

    // Aggregate scores per scorer
    const aggregated = new Map<string, number[]>();
    for (const results of batchResults.values()) {
      for (const result of results) {
        if (!aggregated.has(result.scorerId)) aggregated.set(result.scorerId, []);
        aggregated.get(result.scorerId)!.push(result.score);
      }
    }

    for (const [scorerId, scores] of aggregated) {
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      const minScore = baseline.get(scorerId);
      if (minScore !== undefined && avgScore < minScore) {
        regressions.push(`${scorerId}: ${avgScore.toFixed(3)} < ${minScore} (baseline)`);
      }
    }

    return { passed: regressions.length === 0, regressions };
  }
}
```

---

## 3. Boundary Enforcement Test

See `01-ARCHITECTURE.md` Section 4 for the full test. This ensures `core` never imports from `codegen`, `agent`, etc.

---

## 4. Implementation Estimates

| Component | Files | ~LOC | Priority |
|-----------|-------|------|----------|
| **@dzipagent/test-utils** |
| LLM recorder | 1 | 120 | P1 |
| Mock model | 1 | 40 | P1 |
| Test helpers | 1 | 60 | P1 |
| **@dzipagent/evals** |
| Types | 1 | 40 | P2 |
| LLM judge scorer | 1 | 80 | P2 |
| Deterministic scorers | 1 | 60 | P2 |
| Composite scorer | 1 | 50 | P2 |
| Eval runner | 1 | 100 | P2 |
| Regression checker | existing file | 40 | P2 |
| **Boundary test** | 1 | 50 | P0 |
| **Total** | **~10 files** | **~640 LOC** | |
