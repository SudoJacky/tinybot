// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountWorkspaceFilesSurfaceIsland } from "./workspaceFilesSurfaceIsland";

describe("workspace files surface Vue island", () => {
  test("renders the workspace files shell with stable desktop selectors", () => {
    const host = document.createElement("section");

    const mounted = mountWorkspaceFilesSurfaceIsland(host);

    expect(host.className).toBe("desktop-workspace-files");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("workspace-files-surface");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("workspace");
    expect(host.getAttribute("data-desktop-workspace-layout")).toBe("browser-detail-actions");

    expect(host.querySelector(".desktop-workspace-header")?.textContent).toContain("Workspace files");
    expect(host.querySelector("#desktop-workspace-status")?.textContent).toBe("0 files");

    expect(host.querySelector(".desktop-workspace-browser h3")?.textContent).toBe("Files");
    expect(host.querySelector<HTMLInputElement>("#desktop-workspace-search")?.getAttribute("aria-label")).toBe("Search workspace files");
    expect(host.querySelector("#desktop-workspace-recent-files")?.getAttribute("aria-label")).toBe("Recent workspace files");

    expect(host.querySelector(".desktop-workspace-detail-panel")?.textContent).toContain("No workspace file selected.");
    expect(host.querySelector<HTMLTextAreaElement>("#desktop-workspace-editor")?.getAttribute("aria-label")).toBe("Workspace file editor");

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
