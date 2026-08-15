import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { analysisConfig, DIST_DIR, ROOT_DIR } from "./config.mjs";
import { percentChange, round, toRepoPath, walkFiles } from "./utils.mjs";

export function analyzeBundle(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? ROOT_DIR);
  const distDir = path.resolve(options.distDir ?? DIST_DIR);
  const config = options.config ?? analysisConfig.bundle;
  if (!fs.existsSync(distDir)) {
    throw new Error(`Bundle directory does not exist: ${distDir}`);
  }

  const files = walkFiles(distDir)
    .filter((file) => !file.endsWith(".map"))
    .map((file) => measureFile(rootDir, distDir, file))
    .sort((left, right) => right.gzipBytes - left.gzipBytes || left.path.localeCompare(right.path));
  const fileMap = new Map(files.map((file) => [file.distPath, file]));
  const initialPaths = findInitialAssets(distDir, fileMap);
  const initialFiles = files.filter((file) => initialPaths.has(file.distPath));
  const totalsByKind = Object.fromEntries(
    [...new Set(files.map((file) => file.kind))]
      .sort()
      .map((kind) => [kind, measureTotals(files.filter((file) => file.kind === kind))]),
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    distDirectory: toRepoPath(rootDir, distDir),
    totals: measureTotals(files),
    initial: measureTotals(initialFiles),
    totalsByKind,
    warnings: initialFiles
      .filter((file) => file.gzipBytes >= config.largeInitialAssetWarningGzipBytes)
      .map((file) => ({
        code: "large-initial-asset",
        file: file.path,
        gzipBytes: file.gzipBytes,
        thresholdBytes: config.largeInitialAssetWarningGzipBytes,
      })),
    initialFiles: initialFiles.map(publicFileRecord),
    files: files.map(publicFileRecord),
  };
}

export function createBaseline(sourceReport, bundleReport, eslintReport) {
  if (!sourceReport || !bundleReport || !eslintReport) {
    throw new Error("Source, bundle, and ESLint reports are required to create a baseline.");
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      cycles: sourceReport.cycles,
    },
    eslint: {
      findings: eslintReport.fingerprints,
    },
    bundle: {
      initialGzipBytes: bundleReport.initial.gzipBytes,
      javascriptGzipBytes: bundleReport.totalsByKind.javascript?.gzipBytes ?? 0,
      totalGzipBytes: bundleReport.totals.gzipBytes,
    },
  };
}

export function compareBaseline(sourceReport, bundleReport, eslintComparison, baseline, config = analysisConfig) {
  if (!baseline) {
    return {
      status: "missing",
      checks: [],
      message: "No baseline exists. Run npm run analyze:frontend:baseline after reviewing the first report.",
    };
  }
  if (baseline.schemaVersion !== 1) {
    throw new Error(`Unsupported frontend analysis baseline schema: ${baseline.schemaVersion}`);
  }
  const checks = [];
  if (eslintComparison) {
    checks.push({
      name: "eslint-findings",
      status: eslintComparison.status,
      current: eslintComparison.currentFindings,
      baseline: eslintComparison.baselineFindings,
      unit: "count",
      added: eslintComparison.added,
      resolved: eslintComparison.resolved,
    });
  }
  if (sourceReport) {
    checks.push(setRegressionCheck({
      name: "source-cycles",
      currentValues: sourceReport.cycles.map(cycleFingerprint),
      baselineValues: (baseline.source.cycles ?? []).map(cycleFingerprint),
      unit: "count",
    }));
  }
  if (bundleReport) {
    checks.push(regressionCheck({
      name: "initial-gzip",
      current: bundleReport.initial.gzipBytes,
      baseline: baseline.bundle.initialGzipBytes,
      allowedPercent: config.bundle.maxInitialGzipRegressionPercent,
      unit: "bytes",
    }));
    checks.push(regressionCheck({
      name: "javascript-gzip",
      current: bundleReport.totalsByKind.javascript?.gzipBytes ?? 0,
      baseline: baseline.bundle.javascriptGzipBytes,
      allowedPercent: config.bundle.maxJavaScriptGzipRegressionPercent,
      unit: "bytes",
    }));
  }
  return {
    status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
    checks,
  };
}

function measureFile(rootDir, distDir, file) {
  const contents = fs.readFileSync(file);
  const distPath = toRepoPath(distDir, file);
  return {
    path: toRepoPath(rootDir, file),
    distPath,
    kind: fileKind(file),
    rawBytes: contents.byteLength,
    gzipBytes: zlib.gzipSync(contents, { level: 9 }).byteLength,
    brotliBytes: zlib.brotliCompressSync(contents).byteLength,
  };
}

function publicFileRecord(file) {
  return {
    path: file.path,
    kind: file.kind,
    rawBytes: file.rawBytes,
    gzipBytes: file.gzipBytes,
    brotliBytes: file.brotliBytes,
  };
}

function measureTotals(files) {
  return {
    files: files.length,
    rawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
    gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
    brotliBytes: files.reduce((total, file) => total + file.brotliBytes, 0),
  };
}

function fileKind(file) {
  const extension = path.extname(file).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return "javascript";
  }
  if (extension === ".css") {
    return "css";
  }
  if (extension === ".html") {
    return "html";
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico"].includes(extension)) {
    return "image";
  }
  if ([".woff", ".woff2", ".ttf", ".otf"].includes(extension)) {
    return "font";
  }
  return "other";
}

function findInitialAssets(distDir, fileMap) {
  const initial = new Set();
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    return initial;
  }
  initial.add("index.html");
  const html = fs.readFileSync(indexPath, "utf8");
  const references = [...html.matchAll(/(?:src|href)=["']([^"'#?]+)["']/g)]
    .map((match) => normalizeReference(match[1], "index.html"))
    .filter(Boolean);
  const pending = [...references];
  while (pending.length) {
    const current = pending.pop();
    if (!current || initial.has(current) || !fileMap.has(current)) {
      continue;
    }
    initial.add(current);
    if (!current.endsWith(".js")) {
      continue;
    }
    const source = fs.readFileSync(path.join(distDir, current), "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*)["']([^"']+\.js)["']/g)) {
      const dependency = normalizeReference(match[1], current);
      if (dependency && !initial.has(dependency)) {
        pending.push(dependency);
      }
    }
  }
  return initial;
}

function normalizeReference(reference, importer) {
  if (/^(?:https?:|data:|#)/i.test(reference)) {
    return null;
  }
  const normalized = reference.startsWith("/")
    ? reference.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(importer), reference));
  return normalized.replace(/^\.\//, "");
}

function regressionCheck({ name, current, baseline, allowedPercent, unit }) {
  const changePercent = percentChange(current, baseline);
  return {
    name,
    status: changePercent > allowedPercent ? "failed" : "passed",
    current,
    baseline,
    changePercent: round(changePercent),
    allowedPercent,
    unit,
  };
}

function setRegressionCheck({ name, currentValues, baselineValues, unit }) {
  const current = new Set(currentValues);
  const baseline = new Set(baselineValues);
  const added = [...current].filter((value) => !baseline.has(value)).sort();
  const resolved = [...baseline].filter((value) => !current.has(value)).sort();
  return {
    name,
    status: added.length ? "failed" : "passed",
    current: current.size,
    baseline: baseline.size,
    added,
    resolved,
    unit,
  };
}

function cycleFingerprint(cycle) {
  return [...cycle].sort().join(" -> ");
}
