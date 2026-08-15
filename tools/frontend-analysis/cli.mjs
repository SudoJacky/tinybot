#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ANALYSIS_DIR,
  BASELINE_FILE,
  DIST_DIR,
  LATEST_DIR,
  ROOT_DIR,
} from "./config.mjs";
import { analyzeSource } from "./source-analysis.mjs";
import { analyzeBundle, compareBaseline, createBaseline } from "./bundle-analysis.mjs";
import { analyzeEslint, compareEslintFindings } from "./eslint-analysis.mjs";
import { analyzeTraceFile } from "./trace-analysis.mjs";
import { writeReports } from "./report.mjs";
import {
  ensureDirectory,
  readJsonIfExists,
  resetDirectory,
  writeJson,
} from "./utils.mjs";

const command = process.argv[2] ?? "full";
const commandArguments = process.argv.slice(3);
const supportedCommands = new Set(["full", "ci", "static", "lint", "source", "bundle", "baseline", "trace", "help"]);

if (!supportedCommands.has(command)) {
  console.error(`Unknown frontend analysis command: ${command}`);
  printHelp();
  process.exitCode = 2;
} else if (command === "help") {
  printHelp();
} else {
  assertSupportedNode();
  await execute(command, commandArguments);
}

async function execute(selectedCommand, args) {
  if (selectedCommand === "trace") {
    await runTrace(args);
    return;
  }

  resetDirectory(LATEST_DIR, ANALYSIS_DIR);
  ensureDirectory(path.join(LATEST_DIR, "logs"));
  const stages = [];
  let source = null;
  let bundle = null;
  let eslintReport = null;
  const runQuality = ["full", "ci", "static", "baseline"].includes(selectedCommand);
  const runTestsAndBuild = ["full", "ci", "baseline"].includes(selectedCommand);
  const runSource = runQuality || selectedCommand === "source";
  const runBundle = runTestsAndBuild || selectedCommand === "bundle";

  if (runQuality) {
    stages.push(await runNodeStage("tooling-tests", ["--test", "tools/frontend-analysis/analysis.test.mjs"], "tooling-tests.log"));
    stages.push(await runNodeStage("typecheck", [localBinary("typescript/bin/tsc"), "--noEmit"], "typecheck.log"));
  }

  if (runQuality || selectedCommand === "lint") {
    stages.push(await runAsyncInternalStage("eslint-analysis", async () => {
      eslintReport = await analyzeEslint();
      writeJson(path.join(LATEST_DIR, "eslint.json"), eslintReport);
    }));
  }

  if (runSource) {
    const result = runInternalStage("source-analysis", () => {
      source = analyzeSource();
      writeJson(path.join(LATEST_DIR, "source.json"), source);
    });
    stages.push(result);
  }

  if (runTestsAndBuild) {
    stages.push(await runNodeStage("vitest", [localBinary("vitest/vitest.mjs"), "run"], "vitest.log"));
  }

  if (runBundle) {
    stages.push(await runNodeStage("vite-build", [localBinary("vite/bin/vite.js"), "build"], "vite-build.log", {
      TINYBOT_ANALYZE_FRONTEND: "1",
    }));
    const result = runInternalStage("bundle-analysis", () => {
      bundle = analyzeBundle({ distDir: DIST_DIR });
      writeJson(path.join(LATEST_DIR, "bundle.json"), bundle);
    }, stages.at(-1).status === "passed");
    stages.push(result);
  }

  let comparison = null;
  if (selectedCommand !== "baseline") {
    const baseline = readJsonIfExists(BASELINE_FILE);
    const eslintComparison = eslintReport && baseline
      ? compareEslintFindings(eslintReport, baseline.eslint?.findings ?? [])
      : null;
    comparison = compareBaseline(source, bundle, eslintComparison, baseline);
    writeJson(path.join(LATEST_DIR, "baseline-comparison.json"), comparison);
    if (comparison.status === "failed" || (selectedCommand === "ci" && comparison.status === "missing")) {
      stages.push({
        name: "baseline-budgets",
        status: "failed",
        durationMs: 0,
        log: "baseline-comparison.json",
      });
    }
  }

  writeJson(path.join(LATEST_DIR, "stages.json"), stages);
  const summary = writeReports({ stages, eslint: eslintReport, source, bundle, runtime: null, comparison });

  if (selectedCommand === "baseline") {
    if (stages.some((stage) => stage.status === "failed") || !source || !bundle) {
      console.error("Baseline was not updated because one or more analysis stages failed.");
      process.exitCode = 1;
    } else if (!eslintReport) {
      console.error("Baseline was not updated because the ESLint report is missing.");
      process.exitCode = 1;
    } else {
      writeJson(BASELINE_FILE, createBaseline(source, bundle, eslintReport));
      console.log(`Frontend analysis baseline updated: ${path.relative(ROOT_DIR, BASELINE_FILE)}`);
    }
  } else if (summary.overallStatus === "failed") {
    process.exitCode = 1;
  }

  printResult(summary);
}

