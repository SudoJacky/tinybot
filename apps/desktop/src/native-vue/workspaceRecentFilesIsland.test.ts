// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopWorkspaceFileState } from "../desktopWorkspaceFiles";
import { mountWorkspaceRecentFilesIsland } from "./workspaceRecentFilesIsland";

describe("workspace recent files Vue island", () => {
  test("mounts filtered workspace rows and routes selection", async () => {
    const host = document.createElement("div");
    const selected: string[] = [];
    const state: DesktopWorkspaceFileState = {
      files: [
        { path: "AGENTS.md", exists: true, updatedAt: "2026-05-31T10:00:00+00:00", meta: "Updated 2026-05-31T10:00:00+00:00" },
        { path: "docs/notes.md", exists: true, updatedAt: null, meta: "Available" },
        { path: "tmp/generated.log", exists: false, updatedAt: null, meta: "Not created" },
      ],
      recentPaths: ["docs/notes.md", "AGENTS.md"],
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

    const mounted = mountWorkspaceRecentFilesIsland(host, {
      state,
      onSelect: (path) => selected.push(path),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("workspace-recent-files");
    expect(host.getAttribute("id")).toBe("desktop-workspace-recent-files");
    expect(host.getAttribute("aria-label")).toBe("Recent workspace files");
    const rows = Array.from(host.querySelectorAll("[data-desktop-workspace-file]"));
    expect(rows.map((row) => row.querySelector(".desktop-workspace-file-path")?.textContent)).toEqual([
      "docs/notes.md",
      "AGENTS.md",
    ]);
    expect(rows.map((row) => row.querySelector(".desktop-workspace-file-meta")?.textContent)).toEqual([
      "Available",
      "Updated 2026-05-31T10:00:00+00:00",
    ]);
    expect(host.querySelector('[data-desktop-workspace-file="AGENTS.md"]')?.getAttribute("aria-selected")).toBe("true");

    host.querySelector<HTMLButtonElement>('[data-desktop-workspace-file="docs/notes.md"]')?.click();
    expect(selected).toEqual(["docs/notes.md"]);

    mounted.update({ ...state, searchQuery: "log" });
    await nextTick();
    expect(Array.from(host.querySelectorAll("[data-desktop-workspace-file]")).map((row) => row.getAttribute("data-desktop-workspace-file"))).toEqual([
      "tmp/generated.log",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
