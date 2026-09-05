import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mib = (bytes) => Math.round(bytes / 1048576 * 100) / 100;
const round = (value) => Math.round(value * 10) / 10;

/** Analyze application snapshots separately from Chrome traceEvents. Durations overlap. */
export function analyzePerformanceTrace(trace) {
  if (trace?.schemaVersion !== "tinybot.performance_trace.v1") {
    throw new Error("Expected a tinybot.performance_trace.v1 snapshot");
  }
  if (!trace.metrics?.durations || !trace.memory || !Array.isArray(trace.recentEvents)) {
    throw new Error("Performance snapshot is missing metrics, memory or recentEvents");
  }
  const samples = [...(trace.memorySamples ?? []), trace.memory]
    .sort((left, right) => left.sampledAtUnixMs - right.sampledAtUnixMs)
    .filter((sample, index, all) => !index || sample.sampledAtUnixMs !== all[index - 1].sampledAtUnixMs);
  for (const sample of samples) {
    if (!Number.isFinite(sample.sampledAtUnixMs) ||
      (sample.totalPrivateBytes !== null && (!Number.isFinite(sample.totalPrivateBytes) || sample.totalPrivateBytes < 0))) {
      throw new Error("Invalid memory sample timestamp or private bytes");
    }
  }
  const available = samples.filter((sample) => sample.status === "available" && sample.totalPrivateBytes !== null);
  const first = available[0];
  const last = available.at(-1);
  const durationSeconds = first && last ? (last.sampledAtUnixMs - first.sampledAtUnixMs) / 1000 : 0;
  const processes = new Map();
  for (const sample of available) {
    for (const process of [sample.native, ...sample.webview2.processes].filter(Boolean)) {
      const row = processes.get(process.pid) ?? {
        pid: process.pid, kind: process.kind ?? "native", samples: 0,
        firstMiB: mib(process.privateBytes), lastMiB: 0, maxMiB: 0,
      };
      row.samples += 1;
      row.lastMiB = mib(process.privateBytes);
      row.maxMiB = Math.max(row.maxMiB, row.lastMiB);
      processes.set(process.pid, row);
    }
  }
  const renderer = trace.rendererPerformance;
  const rendererStart = renderer?.timeOriginUnixMs ?? trace.recentEvents
    .filter((event) => event.event === "startup.renderer.ready")
    .map((event) => event.timestampUnixMs - event.context?.details?.sinceStartMs)
    .find(Number.isFinite);
  const nativeStart = trace.metrics.gauges?.["desktop.process.startedAtUnixMs"] ?? trace.recentEvents
    .find((event) => event.stream === "runtime")?.timestampUnixMs;
  const warnings = [
    "Duration rows can be nested or concurrent; do not add them to estimate startup time.",
    "WebView2 webviewLabels identify shared environment queries, not exclusive renderer ownership.",
    "GPU process private bytes are not dedicated GPU memory; process working sets can include shared pages.",
  ];
  if (durationSeconds < 60) warnings.push("Memory observation is shorter than 60 seconds; it cannot establish a leak.");
  if (samples.length !== available.length) warnings.push("Partial/unsupported memory samples are excluded from aggregate comparisons.");
  if (new Set(available.map((sample) => sample.native?.pid)).size > 1) {
    throw new Error("Memory samples span multiple native processes; analyze each run separately");
  }
  if (Number.isFinite(rendererStart) && Number.isFinite(nativeStart) && rendererStart - nativeStart > 60_000) {
    warnings.push("Native and renderer startup records are over one minute apart; they do not describe one cold start.");
  }
  if (!renderer) warnings.push("Renderer resource, long-task, interaction and heap measurements are absent in this legacy snapshot.");
  if (renderer) {
    warnings.push("Interaction samples include slow event entries only (40 ms threshold); their maximum is not INP.");
    warnings.push("JS heap is a browser estimate, not total renderer memory. Resource observations may overlap in time.");
    for (const [type, support] of Object.entries(renderer.support)) {
      if (support !== "available") warnings.push(`Renderer ${type} collection is ${support}; missing samples do not mean zero work.`);
    }
  }
  return {
    schemaVersion: "tinybot.performance_analysis.v1",
    generatedAt: new Date().toISOString(),
    sourceGeneratedAtUnixMs: trace.generatedAtUnixMs,
    environment: trace.environment ?? null,
    clocks: {
      nativeStartedAtUnixMs: nativeStart ?? null, rendererStartedAtUnixMs: rendererStart ?? null,
      rendererInstanceId: renderer?.instanceId ?? null,
    },
    memory: {
      sampleCount: samples.length, completeSampleCount: available.length, durationSeconds,
      minPrivateMiB: first ? mib(Math.min(...available.map((sample) => sample.totalPrivateBytes))) : null,
      maxPrivateMiB: first ? mib(Math.max(...available.map((sample) => sample.totalPrivateBytes))) : null,
      firstPrivateMiB: first ? mib(first.totalPrivateBytes) : null,
      lastPrivateMiB: last ? mib(last.totalPrivateBytes) : null,
      deltaPrivateMiB: first && last ? mib(last.totalPrivateBytes - first.totalPrivateBytes) : null,
      webviewSharePercent: last?.totalPrivateBytes ? round(last.webview2.privateBytes / last.totalPrivateBytes * 100) : null,
      processes: [...processes.values()].sort((left, right) => right.maxMiB - left.maxMiB),
      windows: trace.memory.windows ?? null,
      collectionErrors: samples.flatMap((sample) => sample.collectionErrors),
    },
    durations: Object.entries(trace.metrics.durations)
      .map(([name, metric]) => ({ name, ...metric }))
      .sort((left, right) => right.maxMs - left.maxMs),
    nativeTimeline: trace.metrics.recentDurations ?? [],
    droppedNativeSamples: trace.metrics.droppedDurationSamples ?? null,
    renderer: renderer ? {
      surface: renderer.surface, sampledAtUnixMs: renderer.sampledAtUnixMs,
      support: renderer.support, errors: renderer.errors, navigation: renderer.navigation, jsHeap: renderer.jsHeap,
      streams: Object.fromEntries(Object.entries(renderer.streams).map(([name, stream]) => [name, {
        count: stream.count, totalDurationMs: round(stream.totalDurationMs),
        maxDurationMs: round(stream.maxDurationMs), droppedSamples: stream.droppedSamples,
        slowestRetainedSamples: [...stream.samples].sort((a, b) => b.duration - a.duration).slice(0, 15),
      }])),
    } : null,
    warnings,
  };
}

