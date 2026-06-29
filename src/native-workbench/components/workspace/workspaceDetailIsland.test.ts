// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopWorkspaceFileState } from "../../workspace/desktopWorkspaceFiles";
import { mountWorkspaceDetailIsland } from "./workspaceDetailIsland";

const state: DesktopWorkspaceFileState = {
  files: [
    { path: "AGENTS.md", exists: true, updatedAt: "2026-05-31T10:00:00+00:00", meta: "Updated 2026-05-31T10:00:00+00:00" },
  ],
  recentPaths: ["AGENTS.md"],
  activePath: "AGENTS.md",
  activeUpdatedAt: "2026-05-31T10:00:00+00:00",
  activeSizeBytes: 128,
  draft: "# Rules",
  savedDraft: "# Rules",
  dirty: false,
  saveState: "idle",
  error: null,
  exportedPath: null,
  searchQuery: "",
};

describe("workspace detail Vue island", () => {
  test("renders and updates workspace file selection details", async () => {
    const host = document.createElement("section");

    const mounted = mountWorkspaceDetailIsland(host, { state });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("workspace-detail");
    expect(host.className).toContain("desktop-workspace-detail-panel");
    expect(host.textContent).toContain("Selection");
    expect(host.querySelector("#desktop-workspace-active-path")?.textContent).toContain("AGENTS.md");
    expect(host.querySelector("#desktop-workspace-updated-at")?.textContent).toContain("2026-05-31T10:00:00+00:00");
    expect(host.querySelector("#desktop-workspace-size")?.textContent).toContain("128 B");
    expect(host.querySelector("#desktop-workspace-detail")?.textContent).toContain("No unsaved changes");

    mounted.update({
      ...state,
      activePath: null,
      activeUpdatedAt: null,
      activeSizeBytes: null,
      saveState: "idle",
    });
    await nextTick();

    expect(host.querySelector("#desktop-workspace-active-path")?.textContent).toContain("No workspace file selected");
    expect(host.querySelector("#desktop-workspace-updated-at")?.textContent).toContain("No timestamp");
    expect(host.querySelector("#desktop-workspace-size")?.textContent).toContain("No size");
    expect(host.querySelector("#desktop-workspace-detail")?.textContent).toContain("No workspace file selected");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
