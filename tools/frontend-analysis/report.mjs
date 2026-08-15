import fs from "node:fs";
import path from "node:path";
import { LATEST_DIR } from "./config.mjs";
import { ensureDirectory, escapeHtml, formatBytes, writeJson } from "./utils.mjs";

export function writeReports(input, outputDirectory = LATEST_DIR) {
  ensureDirectory(outputDirectory);
  const recommendations = buildRecommendations(input);
  const failedStages = input.stages.filter((stage) => stage.status === "failed");
  const overallStatus = failedStages.length || input.comparison?.status === "failed" ? "failed" : "passed";
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    overallStatus,
    stages: input.stages,
    comparison: input.comparison ?? null,
    eslint: input.eslint?.totals ?? null,
    source: input.source?.totals ?? null,
    bundle: input.bundle ? {
      totals: input.bundle.totals,
      initial: input.bundle.initial,
      warnings: input.bundle.warnings.length,
    } : null,
    runtime: input.runtime ? {
      longTasks: input.runtime.longTasks,
      groups: input.runtime.groups,
      warnings: input.runtime.warnings,
    } : null,
    recommendations,
  };
  writeJson(path.join(outputDirectory, "summary.json"), summary);
  fs.writeFileSync(path.join(outputDirectory, "report.html"), renderHtml(input, summary), "utf8");
  return summary;
}

function buildRecommendations(input) {
  const recommendations = [];
  for (const stage of input.stages.filter((candidate) => candidate.status === "failed")) {
    recommendations.push({
      priority: "P0",
      area: "quality-gate",
      finding: `${stage.name} failed`,
      action: `Open ${stage.log ?? "the stage output"} and fix the root cause before performance optimization.`,
    });
  }
  if (input.comparison?.status === "failed") {
    for (const check of input.comparison.checks.filter((candidate) => candidate.status === "failed")) {
      recommendations.push({
        priority: "P0",
        area: "regression",
        finding: `${check.name} exceeded its baseline budget`,
        action: "Inspect the bundle/source delta, explain intentional growth, or reduce it before updating the baseline.",
      });
    }
  }
  if (input.source?.cycles.length) {
    recommendations.push({
      priority: "P1",
      area: "dependency-graph",
      finding: `${input.source.cycles.length} production import cycle(s) detected`,
      action: "Move shared contracts toward the dependency root; do not hide the cycle with another re-export.",
    });
  }
  if (input.eslint?.totals.findings) {
    recommendations.push({
      priority: "P1",
      area: "static-analysis-debt",
      finding: `${input.eslint.totals.findings} ESLint finding(s) remain in the reviewed debt baseline`,
      action: "Fix findings by root cause in focused changes; the baseline prevents new occurrences without hiding the existing locations.",
    });
  }
  if (input.source?.unreachableCandidates.length) {
    recommendations.push({
      priority: "P2",
      area: "dead-code-candidates",
      finding: `${input.source.unreachableCandidates.length} module(s) are unreachable from configured entrypoints`,
      action: "Verify dynamic/runtime entrypoints before removing anything; candidates are advisory, not deletion authorization.",
    });
  }
  if (input.source?.heavyImports.length) {
    const dependencies = [...new Set(input.source.heavyImports.map((item) => item.dependency))].join(", ");
    recommendations.push({
      priority: "P1",
      area: "loading-boundary",
      finding: `Heavy dependencies are statically imported: ${dependencies}`,
      action: "Use the treemap and initial-asset list to verify whether each dependency belongs on the startup path; lazy-load only proven non-critical surfaces.",
    });
  }
  if (input.source?.hotspots.largeFiles.length) {
    recommendations.push({
      priority: "P2",
      area: "maintainability-hotspot",
      finding: `${input.source.hotspots.largeFiles.length} file(s) exceed the line-count warning threshold`,
      action: "Use React and browser traces before splitting; extract responsibilities only where the profile or dependency graph identifies a seam.",
    });
  }
  if (input.bundle?.warnings.length) {
    recommendations.push({
      priority: "P1",
      area: "initial-bundle",
      finding: `${input.bundle.warnings.length} initial asset(s) exceed the compressed-size warning threshold`,
      action: "Inspect bundle-treemap.html, then prefer route/component boundaries over arbitrary manual chunk configuration.",
    });
  }
  if (input.runtime?.longTasks.count) {
    recommendations.push({
      priority: "P1",
      area: "main-thread",
      finding: `${input.runtime.longTasks.count} task(s) exceeded ${input.runtime.longTaskThresholdMilliseconds} ms`,
      action: "Inspect the slowest task around its timestamp, identify the owning user action, and move or batch the measured work.",
    });
  }
  if (!recommendations.length) {
    recommendations.push({
      priority: "P3",
      area: "baseline",
      finding: "No gate failure or configured threshold violation was detected",
      action: "Keep the current baseline and optimize only when a reproducible product scenario regresses.",
    });
  }
  return recommendations;
}

