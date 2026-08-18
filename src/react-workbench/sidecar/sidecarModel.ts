export const DEFAULT_SIDECAR_WIDTH = 480;
export const MIN_SIDECAR_WIDTH = 380;
export const SIDECAR_WIDTH_STORAGE_KEY = "tinybot.ui.sidecar.width.v1";
export const DEFAULT_SIDECAR_WORKSPACE_ID = "sidecar-workspace:default";

export type SidecarPresentation = "closed" | "docked" | "expanded";
export type SidecarShell = "powershell" | "cmd";

type SidecarTabBase = {
  id: string;
  title: string;
};

export type SidecarBrowserTab = SidecarTabBase & {
  browserSessionId?: string;
  kind: "browser";
  nativeTabId?: string;
  threadId: string;
};

export type SidecarBrowserSessionTab = {
  nativeTabId: string;
  title: string;
};

export type SidecarTerminalTab = SidecarTabBase & {
  kind: "terminal";
  shell: SidecarShell;
  workspaceId: string;
};

export type SidecarArtifactTab = SidecarTabBase & {
  artifactId: string;
  kind: "artifact";
  threadId: string;
};

export type SidecarTab = SidecarBrowserTab | SidecarTerminalTab | SidecarArtifactTab;

export type SidecarState = {
  activeTabId: string;
  currentThreadId: string;
  currentWorkspaceId: string;
  nextResourceSequence: number;
  presentation: SidecarPresentation;
  tabs: SidecarTab[];
  width: number;
};

export type SidecarEvent =
  | { type: "scope.changed"; threadId: string; workspaceId: string }
  | { type: "presentation.show" }
  | { type: "presentation.hide" }
  | { type: "presentation.toggleExpanded" }
  | { type: "presentation.resize"; width: number; maxWidth: number }
  | { type: "tab.newBrowser" }
  | {
    type: "tab.syncBrowserSession";
    browserSessionId: string;
    tabs: SidecarBrowserSessionTab[];
    threadId: string;
  }
  | { type: "tab.newTerminal"; shell?: SidecarShell }
  | { type: "tab.openArtifact"; artifactId: string; threadId: string; title: string }
  | { type: "tab.activate"; tabId: string }
  | { type: "tab.close"; tabId: string };

export function createInitialSidecarState(width = DEFAULT_SIDECAR_WIDTH): SidecarState {
  return {
    activeTabId: "",
    currentThreadId: "",
    currentWorkspaceId: "",
    nextResourceSequence: 1,
    presentation: "closed",
    tabs: [],
    width: clampSidecarWidth(width, Number.POSITIVE_INFINITY),
  };
}

export function reduceSidecarState(state: SidecarState, event: SidecarEvent): SidecarState {
  switch (event.type) {
    case "scope.changed": {
      const scoped = {
        ...state,
        currentThreadId: event.threadId,
        currentWorkspaceId: event.workspaceId,
      };
      return selectVisibleActiveTab(scoped);
    }
    case "presentation.show":
      return state.presentation === "closed" ? { ...state, presentation: "docked" } : state;
    case "presentation.hide":
      return state.presentation === "closed" ? state : { ...state, presentation: "closed" };
    case "presentation.toggleExpanded":
      return {
        ...state,
        presentation: state.presentation === "expanded" ? "docked" : "expanded",
      };
    case "presentation.resize":
      return {
        ...state,
        width: clampSidecarWidth(event.width, event.maxWidth),
      };
    case "tab.newBrowser": {
      if (!state.currentThreadId) return state;
      const sequence = state.nextResourceSequence;
      const tab: SidecarBrowserTab = {
        id: `browser:${encodeURIComponent(state.currentThreadId)}:${sequence}`,
        kind: "browser",
        threadId: state.currentThreadId,
        title: browserTitle(state, sequence),
      };
      return openTab(state, tab);
    }
    case "tab.syncBrowserSession":
      return syncBrowserSession(state, event);
    case "tab.newTerminal": {
      if (!state.currentWorkspaceId) return state;
      const sequence = state.nextResourceSequence;
      const shell = event.shell ?? "powershell";
      const tab: SidecarTerminalTab = {
        id: `terminal:${encodeURIComponent(state.currentWorkspaceId)}:${sequence}`,
        kind: "terminal",
        shell,
        title: terminalTitle(state, shell),
        workspaceId: state.currentWorkspaceId,
      };
      return openTab(state, tab);
    }
    case "tab.openArtifact": {
      const tabId = sidecarArtifactTabId(event.threadId, event.artifactId);
      const existing = state.tabs.find((tab) => tab.id === tabId);
      if (existing) {
        return {
          ...state,
          activeTabId: existing.id,
          presentation: state.presentation === "closed" ? "docked" : state.presentation,
        };
      }
      return openTab(state, {
        artifactId: event.artifactId,
        id: tabId,
        kind: "artifact",
        threadId: event.threadId,
        title: event.title,
      });
    }
    case "tab.activate":
      return visibleSidecarTabs(state).some((tab) => tab.id === event.tabId)
        ? { ...state, activeTabId: event.tabId }
        : state;
    case "tab.close": {
      const closingIndex = visibleSidecarTabs(state).findIndex((tab) => tab.id === event.tabId);
      if (closingIndex < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== event.tabId);
      if (state.activeTabId !== event.tabId) {
        return { ...state, tabs };
      }
      const visible = visibleSidecarTabs({ ...state, tabs });
      return {
        ...state,
        activeTabId: visible[closingIndex]?.id ?? visible[closingIndex - 1]?.id ?? "",
        tabs,
      };
    }
  }
}

