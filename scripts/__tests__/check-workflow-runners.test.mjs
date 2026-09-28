import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkflowSource } from '../check-workflow-runners.mjs';

const workflow = runsOn => `name: Example\non: push\njobs:\n  test:\n    ${runsOn}\n    steps:\n      - run: node --version\n`;

test('accepts the owned Coolify runner group and label', () => {
  assert.deepEqual(validateWorkflowSource(workflow('runs-on:\n      group: datazup-public-builders\n      labels: coolify-cicd-codev'), 'example.yml'), []);
});

test('rejects a GitHub hosted runner', () => {
  assert.match(validateWorkflowSource(workflow('runs-on: ubuntu-latest'), 'example.yml').join('\n'), /test.*datazup-public-builders/);
});

test('rejects a dynamic runner selector', () => {
  assert.match(validateWorkflowSource(workflow('runs-on: ${{ vars.RUNNER }}'), 'example.yml').join('\n'), /test.*datazup-public-builders/);
});

test('rejects a reusable workflow job that can choose another runner', () => {
  const source = 'name: Example\non: push\njobs:\n  test:\n    uses: owner/repo/.github/workflows/other.yml@main\n';
  assert.match(validateWorkflowSource(source, 'example.yml').join('\n'), /test.*reusable/);
});

test('rejects malformed workflow YAML', () => {
  assert.match(validateWorkflowSource('name: Example\njobs: [', 'example.yml').join('\n'), /invalid YAML/);
});

test('rejects a workflow without jobs', () => {
  assert.match(validateWorkflowSource('name: Example\non: push', 'example.yml').join('\n'), /jobs/);
});
