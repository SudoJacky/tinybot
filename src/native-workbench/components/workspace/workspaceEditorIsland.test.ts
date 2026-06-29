// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopWorkspaceFileState } from "../../workspace/desktopWorkspaceFiles";
import { mountWorkspaceEditorIsland } from "./workspaceEditorIsland";

const state: DesktopWorkspaceFileState = {
  files: [],
  recentPaths: [],
  activePath: "AGENTS.md",
  activeUpdatedAt: "2026-05-31T10:00:00+00:00",
  activeSizeBytes: 128,
  draft: "# Rules\n",
  savedDraft: "# Rules\n",
  dirty: false,
  saveState: "idle",
  error: null,
  exportedPath: null,
  searchQuery: "",
};

describe("workspace editor Vue island", () => {
  test("renders the workspace editor and emits draft input", async () => {
    const host = document.createElement("section");
    const drafts: string[] = [];

    const mounted = mountWorkspaceEditorIsland(host, {
      state,
      onDraftInput: (draft) => drafts.push(draft),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("workspace-editor");
    expect(host.className).toContain("desktop-workspace-editor-panel");
    expect(host.textContent).toContain("Editor");

    const editor = host.querySelector<HTMLTextAreaElement>("#desktop-workspace-editor");
    expect(editor?.className).toContain("desktop-workspace-editor");
    expect(editor?.getAttribute("aria-label")).toBe("Workspace file editor");
    expect(editor?.value).toBe("# Rules\n");

    editor!.value = "# Rules\n\nUse uv.\n";
    editor?.dispatchEvent(new Event("input", { bubbles: true }));
    expect(drafts).toEqual(["# Rules\n\nUse uv.\n"]);

    mounted.update({ ...state, draft: "# Updated\n" });
    await nextTick();
    expect(host.querySelector<HTMLTextAreaElement>("#desktop-workspace-editor")?.value).toBe("# Updated\n");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
