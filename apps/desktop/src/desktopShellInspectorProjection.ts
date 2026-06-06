export type DesktopShellModule = "chat" | "knowledge" | "files" | "settings" | "workspace";
export type DesktopShellEventKind = "task" | "approval" | "gateway" | "diagnostic";

export interface DesktopShellVisibleEvent {
  kind: DesktopShellEventKind;
  id: string;
  state: string;
  title?: string;
}

export interface DesktopShellInspectorProjectionInput {
  activeModule: DesktopShellModule;
  collapsedRegions?: Set<string>;
  regionSizes?: {
    leftSidebar?: number;
    rightInspector?: number;
  };
  events: DesktopShellVisibleEvent[];
}

export interface DesktopShellEventEnvelope {
  type: "task_started" | "task_updated" | "task_completed" | "approval_pending" | "approval_resolved" | "gateway_status" | "error";
  id: string;
  title: string;
}

export interface DesktopShellInspectorProjection {
  regions: Array<{
    id: string;
    label: string;
    collapsible: boolean;
    collapsed: boolean;
    sizePx: number | null;
  }>;
  toolbar: Array<{
    id: string;
    label: string;
    active: boolean;
    badge: string | null;
  }>;
  inspector: {
    defaultTab: string;
    tabs: Array<{
      id: string;
      label: string;
      active: boolean;
      badge: string | null;
    }>;
  };
}

export function buildDesktopShellInspectorProjection(
  input: DesktopShellInspectorProjectionInput,
): DesktopShellInspectorProjection {
  const counts = eventCounts(input.events);
  const defaultTab = defaultInspectorTab(input.activeModule);

  return {
    regions: [
      region("left-sidebar", "Workspace navigation", true, input.collapsedRegions, input.regionSizes?.leftSidebar ?? null),
      region("main-workbench", "Main workbench", false, input.collapsedRegions, null),
      region("right-inspector", "Inspector", true, input.collapsedRegions, input.regionSizes?.rightInspector ?? null),
      region("bottom-composer", "Composer", true, input.collapsedRegions, null),
    ],
    toolbar: [
      toolbarEntry("workspace", "Workspace", input.activeModule === "workspace"),
      toolbarEntry("command-palette", "Command palette", false),
      toolbarEntry("model", "Model", false),
      toolbarEntry("knowledge", "Knowledge", input.activeModule === "knowledge"),
      toolbarEntry("gateway", "Gateway", false, counts.gateway),
      toolbarEntry("tasks", "Tasks", false, counts.task),
      toolbarEntry("approvals", "Approvals", false, counts.approval),
      toolbarEntry("settings", "Settings", input.activeModule === "settings"),
    ],
    inspector: {
      defaultTab,
      tabs: [
        inspectorTab("activity", "Activity", defaultTab, counts.task),
        inspectorTab("approvals", "Approvals", defaultTab, counts.approval),
        inspectorTab("files", "Files", defaultTab, 0),
        inspectorTab("knowledge", "Knowledge", defaultTab, 0),
        inspectorTab("diagnostics", "Diagnostics", defaultTab, counts.diagnostic),
      ],
    },
  };
}

export function createDesktopShellEventDispatcher() {
  const events: DesktopShellVisibleEvent[] = [];
  return {
    dispatch: (event: DesktopShellEventEnvelope) => {
      events.push(normalizeShellEvent(event));
    },
    snapshot: () => events.map((event) => ({ ...event })),
  };
}

function normalizeShellEvent(event: DesktopShellEventEnvelope): DesktopShellVisibleEvent {
  if (event.type.startsWith("task_")) {
    return {
      kind: "task",
      id: event.id,
      state: event.type === "task_completed" ? "completed" : "active",
      title: event.title,
    };
  }
  if (event.type.startsWith("approval_")) {
    return {
      kind: "approval",
      id: event.id,
      state: event.type === "approval_resolved" ? "resolved" : "pending",
      title: event.title,
    };
  }
  if (event.type === "gateway_status") {
    return { kind: "gateway", id: event.id, state: "ready", title: event.title };
  }
  return { kind: "diagnostic", id: event.id, state: "error", title: event.title };
}

function region(
  id: string,
  label: string,
  collapsible: boolean,
  collapsedRegions: Set<string> | undefined,
  sizePx: number | null,
) {
  return {
    id,
    label,
    collapsible,
    collapsed: Boolean(collapsedRegions?.has(id)),
    sizePx,
  };
}

function toolbarEntry(id: string, label: string, active: boolean, count = 0) {
  return {
    id,
    label,
    active,
    badge: count ? String(count) : null,
  };
}

function inspectorTab(id: string, label: string, defaultTab: string, count: number) {
  return {
    id,
    label,
    active: id === defaultTab,
    badge: count ? String(count) : null,
  };
}

function eventCounts(events: DesktopShellVisibleEvent[]): Record<DesktopShellEventKind, number> {
  return events.reduce<Record<DesktopShellEventKind, number>>((counts, event) => {
    counts[event.kind] += event.state === "resolved" || event.state === "completed" ? 0 : 1;
    return counts;
  }, { task: 0, approval: 0, gateway: 0, diagnostic: 0 });
}

function defaultInspectorTab(module: DesktopShellModule): string {
  if (module === "files" || module === "knowledge") {
    return module;
  }
  return "activity";
}
