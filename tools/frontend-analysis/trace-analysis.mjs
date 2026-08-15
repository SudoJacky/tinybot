import fs from "node:fs";
import { analysisConfig } from "./config.mjs";
import { round } from "./utils.mjs";

const MAIN_THREAD_NAMES = new Set(["CrRendererMain", "RendererMain"]);
const TASK_NAMES = ["RunTask", "ThreadControllerImpl::RunTask", "TaskQueueManager::ProcessTaskFromWorkQueue"];
const EVENT_GROUPS = {
  script: new Set(["EvaluateScript", "FunctionCall", "RunMicrotasks", "V8.Execute"]),
  styleAndLayout: new Set(["Layout", "UpdateLayoutTree", "RecalculateStyles"]),
  paintAndComposite: new Set(["Paint", "PrePaint", "CompositeLayers", "RasterTask"]),
};

export function analyzeTraceFile(file, options = {}) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  if (!Array.isArray(events)) {
    throw new Error("Unsupported trace format: expected an array or an object containing traceEvents.");
  }
  return analyzeTraceEvents(events, options);
}

export function analyzeTraceEvents(events, options = {}) {
  const config = options.config ?? analysisConfig.trace;
  const mainThreads = findMainThreads(events);
  const completeEvents = events.filter((event) =>
    event?.ph === "X"
    && Number.isFinite(event.dur)
    && (mainThreads.size === 0 || mainThreads.has(threadKey(event))),
  );
  const selectedTaskName = TASK_NAMES.find((name) => completeEvents.some((event) => event.name === name));
  const tasks = selectedTaskName ? completeEvents.filter((event) => event.name === selectedTaskName) : [];
  const thresholdMicroseconds = config.longTaskMilliseconds * 1000;
  const longTasks = tasks
    .filter((event) => event.dur >= thresholdMicroseconds)
    .sort((left, right) => right.dur - left.dur)
    .map(eventSummary);
  const userTimings = completeEvents
    .filter((event) => String(event.cat ?? "").includes("user_timing"))
    .sort((left, right) => right.dur - left.dur)
    .slice(0, config.topEventCount)
    .map(eventSummary);

  const groups = Object.fromEntries(Object.entries(EVENT_GROUPS).map(([group, names]) => {
    const matching = completeEvents.filter((event) => names.has(event.name));
    return [group, {
      events: matching.length,
      totalMilliseconds: round(matching.reduce((total, event) => total + event.dur, 0) / 1000),
      maximumMilliseconds: round(Math.max(0, ...matching.map((event) => event.dur)) / 1000),
    }];
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceEvents: events.length,
    mainThreadDetection: mainThreads.size ? "metadata" : "fallback-all-threads",
    mainThreads: [...mainThreads].sort(),
    taskEventName: selectedTaskName ?? null,
    longTaskThresholdMilliseconds: config.longTaskMilliseconds,
    longTasks: {
      count: longTasks.length,
      totalMilliseconds: round(longTasks.reduce((total, task) => total + task.durationMilliseconds, 0)),
      maximumMilliseconds: round(Math.max(0, ...longTasks.map((task) => task.durationMilliseconds))),
      top: longTasks.slice(0, config.topEventCount),
    },
    groups,
    userTimings,
    warnings: [
      ...(mainThreads.size ? [] : ["Renderer main-thread metadata was not found; events from all threads were analyzed."]),
      ...(selectedTaskName ? [] : ["No supported renderer task event was found; long-task counts are unavailable for this trace."]),
    ],
  };
}

function findMainThreads(events) {
  return new Set(events
    .filter((event) => event?.ph === "M" && event.name === "thread_name" && MAIN_THREAD_NAMES.has(event.args?.name))
    .map(threadKey));
}

function threadKey(event) {
  return `${event.pid}:${event.tid}`;
}

function eventSummary(event) {
  return {
    name: event.name,
    durationMilliseconds: round(event.dur / 1000),
    timestampMicroseconds: event.ts ?? null,
    processId: event.pid ?? null,
    threadId: event.tid ?? null,
  };
}
