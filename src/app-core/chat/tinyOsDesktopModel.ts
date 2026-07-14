import type { BackendAgentTurnItem, ChatStep, ChatStepStatus } from "./chatRunModel";
import { projectTinyOsKernel, type TinyOsKernelSnapshot } from "./tinyOsKernelModel";

export type TinyOsAppId =
  | "files"
  | "terminal"
  | "browser"
  | "plan"
  | "memory"
  | "subagents"
  | "artifacts"
  | "inspector"
  | "system_monitor";

export type TinyOsTimelineEntry = {
  step: ChatStep;
  turnId: string;
};

export type TinyOsCursor = {
  itemId?: string;
  mode: "live_follow" | "history";
  turnId?: string;
};

export type TinyOsWindow = {
  appId: TinyOsAppId;
  entries: TinyOsTimelineEntry[];
  id: string;
  sourceItemIds: string[];
  title: string;
};

export type TinyOsOperation = {
  appId: TinyOsAppId;
  entry: TinyOsTimelineEntry;
  id: string;
  status: ChatStepStatus;
  title: string;
};

export type TinyOsNotification = {
  entry: TinyOsTimelineEntry;
  id: string;
  kind: "completed" | "error" | "cancelled";
  message: string;
  title: string;
};

export type TinyOsDialog = {
  entry: TinyOsTimelineEntry;
  id: string;
  kind: "approval" | "form";
};

export type TinyOsDesktopSnapshot = {
  activeAppId?: TinyOsAppId;
  agentTitle?: string;
  cursorItemId?: string;
  cursorTurnId?: string;
  dialog?: TinyOsDialog;
  kernel?: TinyOsKernelSnapshot;
  notifications: TinyOsNotification[];
  operations: TinyOsOperation[];
  truth: "structured";
  windows: TinyOsWindow[];
};

export const TINYOS_PRE_KERNEL_APP_IDS = [
  "files",
  "terminal",
  "browser",
  "plan",
  "memory",
  "subagents",
  "artifacts",
  "inspector",
] as const satisfies readonly TinyOsAppId[];

export const TINYOS_APP_IDS = [
  ...TINYOS_PRE_KERNEL_APP_IDS,
  "system_monitor",
] as const satisfies readonly TinyOsAppId[];

const APP_TITLES: Record<TinyOsAppId, string> = {
  artifacts: "Artifacts",
  browser: "Browser",
  files: "Files",
  inspector: "Inspector",
  memory: "Memory",
  plan: "Plan",
  subagents: "Subagents",
  system_monitor: "System Monitor",
  terminal: "Terminal",
};

const TERMINAL_TOOL_RE = /(?:^|[\s._-])(shell|terminal|command|exec|process|powershell|bash)(?:$|[\s._-])/i;
const BROWSER_TOOL_RE = /(?:^|[\s._-])(browser|web|navigate|screenshot|page)(?:$|[\s._-])/i;
const MEMORY_TOOL_RE = /(?:^|[\s._-])(memory|knowledge|recall)(?:$|[\s._-])/i;
const PLAN_TOOL_RE = /(?:^|[\s._-])(plan|update_plan|task_progress)(?:$|[\s._-])/i;
const FILE_TOOL_RE = /(?:^|[\s._-])(file|workspace|path|directory|search|grep|glob|read|write|patch)(?:$|[\s._-])/i;

export function projectTinyOsDesktop(
  entries: readonly TinyOsTimelineEntry[],
  cursor: TinyOsCursor,
  kernel?: TinyOsKernelSnapshot,
): TinyOsDesktopSnapshot {
  const visibleEntries = entries.slice(0, replayEndIndex(entries, cursor));
  const appEntries = new Map<TinyOsAppId, TinyOsTimelineEntry[]>();
  const appByStepId = new Map<string, TinyOsAppId>();
  const routedEntries: Array<{ appId: TinyOsAppId; entry: TinyOsTimelineEntry }> = [];

  for (const entry of visibleEntries) {
    const appId = appForStep(entry.step, appByStepId);
    if (!appId) continue;
    appByStepId.set(entry.step.id, appId);
    const grouped = appEntries.get(appId) ?? [];
    grouped.push(entry);
    appEntries.set(appId, grouped);
    routedEntries.push({ appId, entry });
  }

  const windows = TINYOS_APP_IDS.flatMap((appId): TinyOsWindow[] => {
    const grouped = appEntries.get(appId);
    if (!grouped?.length) return [];
    return [{
      appId,
      entries: grouped,
      id: `tinyos-window-${appId}`,
      sourceItemIds: grouped.map(({ step }) => step.id),
      title: APP_TITLES[appId],
    }];
  });
  const latest = routedEntries[routedEntries.length - 1];
  const latestEntry = latest?.entry;

  return {
    ...(latest ? { activeAppId: latest.appId } : {}),
    ...(latestEntry ? {
      agentTitle: latestEntry.step.agentContext.title,
      cursorItemId: latestEntry.step.id,
      cursorTurnId: latestEntry.turnId,
    } : {}),
    ...dialogFromEntries(visibleEntries),
    ...(kernel ? { kernel } : {}),
    notifications: notificationsFromEntries(visibleEntries),
    operations: recentDistinctOperations(routedEntries).map(({ appId, entry }) => ({
      appId,
      entry,
      id: `${entry.turnId}:${entry.step.id}`,
      status: entry.step.status,
      title: operationTitle(entry.step, appId),
    })),
    truth: "structured",
    windows,
  };
}

