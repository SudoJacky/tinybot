import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeSource } from "./source-analysis.mjs";
import { analyzeBundle, compareBaseline, createBaseline } from "./bundle-analysis.mjs";
import { compareEslintFindings } from "./eslint-analysis.mjs";
import { analyzeTraceEvents } from "./trace-analysis.mjs";

test("source analysis reports cycles, unreachable modules, and heavy imports", (context) => {
  const rootDir = temporaryDirectory(context);
  writeFixture(rootDir, "src/main.ts", 'import "./a";\nimport "echarts/core";\n');
  writeFixture(rootDir, "src/a.ts", 'import "./b";\nexport const a = 1;\n');
  writeFixture(rootDir, "src/b.ts", 'import "./a";\nexport const b = 2;\n');
  writeFixture(rootDir, "src/orphan.ts", "export const orphan = true;\n");

  const report = analyzeSource({
    rootDir,
    config: {
      roots: ["src"],
      entrypoints: ["src/main.ts"],
      largeFileWarningLines: 2,
      branchWarningPoints: 1,
      heavyDependencies: ["echarts"],
    },
  });

  assert.equal(report.totals.cycles, 1);
  assert.deepEqual(report.cycles[0], ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(report.unreachableCandidates, ["src/orphan.ts"]);
  assert.deepEqual(report.heavyImports, [{ file: "src/main.ts", dependency: "echarts" }]);
});

test("bundle analysis follows initial static imports and enforces regression budgets", (context) => {
  const rootDir = temporaryDirectory(context);
  writeFixture(rootDir, "dist/index.html", '<script type="module" src="/assets/main-12345678.js"></script><link rel="stylesheet" href="/assets/main.css">');
  writeFixture(rootDir, "dist/assets/main-12345678.js", 'import "./shared-abcdefgh.js"; console.log("main");');
  writeFixture(rootDir, "dist/assets/shared-abcdefgh.js", 'console.log("shared");');
  writeFixture(rootDir, "dist/assets/lazy-abcdefgh.js", 'console.log("lazy");');
  writeFixture(rootDir, "dist/assets/main.css", "body { color: black; }");

  const source = {
    totals: { cycles: 0 },
    cycles: [],
  };
  const bundle = analyzeBundle({
    rootDir,
    distDir: path.join(rootDir, "dist"),
    config: { largeInitialAssetWarningGzipBytes: 1_000_000 },
  });
  assert.equal(bundle.initial.files, 4);
  assert.equal(bundle.files.length, 5);
  assert.ok(bundle.initialFiles.some((file) => file.path.endsWith("shared-abcdefgh.js")));
  assert.ok(!bundle.initialFiles.some((file) => file.path.endsWith("lazy-abcdefgh.js")));

  const baseline = createBaseline(source, bundle, { fingerprints: [] });
  baseline.bundle.initialGzipBytes = 1;
  const comparison = compareBaseline(source, bundle, null, baseline, {
    bundle: {
      maxInitialGzipRegressionPercent: 5,
      maxJavaScriptGzipRegressionPercent: 5,
    },
  });
  assert.equal(comparison.status, "failed");
  assert.equal(comparison.checks.find((check) => check.name === "initial-gzip")?.status, "failed");
});

test("trace analysis isolates renderer long tasks and timing groups", () => {
  const events = [
    { ph: "M", name: "thread_name", pid: 1, tid: 7, args: { name: "CrRendererMain" } },
    { ph: "X", name: "RunTask", pid: 1, tid: 7, ts: 10, dur: 75_000 },
    { ph: "X", name: "Layout", pid: 1, tid: 7, ts: 20, dur: 8_000 },
    { ph: "X", name: "RunTask", pid: 2, tid: 8, ts: 30, dur: 200_000 },
  ];
  const report = analyzeTraceEvents(events, {
    config: { longTaskMilliseconds: 50, topEventCount: 10 },
  });

  assert.equal(report.mainThreadDetection, "metadata");
  assert.equal(report.longTasks.count, 1);
  assert.equal(report.longTasks.maximumMilliseconds, 75);
  assert.equal(report.groups.styleAndLayout.totalMilliseconds, 8);
});

test("ESLint debt comparison fails only for findings beyond the reviewed baseline", () => {
  const report = {
    totals: { findings: 3 },
    fingerprints: [
      { fingerprint: "src/a.ts|rule-a|message-a", count: 2 },
      { fingerprint: "src/b.ts|rule-b|message-b", count: 1 },
    ],
  };
  const comparison = compareEslintFindings(report, [
    { fingerprint: "src/a.ts|rule-a|message-a", count: 2 },
    { fingerprint: "src/old.ts|rule-old|message-old", count: 1 },
  ]);

  assert.equal(comparison.status, "failed");
  assert.deepEqual(comparison.added, [{ fingerprint: "src/b.ts|rule-b|message-b", count: 1 }]);
  assert.deepEqual(comparison.resolved, [{ fingerprint: "src/old.ts|rule-old|message-old", count: 1 }]);
});

function temporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tinybot-frontend-analysis-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFixture(rootDir, relativePath, contents) {
  const file = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}
