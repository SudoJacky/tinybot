export interface DesktopShortcutHelpItem {
  key: string;
  command: string;
  description: string;
  availability: string;
}

export interface DesktopHelpTourTarget {
  id: string;
  selector: string;
  title: string;
  description: string;
}

export interface DesktopVisibleHelpTarget extends DesktopHelpTourTarget {
  visible: boolean;
}

export const DESKTOP_SHORTCUT_HELP_ITEMS: DesktopShortcutHelpItem[] = [
  {
    key: "Ctrl+N",
    command: "New chat",
    description: "Start a fresh chat session in the desktop workbench.",
    availability: "Always available",
  },
  {
    key: "Ctrl+.",
    command: "Stop generation",
    description: "Request cancellation for the active response.",
    availability: "Requires an active generation",
  },
  {
    key: "Ctrl+F",
    command: "Search sessions",
    description: "Open session search without leaving the current workbench context.",
    availability: "Always available",
  },
  {
    key: "Ctrl+,",
    command: "Settings",
    description: "Navigate to desktop settings and provider panes.",
    availability: "Always available",
  },
  {
    key: "F1",
    command: "Documentation",
    description: "Open bundled Tinybot documentation from the desktop static origin.",
    availability: "Always available",
  },
  {
    key: "Ctrl+Shift+P",
    command: "Command palette",
    description: "Search commands, sessions, files, knowledge, tools, skills, and Cowork sessions.",
    availability: "Always available",
  },
  {
    key: "Ctrl+B",
    command: "Toggle sidebar",
    description: "Show or hide the persistent desktop sidebar.",
    availability: "Always available",
  },
  {
    key: "Ctrl+Shift+G",
    command: "Gateway status",
    description: "Route to gateway runtime status and recovery controls.",
    availability: "Always available",
  },
  {
    key: "Ctrl+/",
    command: "Shortcut help",
    description: "Show current desktop shortcuts in the inspector pane.",
    availability: "Desktop workbench mode",
  },
  {
    key: "Ctrl+Shift+/",
    command: "Page help",
    description: "Show visible workbench regions and help-tour targets in the inspector pane.",
    availability: "Desktop workbench mode",
  },
];

export const DESKTOP_HELP_TOUR_TARGETS: DesktopHelpTourTarget[] = [
  {
    id: "activity",
    selector: "[data-workbench-region=\"activity\"]",
    title: "Activity rail",
    description: "Switch between Chat, Files, Knowledge, and Cowork without opening browser-style pages.",
  },
  {
    id: "sidebar",
    selector: "[data-workbench-region=\"sidebar\"]",
    title: "Sidebar",
    description: "Keep sessions and resource links available while the main work area changes.",
  },
  {
    id: "main",
    selector: "[data-workbench-region=\"main\"]",
    title: "Primary work area",
    description: "Use the central pane for active chat, files, settings, tools, knowledge, or Cowork workflows.",
  },
  {
    id: "inspector",
    selector: "[data-workbench-region=\"inspector\"]",
    title: "Inspector",
    description: "Review run-chain, task, gateway, file, and help details without blocking the main work area.",
  },
  {
    id: "bottom",
    selector: "[data-workbench-region=\"bottom\"]",
    title: "Task and runtime area",
    description: "Track long-running work, retryable failures, and gateway diagnostics.",
  },
  {
    id: "command-palette",
    selector: "#desktop-command-palette",
    title: "Command palette",
    description: "Search commands and loaded workbench data with keyboard access.",
  },
  {
    id: "workspace-files",
    selector: ".desktop-workspace-files",
    title: "Workspace files",
    description: "Load, edit, save, reveal, and export allowed workspace files.",
  },
  {
    id: "help",
    selector: ".desktop-help-pane",
    title: "Help",
    description: "Open bundled docs, shortcut help, page help, or this desktop tour.",
  },
];

export function resolveDesktopVisibleHelpTargets(
  targetDocument: Pick<Document, "querySelector"> = document,
): DesktopVisibleHelpTarget[] {
  return DESKTOP_HELP_TOUR_TARGETS.map((target) => ({
    ...target,
    visible: isHelpTargetVisible(targetDocument.querySelector(target.selector)),
  }));
}

export function buildDesktopShortcutHelpText(items: DesktopShortcutHelpItem[] = DESKTOP_SHORTCUT_HELP_ITEMS): string[] {
  return items.map((item) => `${item.key}: ${item.command} - ${item.description} (${item.availability})`);
}

export function buildDesktopPageHelpText(targets: DesktopVisibleHelpTarget[]): string[] {
  return targets
    .filter((target) => target.visible)
    .map((target, index) => `Step ${index + 1}: ${target.title} - ${target.description}`);
}

function isHelpTargetVisible(element: Element | null): boolean {
  if (!element || typeof element.getBoundingClientRect !== "function") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
