/**
 * Contract Test Reporter — formats compliance reports for humans, CI, and docs.
 */

import type { ComplianceReport, ContractTestReport } from './contract-types.js';

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

/**
 * Format a compliance report as a Markdown document suitable for docs or PRs.
 */
export function complianceToMarkdown(report: ComplianceReport): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${report.suiteName} Compliance Report`);
  lines.push('');
  lines.push(`**Adapter type:** ${report.adapterType}`);
  lines.push(`**Compliance level:** ${badgeText(report.complianceLevel)}`);
  lines.push(`**Compliance:** ${report.compliancePercent}%`);
  lines.push(`**Date:** ${report.timestamp}`);
  lines.push(`**Duration:** ${report.totalDuration.toFixed(0)}ms`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| ------ | ----- |`);
  lines.push(`| Total tests | ${report.summary.total} |`);
  lines.push(`| Passed | ${report.summary.passed} |`);
  lines.push(`| Failed | ${report.summary.failed} |`);
  lines.push(`| Skipped | ${report.summary.skipped} |`);
  lines.push('');

  // By category
  lines.push('## By Category');
  lines.push('');
  lines.push('| Category | Total | Passed | Failed |');
  lines.push('| -------- | ----- | ------ | ------ |');
  for (const category of ['required', 'recommended', 'optional'] as const) {
    const cat = report.byCategory[category];
    lines.push(`| ${category} | ${cat.total} | ${cat.passed} | ${cat.failed} |`);
  }
  lines.push('');

  // Test details
  lines.push('## Test Results');
  lines.push('');
  lines.push('| Status | Test | Category | Duration | Error |');
  lines.push('| ------ | ---- | -------- | -------- | ----- |');

  for (const test of report.tests) {
    const status = statusSymbol(test.status);
    const duration = test.status === 'skipped' ? '-' : `${test.duration.toFixed(0)}ms`;
    const error = test.error ? truncate(test.error, 60) : '';
    lines.push(`| ${status} | ${test.testName} | ${test.category} | ${duration} | ${error} |`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON report
// ---------------------------------------------------------------------------

/**
 * Format a compliance report as a JSON string for CI integration.
 */
export function complianceToJSON(report: ComplianceReport): string {
  const serializable = {
    suiteName: report.suiteName,
    adapterType: report.adapterType,
    timestamp: report.timestamp,
    totalDuration: report.totalDuration,
    summary: report.summary,
    byCategory: report.byCategory,
    compliancePercent: report.compliancePercent,
    complianceLevel: report.complianceLevel,
    tests: report.tests,
  };

  return JSON.stringify(serializable, null, 2);
}

// ---------------------------------------------------------------------------
// CI annotations
// ---------------------------------------------------------------------------

/**
 * Generate GitHub Actions annotation strings from a compliance report.
 */
export function complianceToCIAnnotations(report: ComplianceReport): string[] {
  const annotations: string[] = [];

  const failedTests = report.tests.filter((t) => t.status === 'failed');

  for (const test of failedTests) {
    const level = test.category === 'required' ? 'error' : 'warning';
    const msg = test.error ? `: ${test.error}` : '';
    annotations.push(
      `::${level}::Contract test "${test.testId}" (${test.category}) failed${msg}`,
    );
  }

  if (report.complianceLevel === 'none') {
    annotations.push(
      `::error::${report.suiteName}: No compliance — 0 required tests passed`,
    );
  } else if (report.complianceLevel === 'minimal') {
    annotations.push(
      `::warning::${report.suiteName}: Minimal compliance — some required tests failed`,
    );
  }

  return annotations;
}

// ---------------------------------------------------------------------------
// Badge text
// ---------------------------------------------------------------------------

/**
 * Return a human-readable badge string for a compliance level.
 */
export function complianceBadge(report: ComplianceReport): string {
  return `${report.suiteName}: ${badgeText(report.complianceLevel)} (${report.compliancePercent}%)`;
}

// ---------------------------------------------------------------------------
// Multi-report summary
// ---------------------------------------------------------------------------

/**
 * Generate a summary of multiple compliance reports.
 */
export function complianceSummary(reports: ComplianceReport[]): string {
  const lines: string[] = [];

  lines.push('# Contract Compliance Summary');
  lines.push('');
  lines.push('| Suite | Adapter | Level | Compliance | Passed | Failed |');
  lines.push('| ----- | ------- | ----- | ---------- | ------ | ------ |');

  for (const report of reports) {
    lines.push(
      `| ${report.suiteName} | ${report.adapterType} | ${badgeText(report.complianceLevel)} | ${report.compliancePercent}% | ${report.summary.passed} | ${report.summary.failed} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badgeText(level: string): string {
  switch (level) {
    case 'full':
      return 'FULL';
    case 'partial':
      return 'PARTIAL';
    case 'minimal':
      return 'MINIMAL';
    case 'none':
      return 'NONE';
    default:
      return level.toUpperCase();
  }
}

function statusSymbol(status: ContractTestReport['status']): string {
  switch (status) {
    case 'passed':
      return 'PASS';
    case 'failed':
      return 'FAIL';
    case 'skipped':
      return 'SKIP';
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
