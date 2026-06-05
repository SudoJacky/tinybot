// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { upgradeDesktopRootWebUiEmptyState } from "./desktopEmptyState";

function createEmptyChat(): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "empty-state empty-chat";
  const title = document.createElement("div");
  title.className = "empty-chat-title";
  title.textContent = "Current session has no messages.";
  const actions = document.createElement("div");
  actions.className = "empty-chat-actions";
  for (const label of [
    "Summarize my uploaded files",
    "Explain a concept",
    "Answer from the knowledge base",
    "Create a todo/reminder",
  ]) {
    const button = document.createElement("button");
    button.textContent = label;
    actions.append(button);
  }
  empty.append(title, actions);
  return empty;
}

describe("desktop empty state", () => {
  test("upgrades the root WebUI empty chat to compact workbench hints once", () => {
    const empty = createEmptyChat();

    expect(upgradeDesktopRootWebUiEmptyState(empty, document)).toBe(true);
    expect(upgradeDesktopRootWebUiEmptyState(empty, document)).toBe(false);

    expect(empty.getAttribute("data-desktop-empty-state")).toBe("true");
    expect(empty.classList.contains("desktop-empty-state-compact")).toBe(true);
    expect(empty.querySelectorAll(".desktop-empty-hints")).toHaveLength(1);
    expect(empty.querySelector(".desktop-empty-hints")?.getAttribute("data-desktop-vue-island")).toBe("desktop-empty-hints");
    expect(Array.from(empty.querySelectorAll(".desktop-empty-hint")).map((node) => node.textContent)).toEqual([
      "Recent sessionsUse Search to resume a conversation.",
      "Files and resourcesAttach a session file or open Workspace.",
      "Background tasksCheck streaming, cowork, uploads, and approvals.",
      "Gateway healthUse the Gateway status for diagnostics.",
    ]);
    expect(empty.querySelectorAll(".desktop-empty-module")).toHaveLength(0);
  });

  test("keeps suggested prompts as lightweight command hints", () => {
    const empty = createEmptyChat();

    upgradeDesktopRootWebUiEmptyState(empty, document);

    const actions = empty.querySelector(".empty-chat-actions");
    expect(actions?.classList.contains("desktop-empty-command-hints")).toBe(true);
    expect(actions?.getAttribute("data-desktop-empty-command-hints")).toBe("true");
    expect(actions?.textContent).toContain("Summarize my uploaded files");
    expect(actions?.textContent).toContain("Create a todo/reminder");
  });
});