function renderHtml(input, summary) {
  const generatedAt = escapeHtml(summary.generatedAt);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>tinybot frontend analysis</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #101318; color: #e8edf4; }
    main { width: min(1180px, calc(100% - 40px)); margin: 0 auto; padding: 36px 0 72px; }
    h1, h2 { letter-spacing: -0.025em; }
    h1 { margin-bottom: 6px; }
    h2 { margin-top: 34px; }
    .muted { color: #9ba8b8; }
    .status { display: inline-flex; align-items: center; border-radius: 999px; padding: 5px 10px; font-weight: 700; text-transform: uppercase; }
    .passed { color: #7ee2a8; background: #163726; }
    .failed { color: #ff9c9c; background: #431f25; }
    .missing, .skipped { color: #ffd27d; background: #42351b; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .card { border: 1px solid #2b3441; background: #171c23; border-radius: 12px; padding: 16px; }
    .metric { font-size: 1.7rem; font-weight: 760; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #171c23; border: 1px solid #2b3441; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #2b3441; text-align: left; vertical-align: top; }
    th { color: #9ba8b8; font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; }
    code { color: #c9d8ff; }
    a { color: #8db8ff; }
    .priority { font-weight: 800; white-space: nowrap; }
    .P0 { color: #ff8e8e; } .P1 { color: #ffd27d; } .P2 { color: #91c8ff; } .P3 { color: #9ba8b8; }
    .scroll { overflow-x: auto; }
  </style>
</head>
<body>
<main>
  <h1>tinybot frontend analysis</h1>
  <p class="muted">Generated ${generatedAt} · <span class="status ${summary.overallStatus}">${summary.overallStatus}</span></p>
  ${renderOverview(input)}
  <h2>Optimization queue</h2>
  ${renderRecommendations(summary.recommendations)}
  <h2>Quality gates</h2>
  ${renderStages(input.stages)}
  ${renderBaseline(input.comparison)}
  ${renderEslint(input.eslint)}
  ${renderSource(input.source)}
  ${renderBundle(input.bundle)}
  ${renderRuntime(input.runtime)}
</main>
</body>
</html>`;
}

function renderOverview(input) {
  const metrics = [
    ["Production source", input.source ? `${input.source.totals.productionLines.toLocaleString()} lines` : "not run"],
    ["ESLint findings", input.eslint ? input.eslint.totals.findings : "not run"],
    ["Import cycles", input.source ? input.source.totals.cycles : "not run"],
    ["Initial gzip", input.bundle ? formatBytes(input.bundle.initial.gzipBytes) : "not run"],
    ["JavaScript gzip", input.bundle ? formatBytes(input.bundle.totalsByKind.javascript?.gzipBytes ?? 0) : "not run"],
    ["Long tasks", input.runtime ? input.runtime.longTasks.count : "trace not loaded"],
  ];
  return `<div class="grid">${metrics.map(([label, value]) => `<div class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${escapeHtml(value)}</div></div>`).join("")}</div>`;
}

function renderRecommendations(recommendations) {
  return table(["Priority", "Area", "Finding", "Next action"], recommendations.map((item) => [
    `<span class="priority ${escapeHtml(item.priority)}">${escapeHtml(item.priority)}</span>`,
    escapeHtml(item.area),
    escapeHtml(item.finding),
    escapeHtml(item.action),
  ]));
}

function renderStages(stages) {
  if (!stages.length) {
    return "<p class=\"muted\">No quality stages were run.</p>";
  }
  return table(["Stage", "Status", "Duration", "Log"], stages.map((stage) => [
    escapeHtml(stage.name),
    `<span class="status ${escapeHtml(stage.status)}">${escapeHtml(stage.status)}</span>`,
    `${(stage.durationMs / 1000).toFixed(2)} s`,
    stage.log ? `<a href="${escapeHtml(stage.log)}">${escapeHtml(stage.log)}</a>` : "—",
  ]));
}

function renderBaseline(comparison) {
  if (!comparison) {
    return "";
  }
  const rows = comparison.checks.map((check) => [
    escapeHtml(check.name),
    `<span class="status ${escapeHtml(check.status)}">${escapeHtml(check.status)}</span>`,
    check.unit === "bytes" ? formatBytes(check.baseline) : escapeHtml(check.baseline),
    check.unit === "bytes" ? formatBytes(check.current) : escapeHtml(check.current),
    Number.isFinite(check.changePercent) ? `${check.changePercent.toFixed(2)}%` : "—",
  ]);
  return `<h2>Baseline budgets</h2>${rows.length ? table(["Check", "Status", "Baseline", "Current", "Change"], rows) : `<p class="muted">${escapeHtml(comparison.message ?? "No baseline checks were available.")}</p>`}`;
}

function renderSource(source) {
  if (!source) {
    return "";
  }
  const fileRows = source.hotspots.largeFiles.slice(0, 20).map((file) => [
    `<code>${escapeHtml(file.path)}</code>`,
    file.lines.toLocaleString(),
    file.branchPoints.toLocaleString(),
    file.fanIn,
    file.fanOut,
    file.useEffectCalls + file.useLayoutEffectCalls,
  ]);
  const cycleRows = source.cycles.map((cycle) => [cycle.map((file) => `<code>${escapeHtml(file)}</code>`).join(" → ")]);
  return `<h2>Source structure</h2>
    <p class="muted">Large files and branch counts are investigation signals, not automatic refactoring instructions.</p>
    ${fileRows.length ? table(["File", "Lines", "Branch points", "Fan-in", "Fan-out", "Effects"], fileRows) : "<p>No file-size hotspots.</p>"}
    ${cycleRows.length ? `<h3>Import cycles</h3>${table(["Strongly connected modules"], cycleRows)}` : ""}`;
}

function renderEslint(eslint) {
  if (!eslint) {
    return "";
  }
  const rows = eslint.findings.slice(0, 100).map((finding) => [
    `<code>${escapeHtml(finding.file)}:${escapeHtml(finding.line ?? "?")}</code>`,
    escapeHtml(finding.severity),
    `<code>${escapeHtml(finding.ruleId)}</code>`,
    escapeHtml(finding.message),
  ]);
  return `<h2>ESLint findings</h2>
    <p class="muted">All findings remain visible. The reviewed baseline blocks new fingerprints while existing debt is paid down.</p>
    ${rows.length ? table(["Location", "Severity", "Rule", "Message"], rows) : "<p>No ESLint findings.</p>"}`;
}

function renderBundle(bundle) {
  if (!bundle) {
    return "";
  }
  const rows = bundle.files.slice(0, 30).map((file) => [
    `<code>${escapeHtml(file.path)}</code>`,
    escapeHtml(file.kind),
    formatBytes(file.rawBytes),
    formatBytes(file.gzipBytes),
    formatBytes(file.brotliBytes),
  ]);
  return `<h2>Bundle</h2>
    <p><a href="bundle-treemap.html">Open interactive bundle treemap</a></p>
    ${table(["Largest files", "Kind", "Raw", "Gzip", "Brotli"], rows)}`;
}

function renderRuntime(runtime) {
  if (!runtime) {
    return `<h2>Runtime trace</h2><p class="muted">Not loaded. Export a Chrome/WebView2 Performance trace and run the trace command documented in the toolkit README.</p>`;
  }
  const groupRows = Object.entries(runtime.groups).map(([name, metrics]) => [
    escapeHtml(name),
    metrics.events,
    `${metrics.totalMilliseconds.toFixed(2)} ms`,
    `${metrics.maximumMilliseconds.toFixed(2)} ms`,
  ]);
  const taskRows = runtime.longTasks.top.map((task) => [
    escapeHtml(task.name),
    `${task.durationMilliseconds.toFixed(2)} ms`,
    escapeHtml(task.timestampMicroseconds),
  ]);
  return `<h2>Runtime trace</h2>
    ${table(["Group", "Events", "Total", "Maximum"], groupRows)}
    ${taskRows.length ? `<h3>Longest tasks</h3>${table(["Event", "Duration", "Timestamp (µs)"], taskRows)}` : "<p>No supported long tasks exceeded the threshold.</p>"}`;
}

function table(headers, rows) {
  return `<div class="scroll"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
