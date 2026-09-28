import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

const RUNNER = { group: 'datazup-public-builders', labels: 'coolify-cicd-codev' };

export function validateWorkflowSource(source, filename) {
  const errors = [];
  let workflow;
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) throw document.errors[0];
    workflow = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return [`${filename}: invalid YAML: ${error.message}`];
  }

  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)
    || !workflow.jobs || typeof workflow.jobs !== 'object' || Array.isArray(workflow.jobs)
    || Object.keys(workflow.jobs).length === 0) {
    return [`${filename}: jobs must contain at least one job`];
  }

  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
      errors.push(`${filename}: ${name}: invalid job`);
    } else if ('uses' in job) {
      errors.push(`${filename}: ${name}: reusable workflow jobs can select another runner`);
    } else if (!job['runs-on'] || typeof job['runs-on'] !== 'object'
      || Array.isArray(job['runs-on'])
      || job['runs-on'].group !== RUNNER.group
      || job['runs-on'].labels !== RUNNER.labels
      || Object.keys(job['runs-on']).length !== 2) {
      errors.push(`${filename}: ${name}: runs-on must select ${RUNNER.group}/${RUNNER.labels}`);
    }
  }
  return errors;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

export function checkWorkflowRevision(ref = 'HEAD') {
  if (ref !== 'HEAD' && !/^[0-9a-f]{40,64}$/u.test(ref)) {
    throw new Error('ref must be HEAD or a full commit SHA');
  }
  const files = git('ls-tree', '-r', '--name-only', ref, '--', '.github/workflows')
    .trim().split('\n').filter(file => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file));
  if (files.length === 0) return ['No workflow YAML files found'];
  return files.flatMap(file => validateWorkflowSource(git('show', `${ref}:${file}`), file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length === 2 && args[0] !== '--ref') || args.length === 1) {
    console.error('Usage: node scripts/check-workflow-runners.mjs [--ref <full-sha>]');
    process.exitCode = 2;
  } else {
    try {
      const errors = checkWorkflowRevision(args[1] || 'HEAD');
      if (errors.length) {
        for (const error of errors) console.error(error);
        process.exitCode = 1;
      } else {
        console.log('All workflow jobs select datazup-public-builders/coolify-cicd-codev');
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2;
    }
  }
}
