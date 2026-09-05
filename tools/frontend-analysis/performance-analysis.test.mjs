import assert from "node:assert/strict";
import test from "node:test";
import { analyzePerformanceTrace, performanceAnalysisMarkdown } from "./performance-analysis.mjs";

function sample(time, bytes, status = "available") {
  return { sampledAtUnixMs: time, status, native: { pid: 1, privateBytes: 1048576 },
    totalPrivateBytes: bytes, webview2: { privateBytes: bytes - 1048576, processes: [] }, collectionErrors: [] };
}
function trace() {
  return { schemaVersion: "tinybot.performance_trace.v1", generatedAtUnixMs: 110000,
    metrics: { durations: {}, gauges: { "desktop.process.startedAtUnixMs": 1000 } },
    memory: sample(110000, 10485760),
    memorySamples: [sample(100000, 11534336), sample(110000, 10485760)],
    recentEvents: [{ event: "startup.renderer.ready", timestampUnixMs: 100000, context: { details: { sinceStartMs: 500 } } }],
  };
}

test("legacy snapshots preserve clock separation, deduplicate last memory sample and avoid leak claims", () => {
  const report = analyzePerformanceTrace(trace());
  assert.equal(report.memory.sampleCount, 2);
  assert.equal(report.memory.durationSeconds, 10);
  assert.equal(report.memory.deltaPrivateMiB, -1);
  assert.equal(report.clocks.rendererStartedAtUnixMs, 99500);
  assert.ok(report.warnings.some((warning) => warning.includes("one cold start")));
  assert.ok(report.warnings.some((warning) => warning.includes("cannot establish a leak")));
  assert.match(performanceAnalysisMarkdown(report), /10–11 MiB/);
});

test("partial memory and unsupported observers remain unavailable rather than looking healthy", () => {
  const source = trace();
  source.memory = sample(120000, null, "unsupported");
  source.memorySamples = [];
  source.rendererPerformance = { support: { longtask: "unsupported" }, streams: {}, errors: [] };
  const report = analyzePerformanceTrace(source);
  assert.equal(report.memory.completeSampleCount, 0);
  assert.equal(report.memory.lastPrivateMiB, null);
  assert.ok(report.warnings.some((warning) => warning.includes("missing samples do not mean zero work")));
});

test("invalid files and mixed process lifetimes fail visibly", () => {
  assert.throws(() => analyzePerformanceTrace({}), /Expected/);
  const source = trace();
  source.memory.native.pid = 2;
  source.memory.sampledAtUnixMs += 1;
  assert.throws(() => analyzePerformanceTrace(source), /multiple native processes/);
});