export function performanceAnalysisMarkdown(report) {
  const memory = report.memory;
  return [
    "# Tinybot performance analysis", "",
    `Memory: ${memory.completeSampleCount}/${memory.sampleCount} complete samples over ${memory.durationSeconds}s.`,
    `Private memory: ${memory.minPrivateMiB ?? "unavailable"}–${memory.maxPrivateMiB ?? "unavailable"} MiB; delta ${memory.deltaPrivateMiB ?? "unavailable"} MiB.`,
    `Native startup clock: ${report.clocks.nativeStartedAtUnixMs ?? "unavailable"}; renderer clock: ${report.clocks.rendererStartedAtUnixMs ?? "unavailable"} (Unix ms).`,
    `Native timing samples retained: ${report.nativeTimeline.length}; evicted: ${report.droppedNativeSamples ?? "unavailable"}.`,
    "", "## Processes", "", "| PID | Kind | First MiB | Last MiB | Peak sampled MiB |", "| --- | --- | ---: | ---: | ---: |",
    ...memory.processes.map((row) => `| ${row.pid} | ${row.kind} | ${row.firstMiB} | ${row.lastMiB} | ${row.maxMiB} |`),
    "", "## Recorded durations (overlap possible)", "", "| Phase | Count | Average ms | Max ms |", "| --- | ---: | ---: | ---: |",
    ...report.durations.map((row) => `| ${row.name} | ${row.count} | ${round(row.averageMs)} | ${row.maxMs} |`),
    "", "## Renderer observations", "",
    ...(report.renderer ? Object.entries(report.renderer.streams).map(([name, stream]) =>
      `- ${name}: ${stream.count} entries, max ${stream.maxDurationMs} ms, ${stream.droppedSamples} samples dropped.`) : ["Unavailable in this snapshot."]),
    "", "## Interpretation limits", "", ...report.warnings.map((warning) => `- ${warning}`), "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node tools/frontend-analysis/performance-analysis.mjs <snapshot.json> [output-directory]");
  const report = analyzePerformanceTrace(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
  const output = path.resolve(process.argv[3] ?? "output/frontend-analysis/performance");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "analysis.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(output, "analysis.md"), performanceAnalysisMarkdown(report));
  console.log(path.join(output, "analysis.md"));
}