async function runTrace(args) {
  const input = args[0];
  if (!input) {
    console.error("Trace analysis requires a Chrome/WebView2 Performance JSON file.");
    console.error('Example: npm run analyze:frontend:trace -- "C:\\traces\\chat-streaming.json"');
    process.exitCode = 2;
    return;
  }
  const inputFile = path.resolve(ROOT_DIR, input);
  if (!fs.existsSync(inputFile)) {
    console.error(`Trace file does not exist: ${inputFile}`);
    process.exitCode = 2;
    return;
  }
  ensureDirectory(LATEST_DIR);
  const runtime = analyzeTraceFile(inputFile);
  writeJson(path.join(LATEST_DIR, "runtime.json"), runtime);
  const stages = readJsonIfExists(path.join(LATEST_DIR, "stages.json")) ?? [];
  stages.push({ name: "runtime-trace", status: "passed", durationMs: 0, log: "runtime.json" });
  writeJson(path.join(LATEST_DIR, "stages.json"), stages);
  const summary = writeReports({
    stages,
    source: readJsonIfExists(path.join(LATEST_DIR, "source.json")),
    bundle: readJsonIfExists(path.join(LATEST_DIR, "bundle.json")),
    eslint: readJsonIfExists(path.join(LATEST_DIR, "eslint.json")),
    runtime,
    comparison: readJsonIfExists(path.join(LATEST_DIR, "baseline-comparison.json")),
  });
  printResult(summary);
}

function runInternalStage(name, action, enabled = true) {
  if (!enabled) {
    return { name, status: "skipped", durationMs: 0, log: null };
  }
  const startedAt = performance.now();
  try {
    action();
    const durationMs = Math.round(performance.now() - startedAt);
    console.log(`[frontend-analysis] ${name} passed in ${durationMs} ms`);
    return { name, status: "passed", durationMs, log: null };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    console.error(`[frontend-analysis] ${name} failed:`, error);
    return { name, status: "failed", durationMs, log: null };
  }
}

async function runAsyncInternalStage(name, action) {
  const startedAt = performance.now();
  try {
    await action();
    const durationMs = Math.round(performance.now() - startedAt);
    console.log(`[frontend-analysis] ${name} passed in ${durationMs} ms`);
    return { name, status: "passed", durationMs, log: null };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    console.error(`[frontend-analysis] ${name} failed:`, error);
    return { name, status: "failed", durationMs, log: null };
  }
}

function runNodeStage(name, args, logName, extraEnvironment = {}) {
  const logFile = path.join(LATEST_DIR, "logs", logName);
  ensureDirectory(path.dirname(logFile));
  const log = fs.createWriteStream(logFile, { encoding: "utf8" });
  const startedAt = performance.now();
  console.log(`\n[frontend-analysis] starting ${name}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, ...extraEnvironment, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.on("error", (error) => {
      log.end(`\n${error.stack ?? error.message}\n`);
      resolve({
        name,
        status: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        log: `logs/${logName}`,
      });
    });
    child.on("close", (code) => {
      log.end();
      const durationMs = Math.round(performance.now() - startedAt);
      const status = code === 0 ? "passed" : "failed";
      console.log(`[frontend-analysis] ${name} ${status} in ${durationMs} ms`);
      resolve({ name, status, durationMs, log: `logs/${logName}` });
    });
  });
}

function localBinary(relativePath) {
  const binary = path.join(ROOT_DIR, "node_modules", ...relativePath.split("/"));
  if (!fs.existsSync(binary)) {
    throw new Error(`Missing local analysis dependency: ${binary}. Run npm ci or npm install first.`);
  }
  return binary;
}

function assertSupportedNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major < 22) {
    throw new Error(`Frontend analysis requires Node.js 22 or newer; current version is ${process.versions.node}.`);
  }
}

function printResult(summary) {
  console.log(`\n[frontend-analysis] overall status: ${summary.overallStatus}`);
  console.log(`[frontend-analysis] HTML report: ${path.relative(ROOT_DIR, path.join(LATEST_DIR, "report.html"))}`);
  console.log(`[frontend-analysis] JSON summary: ${path.relative(ROOT_DIR, path.join(LATEST_DIR, "summary.json"))}`);
}

function printHelp() {
  console.log(`tinybot frontend analysis

Commands:
  full      Run all quality, source, test, build, bundle, and budget stages.
  ci        Run the full gate and require a checked-in baseline.
  static    Run tooling tests, typecheck, ESLint, and source analysis.
  lint      Run ESLint and compare findings against the reviewed debt baseline.
  source    Run the TypeScript source/dependency analysis only.
  bundle    Build and analyze production assets only.
  baseline  Run the full gate and replace the checked-in baseline on success.
  trace     Analyze an exported Chrome/WebView2 Performance JSON trace.
  help      Show this message.
`);
}
