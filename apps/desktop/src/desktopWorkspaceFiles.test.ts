import { describe, expect, test } from "vitest";
import {
  applyDesktopWorkspaceDraft,
  buildDesktopWorkspaceFileRows,
  buildDesktopWorkspaceRevealRequest,
  buildDesktopWorkspaceSaveRequest,
  createDesktopWorkspaceFileState,
  installDesktopWorkspaceFileActions,
  normalizeDesktopWorkspaceRevealError,
  normalizeDesktopWorkspaceSaveError,
  updateDesktopWorkspaceRecentFiles,
} from "./desktopWorkspaceFiles";
import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";

class FakeElement {
  public id = "";
  public className = "";
  public children: FakeElement[] = [];
  public attributes = new Map<string, string>();
  public disabled = false;
  public value = "";
  private ownTextContent = "";
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(public readonly tagName: string) {}

  set textContent(value: string) {
    this.ownTextContent = value;
  }

  get textContent(): string {
    return `${this.ownTextContent}${this.children.map((child) => child.textContent).join("")}`;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") {
      this.id = value;
    }
    if (name === "class") {
      this.className = value;
    }
    if (name === "disabled") {
      this.disabled = true;
    }
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "disabled") {
      this.disabled = false;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(type: string, event: unknown = { target: this }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  click(): void {
    this.dispatchEvent("click", { target: this });
  }

  querySelector(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) {
      return this;
    }
    for (const child of this.children) {
      const match = child.querySelector(selector);
      if (match) {
        return match;
      }
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = matchesSelector(this, selector) ? [this] : [];
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  closest(selector: string): FakeElement | null {
    return matchesSelector(this, selector) ? this : null;
  }
}

class FakeDocument {
  public body = new FakeElement("body");

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.body.querySelector(`#${id}`);
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) {
    return element.id === selector.slice(1);
  }
  if (selector.startsWith(".")) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  const dataWorkspace = selector.match(/^\[data-desktop-workspace-file\]$/);
  if (dataWorkspace) {
    return element.attributes.has("data-desktop-workspace-file");
  }
  return false;
}

function createWorkspaceShell(targetDocument: FakeDocument): void {
  const root = targetDocument.createElement("section");
  for (const id of [
    "desktop-workspace-status",
    "desktop-workspace-recent-files",
    "desktop-workspace-active-path",
    "desktop-workspace-updated-at",
    "desktop-workspace-detail",
    "desktop-workspace-save-state",
    "desktop-workspace-error",
  ]) {
    const element = targetDocument.createElement("div");
    element.setAttribute("id", id);
    root.append(element);
  }
  const editor = targetDocument.createElement("textarea");
  editor.setAttribute("id", "desktop-workspace-editor");
  root.append(editor);
  const save = targetDocument.createElement("button");
  save.setAttribute("id", "desktop-workspace-save");
  root.append(save);
  const reveal = targetDocument.createElement("button");
  reveal.setAttribute("id", "desktop-workspace-reveal");
  root.append(reveal);
  const exportButton = targetDocument.createElement("button");
  exportButton.setAttribute("id", "desktop-workspace-export");
  root.append(exportButton);
  targetDocument.body.append(root);
}

describe("desktop workspace file adapter", () => {
  test("projects workspace rows and keeps recent files most-recent first", () => {
    const rows = buildDesktopWorkspaceFileRows({
      items: [
        { path: "AGENTS.md", exists: true, updated_at: "2026-05-31T10:00:00+00:00" },
        { path: "notes/todo.md", exists: false, updated_at: null },
      ],
    });

    expect(rows).toEqual([
      { path: "AGENTS.md", exists: true, updatedAt: "2026-05-31T10:00:00+00:00", meta: "Updated 2026-05-31T10:00:00+00:00" },
      { path: "notes/todo.md", exists: false, updatedAt: null, meta: "Not created" },
    ]);
    expect(updateDesktopWorkspaceRecentFiles(["AGENTS.md", "notes/todo.md"], "docs/readme.md", 2)).toEqual([
      "docs/readme.md",
      "AGENTS.md",
    ]);
  });

  test("tracks active path, dirty state, save payload, and saved state", () => {
    let state = createDesktopWorkspaceFileState();
    state = createDesktopWorkspaceFileState(state, {
      path: "AGENTS.md",
      content: "# Rules\n",
      updated_at: "2026-05-31T10:00:00+00:00",
      exists: true,
    });

    expect(state.activePath).toBe("AGENTS.md");
    expect(state.dirty).toBe(false);
    expect(state.saveState).toBe("idle");
    expect(state.recentPaths).toEqual(["AGENTS.md"]);

    state = applyDesktopWorkspaceDraft(state, "# Rules\n\nUse uv.\n");

    expect(state.dirty).toBe(true);
    expect(state.saveState).toBe("dirty");
    expect(buildDesktopWorkspaceSaveRequest(state)).toEqual({
      path: "AGENTS.md",
      body: {
        content: "# Rules\n\nUse uv.\n",
        expected_updated_at: "2026-05-31T10:00:00+00:00",
      },
    });
    expect(buildDesktopWorkspaceRevealRequest(state)).toEqual({ path: "AGENTS.md" });

    state = createDesktopWorkspaceFileState(state, {
      path: "AGENTS.md",
      content: "# Rules\n\nUse uv.\n",
      updated_at: "2026-05-31T10:02:00+00:00",
      exists: true,
    });

    expect(state.dirty).toBe(false);
    expect(state.saveState).toBe("saved");
    expect(state.activeUpdatedAt).toBe("2026-05-31T10:02:00+00:00");
  });

  test("normalizes protected path and conflict errors without discarding the draft", () => {
    const state = applyDesktopWorkspaceDraft(
      createDesktopWorkspaceFileState(undefined, {
        path: "AGENTS.md",
        content: "original",
        updated_at: "2026-05-31T10:00:00+00:00",
        exists: true,
      }),
      "draft",
    );

    expect(normalizeDesktopWorkspaceSaveError(new Error("Gateway request failed: HTTP 404 file is not editable"), state)).toMatchObject({
      saveState: "protected-path-error",
      dirty: true,
      draft: "draft",
      error: "This path is not editable from the desktop workspace.",
    });
    expect(normalizeDesktopWorkspaceSaveError(new Error("Gateway request failed: HTTP 409"), state)).toMatchObject({
      saveState: "conflict-error",
      dirty: true,
      draft: "draft",
      error: "Workspace file changed outside this editor. Reload before saving.",
    });
    expect(normalizeDesktopWorkspaceRevealError(new Error("workspace file is not revealable"), state)).toMatchObject({
      saveState: "protected-path-error",
      dirty: true,
      draft: "draft",
      error: "This path cannot be revealed from the desktop workspace.",
    });
  });

  test("renders recent files, active path, dirty state, save state, reveal action, and protected-path errors in the shell", async () => {
    const targetDocument = new FakeDocument();
    createWorkspaceShell(targetDocument);
    const saved: { path: string; body: unknown }[] = [];
    const revealed: string[] = [];
    const exported: { path: string; contents: string }[] = [];
    const fileTaskUpdates: DesktopTaskSourceOperation[] = [];

    installDesktopWorkspaceFileActions({
      targetDocument: targetDocument as unknown as Document,
      listWorkspaceFiles: async () => ({
        items: [{ path: "AGENTS.md", exists: true, updated_at: "2026-05-31T10:00:00+00:00" }],
      }),
      loadWorkspaceFile: async (path) => ({
        path,
        content: "# Rules\n",
        updated_at: "2026-05-31T10:00:00+00:00",
        exists: true,
      }),
      saveWorkspaceFile: async (path, body) => {
        saved.push({ path, body });
        if (path === "AGENTS.md") {
          throw new Error("Gateway request failed: HTTP 404 file is not editable");
        }
        return { path, saved: true, updated_at: "2026-05-31T10:05:00+00:00" };
      },
      revealWorkspaceFile: async (path) => {
        revealed.push(path);
      },
      exportWorkspaceFile: async (request) => {
        exported.push({ path: request.defaultPath, contents: request.contents });
        return { path: `D:/exports/${request.defaultPath}` };
      },
      onFileTaskUpdated: (operation) => fileTaskUpdates.push(operation),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const button = targetDocument.body.querySelector("[data-desktop-workspace-file]");
    expect(button?.textContent).toContain("AGENTS.md");

    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(targetDocument.getElementById("desktop-workspace-status")?.textContent).toContain("1 file");
    expect(targetDocument.getElementById("desktop-workspace-active-path")?.textContent).toContain("AGENTS.md");
    expect(targetDocument.getElementById("desktop-workspace-updated-at")?.textContent).toContain("2026-05-31T10:00:00+00:00");
    expect(targetDocument.getElementById("desktop-workspace-detail")?.textContent).toContain("AGENTS.md");
    expect(targetDocument.getElementById("desktop-workspace-reveal")?.disabled).toBe(false);
    targetDocument.getElementById("desktop-workspace-reveal")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revealed).toEqual(["AGENTS.md"]);

    const editor = targetDocument.getElementById("desktop-workspace-editor");
    editor!.value = "# Rules\n\nUse uv.\n";
    editor!.dispatchEvent("input", { target: editor });

    expect(targetDocument.getElementById("desktop-workspace-save-state")?.textContent).toContain("Unsaved changes");
    expect(targetDocument.getElementById("desktop-workspace-save")?.disabled).toBe(false);
    expect(targetDocument.getElementById("desktop-workspace-export")?.disabled).toBe(false);

    targetDocument.getElementById("desktop-workspace-export")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(exported).toEqual([{ path: "AGENTS.md", contents: "# Rules\n\nUse uv.\n" }]);
    expect(targetDocument.getElementById("desktop-workspace-save-state")?.textContent).toContain("Exported to D:/exports/AGENTS.md");

    targetDocument.getElementById("desktop-workspace-save")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(saved[0]).toEqual({
      path: "AGENTS.md",
      body: {
        content: "# Rules\n\nUse uv.\n",
        expected_updated_at: "2026-05-31T10:00:00+00:00",
      },
    });
    expect(targetDocument.getElementById("desktop-workspace-error")?.textContent).toContain("not editable");
    expect(targetDocument.getElementById("desktop-workspace-detail")?.textContent).toContain("Protected path blocked");
    expect((targetDocument.getElementById("desktop-workspace-editor") as FakeElement).value).toBe("# Rules\n\nUse uv.\n");
    expect(fileTaskUpdates.map((operation) => [operation.id, operation.status, operation.title, operation.diagnostics])).toEqual([
      ["file:workspace:AGENTS.md:export", "exporting", "Export AGENTS.md", ""],
      ["file:workspace:AGENTS.md:export", "completed", "Export AGENTS.md", ""],
      ["file:workspace:AGENTS.md:save", "saving", "Save AGENTS.md", ""],
      ["file:workspace:AGENTS.md:save", "failed", "Save AGENTS.md", "Gateway request failed: HTTP 404 file is not editable"],
    ]);
  });

  test("shows export failures without discarding unsaved workspace drafts", async () => {
    const targetDocument = new FakeDocument();
    createWorkspaceShell(targetDocument);

    installDesktopWorkspaceFileActions({
      targetDocument: targetDocument as unknown as Document,
      listWorkspaceFiles: async () => ({
        items: [{ path: "AGENTS.md", exists: true, updated_at: "2026-05-31T10:00:00+00:00" }],
      }),
      loadWorkspaceFile: async (path) => ({
        path,
        content: "# Rules\n",
        updated_at: "2026-05-31T10:00:00+00:00",
        exists: true,
      }),
      saveWorkspaceFile: async () => ({ saved: true }),
      exportWorkspaceFile: async () => {
        throw new Error("save dialog failed");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    targetDocument.body.querySelector("[data-desktop-workspace-file]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const editor = targetDocument.getElementById("desktop-workspace-editor");
    editor!.value = "# Rules\n\nDraft export.\n";
    editor!.dispatchEvent("input", { target: editor });

    targetDocument.getElementById("desktop-workspace-export")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(targetDocument.getElementById("desktop-workspace-error")?.textContent).toContain("save dialog failed");
    expect((targetDocument.getElementById("desktop-workspace-editor") as FakeElement).value).toBe("# Rules\n\nDraft export.\n");
  });
});
