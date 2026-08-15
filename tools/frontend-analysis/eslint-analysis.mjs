import path from "node:path";
import { ESLint } from "eslint";
import { ROOT_DIR } from "./config.mjs";
import { toRepoPath } from "./utils.mjs";

export async function analyzeEslint(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? ROOT_DIR);
  const eslint = new ESLint({
    cwd: rootDir,
    overrideConfigFile: path.join(rootDir, "tools", "frontend-analysis", "eslint.config.mjs"),
  });
  const results = await eslint.lintFiles(options.patterns ?? ["src/**/*.{ts,tsx}", "vite.config.ts"]);
  const findings = results.flatMap((result) => result.messages.map((message) => ({
    file: toRepoPath(rootDir, result.filePath),
    line: message.line ?? null,
    column: message.column ?? null,
    endLine: message.endLine ?? null,
    endColumn: message.endColumn ?? null,
    severity: message.severity === 2 ? "error" : "warning",
    ruleId: message.ruleId ?? "unknown",
    message: message.message,
    fingerprint: findingFingerprint(toRepoPath(rootDir, result.filePath), message),
  })));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    totals: {
      files: results.length,
      findings: findings.length,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      fixable: results.reduce((total, result) => total + result.fixableErrorCount + result.fixableWarningCount, 0),
    },
    fingerprints: fingerprintCounts(findings),
    findings,
  };
}

export function compareEslintFindings(report, baselineFingerprints = []) {
  const baseline = new Map(baselineFingerprints.map((entry) => [entry.fingerprint, entry.count]));
  const current = new Map(report.fingerprints.map((entry) => [entry.fingerprint, entry.count]));
  const added = difference(current, baseline);
  const resolved = difference(baseline, current);
  return {
    status: added.length ? "failed" : "passed",
    currentFindings: report.totals.findings,
    baselineFindings: baselineFingerprints.reduce((total, entry) => total + entry.count, 0),
    added,
    resolved,
  };
}

function findingFingerprint(file, message) {
  return `${file}|${message.ruleId ?? "unknown"}|${message.message}`;
}

function fingerprintCounts(findings) {
  const counts = new Map();
  for (const finding of findings) {
    counts.set(finding.fingerprint, (counts.get(finding.fingerprint) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([fingerprint, count]) => ({ fingerprint, count }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function difference(left, right) {
  const result = [];
  for (const [fingerprint, count] of left) {
    const differenceCount = count - (right.get(fingerprint) ?? 0);
    if (differenceCount > 0) {
      result.push({ fingerprint, count: differenceCount });
    }
  }
  return result.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}
