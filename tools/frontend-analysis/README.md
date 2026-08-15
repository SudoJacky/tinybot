# Frontend analysis toolkit

This directory owns tinybot's repeatable frontend quality and performance analysis flow. It does not optimize product code automatically: it produces evidence, enforces reviewed baselines, and keeps every stage traceable.

## Commands

Run the complete local workflow:

```powershell
npm run analyze:frontend
```

Run narrower stages:

```powershell
npm run analyze:frontend:static
npm run analyze:frontend:source
npm run analyze:frontend:bundle
npm run test:frontend-analysis
```

After reviewing a legitimate new state, replace the versioned baseline:

```powershell
npm run analyze:frontend:baseline
```

The baseline command reruns every gate and refuses to write `baseline.json` when type checking, ESLint execution, tests, build, source analysis, or bundle analysis fails. It intentionally snapshots currently reviewed ESLint debt. Do not update the baseline merely to make a new lint, cycle, or size regression pass; explain intentional changes first.

## Reports

Generated files live under `tools/frontend-analysis/reports/latest/`:

- `report.html`: human-readable findings and optimization queue.
- `summary.json`: machine-readable overall result.
- `source.json`: source graph, cycles, unreachable candidates, branch/file hotspots, and heavy imports.
- `eslint.json`: every current lint finding with a stable debt fingerprint.
- `bundle.json`: raw, gzip, and Brotli sizes, including initial assets.
- `bundle-treemap.html`: interactive module treemap generated only during analysis builds.
- `baseline-comparison.json`: regression budget results.
- `logs/`: complete output for each quality gate.

The local `reports/` directory is ignored by this toolkit's own `.gitignore`. `baseline.json` is intentionally versioned.

## Runtime traces

Static and bundle reports cannot identify main-thread stalls. Capture the exact slow product scenario in the Tauri/WebView2 or Chrome Performance panel, export it as JSON, then run:

```powershell
npm run analyze:frontend:trace -- "C:\path\to\chat-streaming-trace.json"
```

The trace stage appends long-task, script, layout, paint, and User Timing evidence to the latest report. A useful trace should isolate one scenario, such as cold startup, opening a long session, 30 seconds of streaming Markdown, session switching, or Live Canvas interaction.

## Optimization loop

1. Run the full analysis and preserve the failing report.
2. Reproduce one user-visible scenario and capture a runtime trace when the problem is interactive.
3. Identify the owning module from the source graph, treemap, React Profiler, or trace timestamp.
4. Make one causal change: loading boundary, render-state boundary, work batching, virtualization, or moving measured CPU work off the main thread.
5. Rerun the same scenario and the complete analysis.
6. Accept the change only when the target metric improves and correctness gates remain green.

Large files, branch counts, heavy imports, and unreachable modules are advisory evidence. They are not authorization to refactor or delete code. Existing ESLint findings remain visible in the reviewed debt baseline; new findings, import-cycle regressions, and reviewed bundle baseline regressions are hard failures.

## CI behavior

`npm run analyze:frontend:ci` runs the full pipeline and additionally fails when `baseline.json` is missing. CI uploads `tools/frontend-analysis/reports/latest/` so failures retain their logs and reports.

The toolkit requires Node.js 22 or newer, matching the repository CI runtime.
