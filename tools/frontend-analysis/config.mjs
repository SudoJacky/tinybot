import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(TOOL_DIR, "../..");
export const ANALYSIS_DIR = path.join(TOOL_DIR, "reports");
export const LATEST_DIR = path.join(ANALYSIS_DIR, "latest");
export const BASELINE_FILE = path.join(TOOL_DIR, "baseline.json");
export const DIST_DIR = path.join(ROOT_DIR, "dist");

export const analysisConfig = Object.freeze({
  source: {
    roots: ["src"],
    entrypoints: ["src/main.ts"],
    largeFileWarningLines: 800,
    branchWarningPoints: 120,
    heavyDependencies: [
      "echarts",
      "gsap",
      "highlight.js",
      "streamdown",
    ],
  },
  bundle: {
    maxInitialGzipRegressionPercent: 5,
    maxJavaScriptGzipRegressionPercent: 5,
    largeInitialAssetWarningGzipBytes: 150 * 1024,
  },
  trace: {
    longTaskMilliseconds: 50,
    topEventCount: 30,
  },
});
