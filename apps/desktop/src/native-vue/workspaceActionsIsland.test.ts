// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopWorkspaceFileState } from "../desktopWorkspaceFiles";
import { mountWorkspaceActionsIsland } from "./workspaceActionsIsland";

const state: DesktopWorkspaceFileState = {
  files: [],
  recentPaths: [],
  activePath: "AGENTS.md",
  activeUpdatedAt: "2026-05-31T10:00:00+00:00",
  activeSizeBytes: 128,
  draft: "# Rules\n\nUse uv.\n",
  savedDraft: "# Rules\n",
  dirty: true,
  saveState: "dirty",
  error: null,
  exportedPath: null,
  searchQuery: "",
};

describe("workspace actions Vue island", () => {
  test("renders workspace action buttons and dispatches actions", () => {
    const host = document.createElement("aside");
    const actions: string[] = [];

    const mounted = mountWorkspaceActionsIsland(host, {
      state,
      canReveal: true,
      canExport: true,
      onAction: (action) => actions.push(action),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("workspace-actions");
    expect(host.className).toContain("desktop-workspace-action-rail");
    expect(host.getAttribute("aria-label")).toBe("Workspace file actions");
    expect(host.textContent).toContain("Actions");
    expect(host.querySelector("#desktop-workspace-save-state")?.textContent).toContain("Unsaved changes");
    expect(host.querySelector("#desktop-workspace-error")?.textContent).toBe("");

    const save = host.querySelector<HTMLButtonElement>("#desktop-workspace-save");
    const reveal = host.querySelector<HTMLButtonElement>("#desktop-workspace-reveal");
    const exportButton = host.querySelector<HTMLButtonElement>("#desktop-workspace-export");
    const reload = host.querySelector<HTMLButtonElement>("#desktop-workspace-reload");
    expect(save?.className).toContain("desktop-file-action");
    expect(save?.disabled).toBe(false);
    expect(reveal?.disabled).toBe(false);
    expect(exportButton?.disabled).toBe(false);
    expect(reload?.disabled).toBe(true);

    save?.click();
    reveal?.click();
    exportButton?.click();
    reload?.click();
    expect(actions).toEqual(["save", "reveal", "export"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("updates disabled states and error copy from workspace state", async () => {
    const host = document.createElement("aside");

    const mounted = mountWorkspaceActionsIsland(host, {
      state: {
        ...state,
        saveState: "saving",
      },
      canReveal: true,
      canExport: true,
    });

    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-save")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-reveal")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-export")?.disabled).toBe(true);

    mounted.update({
      ...state,
      dirty: false,
      saveState: "conflict-error",
      error: "Reload before saving",
    }, false, false);
    await nextTick();

    expect(host.querySelector("#desktop-workspace-save-state")?.textContent).toContain("Save conflict");
    expect(host.querySelector("#desktop-workspace-error")?.textContent).toContain("Reload before saving");
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-save")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-reveal")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-export")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-reload")?.disabled).toBe(false);

    mounted.update({
      ...state,
      activePath: null,
      dirty: false,
      saveState: "idle",
    }, true, true);
    await nextTick();

    expect(host.querySelector("#desktop-workspace-save-state")?.textContent).toContain("Select a workspace file");
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-save")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-reveal")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-export")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-reload")?.disabled).toBe(true);

    mounted.unmount();
  });
});