function syncBrowserSession(
  state: SidecarState,
  event: Extract<SidecarEvent, { type: "tab.syncBrowserSession" }>,
): SidecarState {
  const resources = state.tabs.filter((tab): tab is SidecarBrowserTab => (
    tab.kind === "browser" && tab.threadId === event.threadId
  ));
  if (!resources.length) return state;

  const nativeTabIds = new Set(event.tabs.map((tab) => tab.nativeTabId));
  const assignedResourceIds = new Set<string>();
  const synchronizedByResourceId = new Map<string, SidecarBrowserTab>();
  const matchingByNativeTabId = new Map(
    resources.flatMap((resource) => resource.nativeTabId && nativeTabIds.has(resource.nativeTabId)
      ? [[resource.nativeTabId, resource] as const]
      : []),
  );
  const reusableResources = resources.filter((resource) => (
    !resource.nativeTabId || !nativeTabIds.has(resource.nativeTabId)
  ));
  let nextResourceSequence = state.nextResourceSequence;
  const appended: SidecarBrowserTab[] = [];

  for (const nativeTab of event.tabs) {
    const matching = matchingByNativeTabId.get(nativeTab.nativeTabId);
    const reusable = matching ?? reusableResources.find((resource) => !assignedResourceIds.has(resource.id));
    const resource = reusable ?? {
      id: `browser:${encodeURIComponent(event.threadId)}:${nextResourceSequence++}`,
      kind: "browser" as const,
      threadId: event.threadId,
      title: nativeTab.title,
    };
    assignedResourceIds.add(resource.id);
    const synchronized: SidecarBrowserTab = {
      ...resource,
      browserSessionId: event.browserSessionId,
      nativeTabId: nativeTab.nativeTabId,
      title: nativeTab.title,
    };
    synchronizedByResourceId.set(resource.id, synchronized);
    if (!state.tabs.some((tab) => tab.id === resource.id)) appended.push(synchronized);
  }

  const tabs = state.tabs.flatMap((tab) => {
    if (tab.kind !== "browser" || tab.threadId !== event.threadId) return [tab];
    const synchronized = synchronizedByResourceId.get(tab.id);
    if (synchronized) return [synchronized];
    return tab.nativeTabId ? [] : [tab];
  }).concat(appended);
  return selectVisibleActiveTab({
    ...state,
    nextResourceSequence,
    tabs,
  });
}

export function visibleSidecarTabs(state: SidecarState): SidecarTab[] {
  return state.tabs.filter((tab) => {
    if (tab.kind === "terminal") {
      return Boolean(state.currentWorkspaceId) && tab.workspaceId === state.currentWorkspaceId;
    }
    return Boolean(state.currentThreadId) && tab.threadId === state.currentThreadId;
  });
}

export function activeSidecarTab(state: SidecarState): SidecarTab | undefined {
  return visibleSidecarTabs(state).find((tab) => tab.id === state.activeTabId);
}

export function sidecarArtifactTabId(threadId: string, artifactId: string): string {
  return `artifact:${encodeURIComponent(threadId)}:${encodeURIComponent(artifactId)}`;
}

export function readPersistedSidecarWidth(storage: Pick<Storage, "getItem">): number {
  const stored = Number(storage.getItem(SIDECAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? Math.max(MIN_SIDECAR_WIDTH, stored) : DEFAULT_SIDECAR_WIDTH;
}

export function writePersistedSidecarWidth(
  storage: Pick<Storage, "setItem">,
  width: number,
): void {
  storage.setItem(SIDECAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
}

function openTab(state: SidecarState, tab: SidecarTab): SidecarState {
  return {
    ...state,
    activeTabId: tab.id,
    nextResourceSequence: state.nextResourceSequence + 1,
    presentation: state.presentation === "closed" ? "docked" : state.presentation,
    tabs: [...state.tabs, tab],
  };
}

function selectVisibleActiveTab(state: SidecarState): SidecarState {
  const visible = visibleSidecarTabs(state);
  return visible.some((tab) => tab.id === state.activeTabId)
    ? state
    : { ...state, activeTabId: visible[0]?.id ?? "" };
}

function browserTitle(state: SidecarState, sequence: number): string {
  const count = visibleSidecarTabs(state).filter((tab) => tab.kind === "browser").length;
  return count ? `New browser ${count + 1}` : sequence > 1 ? "New browser" : "Browser";
}

function terminalTitle(state: SidecarState, shell: SidecarShell): string {
  const label = shell === "cmd" ? "Command Prompt" : "PowerShell";
  const count = visibleSidecarTabs(state).filter((tab) => tab.kind === "terminal" && tab.shell === shell).length;
  return count ? `${label} ${count + 1}` : label;
}

function clampSidecarWidth(width: number, maxWidth: number): number {
  const resolvedMax = Math.max(MIN_SIDECAR_WIDTH, maxWidth);
  return Math.min(resolvedMax, Math.max(MIN_SIDECAR_WIDTH, Math.round(width)));
}