export function projectKernelBackedTinyOsDesktop(
  entries: readonly TinyOsTimelineEntry[],
  canonicalItems: readonly BackendAgentTurnItem[],
  cursor: TinyOsCursor,
): TinyOsDesktopSnapshot {
  const kernel = projectTinyOsKernel(canonicalItems, cursor.mode === "history" && cursor.itemId
    ? { itemId: cursor.itemId, mode: "history", turnId: cursor.turnId }
    : { mode: "live" });
  return projectTinyOsDesktop(entries, cursor, kernel);
}

export function tinyOsAppForStep(step: ChatStep): TinyOsAppId | undefined {
  return appForStep(step, new Map());
}

function replayEndIndex(entries: readonly TinyOsTimelineEntry[], cursor: TinyOsCursor): number {
  if (cursor.mode === "live_follow" || !cursor.itemId) return entries.length;
  const index = entries.findIndex(({ step, turnId }) => (
    step.id === cursor.itemId && (!cursor.turnId || turnId === cursor.turnId)
  ));
  return index < 0 ? entries.length : index + 1;
}

function appForStep(step: ChatStep, appByStepId: ReadonlyMap<string, TinyOsAppId>): TinyOsAppId | undefined {
  if (step.kind === "reasoning" || step.kind === "message") return undefined;
  if (step.kind === "plan") return "plan";
  if (step.kind === "approval" || step.kind === "form") return "inspector";
  if (step.kind === "delegate") return "subagents";
  if (step.kind === "browser") return "browser";
  if (step.kind === "memory") return "memory";
  if (step.kind === "compaction") return "inspector";
  if (step.kind === "artifact") {
    return step.artifacts?.some((artifact) => artifact.kind === "browser_snapshot") ? "browser" : "artifacts";
  }
  if (step.kind === "error") {
    return (step.parentStepId && appByStepId.get(step.parentStepId)) || "inspector";
  }
  const toolName = `${step.toolCall?.name ?? ""} ${step.title}`;
  if (/^tool[._-]?search$/i.test(step.toolCall?.name ?? step.title)) return "inspector";
  if (PLAN_TOOL_RE.test(toolName)) return "plan";
  if (BROWSER_TOOL_RE.test(toolName)) return "browser";
  if (MEMORY_TOOL_RE.test(toolName)) return "memory";
  if (TERMINAL_TOOL_RE.test(toolName)) return "terminal";
  if (FILE_TOOL_RE.test(toolName)) return "files";
  return step.kind === "tool_call" || step.kind === "tool_result" ? "inspector" : undefined;
}

function recentDistinctOperations(
  routedEntries: Array<{ appId: TinyOsAppId; entry: TinyOsTimelineEntry }>,
): Array<{ appId: TinyOsAppId; entry: TinyOsTimelineEntry }> {
  const seen = new Set<string>();
  const selected: Array<{ appId: TinyOsAppId; entry: TinyOsTimelineEntry }> = [];
  for (let index = routedEntries.length - 1; index >= 0 && selected.length < 3; index -= 1) {
    const candidate = routedEntries[index];
    const key = `${candidate.appId}:${operationTitle(candidate.entry.step, candidate.appId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(candidate);
  }
  return selected.reverse();
}

function dialogFromEntries(entries: readonly TinyOsTimelineEntry[]): Pick<TinyOsDesktopSnapshot, "dialog"> | object {
  const entry = [...entries].reverse().find(({ step }) => (
    (step.kind === "approval" || step.kind === "form") && !isTerminalStatus(step.status)
  ));
  if (!entry || (entry.step.kind !== "approval" && entry.step.kind !== "form")) return {};
  return {
    dialog: {
      entry,
      id: `${entry.turnId}:${entry.step.id}`,
      kind: entry.step.kind,
    },
  };
}

function notificationsFromEntries(entries: readonly TinyOsTimelineEntry[]): TinyOsNotification[] {
  return entries.flatMap((entry): TinyOsNotification[] => {
    const { step } = entry;
    if (step.kind === "error" || step.status === "failed") {
      return [{
        entry,
        id: `${entry.turnId}:${step.id}:error`,
        kind: "error",
        message: step.summary || errorMessage(step.error) || "The operation failed.",
        title: step.title,
      }];
    }
    if (step.status === "cancelled") {
      return [{
        entry,
        id: `${entry.turnId}:${step.id}:cancelled`,
        kind: "cancelled",
        message: step.summary || "The operation was cancelled.",
        title: step.title,
      }];
    }
    if (step.kind === "delegate" && step.status === "completed") {
      return [{
        entry,
        id: `${entry.turnId}:${step.id}:completed`,
        kind: "completed",
        message: step.delegate?.latestActivity || step.delegate?.finalOutput || "Subagent completed.",
        title: step.delegate?.title || step.title,
      }];
    }
    return [];
  }).slice(-3);
}

function operationTitle(step: ChatStep, appId: TinyOsAppId): string {
  if (step.kind === "approval") return "Approval required";
  if (step.kind === "form") return "Input required";
  if (step.kind === "error") return step.title || "Operation failed";
  if (step.toolCall?.name) return step.toolCall.name;
  return step.title || APP_TITLES[appId];
}

function isTerminalStatus(status: ChatStepStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
}
