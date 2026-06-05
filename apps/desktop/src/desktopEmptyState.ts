import { mountDesktopEmptyHintsIsland } from "./native-vue/desktopEmptyHintsIsland";

const EMPTY_HINTS = [
  ["Recent sessions", "Use Search to resume a conversation."],
  ["Files and resources", "Attach a session file or open Workspace."],
  ["Background tasks", "Check streaming, cowork, uploads, and approvals."],
  ["Gateway health", "Use the Gateway status for diagnostics."],
] as const;

export function upgradeDesktopRootWebUiEmptyState(emptyChat: HTMLElement, targetDocument: Document): boolean {
  if (emptyChat.getAttribute("data-desktop-empty-state") === "true") {
    return false;
  }

  emptyChat.setAttribute("data-desktop-empty-state", "true");
  emptyChat.classList.add("desktop-empty-state-compact");

  const hints = targetDocument.createElement("div");
  if (typeof window === "undefined") {
    renderStaticEmptyHints(hints, targetDocument);
  } else {
    mountDesktopEmptyHintsIsland(hints, {
      hints: EMPTY_HINTS.map(([title, detail]) => ({ detail, title })),
    });
  }

  const actions = emptyChat.querySelector<HTMLElement>(".empty-chat-actions");
  actions?.classList.add("desktop-empty-command-hints");
  actions?.setAttribute("data-desktop-empty-command-hints", "true");
  emptyChat.insertBefore(hints, actions ?? null);
  return true;
}

function renderStaticEmptyHints(hints: HTMLElement, targetDocument: Document): void {
  hints.className = "desktop-empty-hints";
  hints.setAttribute("aria-label", "Desktop workbench starting points");

  for (const [title, detail] of EMPTY_HINTS) {
    const item = targetDocument.createElement("article");
    item.className = "desktop-empty-hint";

    const heading = targetDocument.createElement("strong");
    heading.textContent = title;
    const copy = targetDocument.createElement("span");
    copy.textContent = detail;

    item.append(heading, copy);
    hints.append(item);
  }
}
