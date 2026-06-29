// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountWorkspaceFilesSurfaceIsland } from "./workspaceFilesSurfaceIsland";

describe("workspace files surface Vue island", () => {
  test("renders the workspace files shell with stable desktop selectors", () => {
    const host = document.createElement("section");

    const mounted = mountWorkspaceFilesSurfaceIsland(host);

    expect(host.className).toBe("desktop-workspace-files");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("workspace-files-surface");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("files workspace");
    expect(host.getAttribute("data-desktop-workspace-layout")).toBe("source-browser-detail-actions");
    const grid = host.querySelector<HTMLElement>(".n-grid.desktop-workspace-files-grid");
    expect(grid).not.toBeNull();
    expect(grid?.style.gridTemplateAreas).toContain("source browser detail actions");
    expect(grid?.style.gridTemplateColumns).toBe("minmax(180px, 0.62fr) minmax(240px, 0.9fr) minmax(300px, 1.5fr) minmax(160px, 0.7fr)");

    expect(host.querySelector(".desktop-workspace-header")?.textContent).toContain("Workspace files");
    expect(host.querySelector(".desktop-workspace-header")?.getAttribute("data-desktop-vue-island")).toBe("workspace-header");
    expect(host.querySelector("#desktop-workspace-status")?.textContent).toBe("0 files");

    const sourceTree = host.querySelector(".desktop-file-source-tree");
    expect(sourceTree?.getAttribute("aria-label")).toBe("File sources");
    expect(sourceTree?.textContent).toContain("Source Tree");
    expect([...host.querySelectorAll("[data-desktop-file-source]")].map((node) => node.getAttribute("data-desktop-file-source"))).toEqual([
      "session",
      "knowledge",
      "workspace",
    ]);
    expect(sourceTree?.textContent).toContain("Session Files");
    expect(sourceTree?.textContent).toContain("Knowledge Documents");
    expect(sourceTree?.textContent).toContain("Workspace Files");
    expect([...host.querySelectorAll(".desktop-file-scope-chip")].map((node) => node.textContent)).toEqual([
      "All",
      "Session",
      "Knowledge",
      "Workspace",
    ]);

    expect(host.querySelector(".desktop-workspace-browser")?.getAttribute("data-desktop-vue-island")).toBe("workspace-browser");
    expect(host.querySelector(".desktop-workspace-browser h3")?.textContent).toBe("Files");
    expect(host.querySelector<HTMLInputElement>("#desktop-workspace-search")?.getAttribute("aria-label")).toBe("Search workspace files");
    expect(host.querySelector("#desktop-workspace-recent-files")?.getAttribute("aria-label")).toBe("Recent workspace files");

    expect(host.querySelector(".desktop-workspace-detail-panel")?.getAttribute("data-desktop-vue-island")).toBe("workspace-detail");
    expect(host.querySelector(".desktop-workspace-detail-panel")?.textContent).toContain("No workspace file selected.");
    expect(host.querySelector(".desktop-workspace-editor-panel")?.getAttribute("data-desktop-vue-island")).toBe("workspace-editor");
    expect(host.querySelector<HTMLTextAreaElement>("#desktop-workspace-editor")?.getAttribute("aria-label")).toBe("Workspace file editor");

    expect(host.querySelector(".desktop-workspace-action-rail")?.getAttribute("data-desktop-vue-island")).toBe("workspace-actions");
    expect(host.querySelector(".desktop-workspace-action-rail")?.getAttribute("aria-label")).toBe("Workspace file actions");
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-save")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-reveal")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-export")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#desktop-workspace-reload")?.disabled).toBe(true);
    expect(host.querySelector("#desktop-workspace-save-state")?.textContent).toBe("Select a workspace file");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
