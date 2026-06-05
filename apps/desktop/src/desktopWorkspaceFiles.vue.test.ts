// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { installDesktopWorkspaceFileActions } from "./desktopWorkspaceFiles";
import { mountWorkspaceFilesSurfaceIsland } from "./native-vue/workspaceFilesSurfaceIsland";

describe("desktop workspace files Vue integration", () => {
  test("mounts the recent files Vue island through the workspace action installer", async () => {
    document.body.innerHTML = `
      <input id="desktop-workspace-search" />
      <div id="desktop-workspace-status"></div>
      <div id="desktop-workspace-recent-files" aria-label="Recent workspace files"></div>
      <div id="desktop-workspace-active-path"></div>
      <div id="desktop-workspace-updated-at"></div>
      <div id="desktop-workspace-size"></div>
      <div id="desktop-workspace-detail"></div>
      <div id="desktop-workspace-save-state"></div>
      <div id="desktop-workspace-error"></div>
      <textarea id="desktop-workspace-editor"></textarea>
      <button id="desktop-workspace-save"></button>
      <button id="desktop-workspace-reveal"></button>
      <button id="desktop-workspace-reload"></button>
      <button id="desktop-workspace-export"></button>
    `;
    const loaded: string[] = [];

    installDesktopWorkspaceFileActions({
      targetDocument: document,
      listWorkspaceFiles: async () => ({
        items: [
          { path: "AGENTS.md", exists: true, updated_at: "2026-05-31T10:00:00+00:00" },
          { path: "docs/notes.md", exists: true, updated_at: null },
        ],
      }),
      loadWorkspaceFile: async (path) => {
        loaded.push(path);
        return {
          path,
          content: `# ${path}`,
          updated_at: "2026-05-31T10:00:00+00:00",
          exists: true,
        };
      },
      saveWorkspaceFile: async () => ({}),
    });

    await waitForWorkspaceIsland();
    const recent = document.querySelector<HTMLElement>("#desktop-workspace-recent-files");
    expect(recent?.getAttribute("data-desktop-vue-island")).toBe("workspace-recent-files");
    expect(Array.from(document.querySelectorAll("[data-desktop-workspace-file]")).map((row) => row.getAttribute("data-desktop-workspace-file"))).toEqual([
      "AGENTS.md",
      "docs/notes.md",
    ]);

    document.querySelector<HTMLButtonElement>('[data-desktop-workspace-file="docs/notes.md"]')?.click();
    await flushAsyncWork();

    expect(loaded).toEqual(["docs/notes.md"]);
    expect(document.querySelector("#desktop-workspace-active-path")?.textContent).toContain("docs/notes.md");
  }, 20_000);

  test("uses the workspace files surface island DOM with the action installer", async () => {
    const host = document.createElement("section");
    document.body.append(host);
    const loaded: string[] = [];

    mountWorkspaceFilesSurfaceIsland(host);
    installDesktopWorkspaceFileActions({
      targetDocument: document,
      listWorkspaceFiles: async () => ({
        items: [
          { path: "README.md", exists: true, updated_at: "2026-06-06T10:00:00+08:00" },
        ],
      }),
      loadWorkspaceFile: async (path) => {
        loaded.push(path);
        return {
          path,
          content: `# ${path}`,
          updated_at: "2026-06-06T10:00:00+08:00",
          exists: true,
        };
      },
      saveWorkspaceFile: async () => ({}),
      revealWorkspaceFile: async () => ({}),
    });

    await waitForWorkspaceIsland();

    expect(host.getAttribute("data-desktop-vue-island")).toBe("workspace-files-surface");
    expect(document.querySelector("#desktop-workspace-status")?.textContent).toContain("1 file");
    expect(document.querySelector<HTMLButtonElement>("#desktop-workspace-save")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#desktop-workspace-reveal")?.disabled).toBe(true);

    document.querySelector<HTMLButtonElement>('[data-desktop-workspace-file="README.md"]')?.click();
    await flushAsyncWork();

    expect(loaded).toEqual(["README.md"]);
    expect(document.querySelector("#desktop-workspace-active-path")?.textContent).toContain("README.md");
  }, 20_000);
});

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForWorkspaceIsland(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushAsyncWork();
    if (document.querySelector("#desktop-workspace-recent-files")?.getAttribute("data-desktop-vue-island") === "workspace-recent-files") {
      return;
    }
  }
  throw new Error("workspace recent files Vue island did not mount");
}
