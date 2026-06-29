// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopWorkspaceFileState } from "../desktopWorkspaceFiles";
import { mountWorkspaceHeaderIsland } from "./workspaceHeaderIsland";

const state: DesktopWorkspaceFileState = {
  files: [
    { path: "AGENTS.md", exists: true, updatedAt: "2026-05-31T10:00:00+00:00", meta: "Updated 2026-05-31T10:00:00+00:00" },
    { path: "docs/notes.md", exists: true, updatedAt: null, meta: "Available" },
  ],
  recentPaths: ["AGENTS.md"],
  activePath: null,
  activeUpdatedAt: null,
  activeSizeBytes: null,
  draft: "",
  savedDraft: "",
  dirty: false,
  saveState: "idle",
  error: null,
  exportedPath: null,
  searchQuery: "",
};

describe("workspace header Vue island", () => {
  test("renders and updates the workspace file count", async () => {
    const host = document.createElement("div");

    const mounted = mountWorkspaceHeaderIsland(host, { state });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("workspace-header");
    expect(host.className).toContain("desktop-workspace-header");
    expect(host.textContent).toContain("Workspace files");
    expect(host.textContent).toContain("Browse, inspect, edit, and export workspace files.");
    expect(host.querySelector("#desktop-workspace-status")?.textContent).toBe("2 files");

    mounted.update({ ...state, files: [state.files[0]!] });
    await nextTick();
    expect(host.querySelector("#desktop-workspace-status")?.textContent).toBe("1 file");

    mounted.update({ ...state, files: [] });
    await nextTick();
    expect(host.querySelector("#desktop-workspace-status")?.textContent).toBe("0 files");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
