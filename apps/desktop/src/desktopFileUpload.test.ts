import { describe, expect, test } from "vitest";
import {
  buildDesktopKnowledgeUploadForm,
  buildDesktopSessionTemporaryUploadForm,
  buildDesktopWorkspaceImport,
  buildDesktopUploadFile,
  classifyDesktopDroppedFiles,
  desktopUploadPickerOptions,
  handleDesktopDroppedFiles,
  installDesktopFileUploadActions,
  normalizeDesktopSessionTemporaryFiles,
  renderDesktopSessionTemporaryFiles,
} from "./desktopFileUpload";
import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";

describe("desktop file upload adapters", () => {
  const pickedFile = {
    name: "notes.md",
    path: "C:\\Users\\tinybot\\Documents\\notes.md",
    mime_type: "text/markdown",
    size_bytes: 11,
    bytes: [...new TextEncoder().encode("hello world")],
  };

  test("uses native picker options for knowledge and session upload targets", () => {
    expect(desktopUploadPickerOptions("knowledge-document")).toEqual({
      title: "Import knowledge document",
      filters: [
        {
          name: "Knowledge documents",
          extensions: ["md", "markdown", "txt", "pdf", "docx", "csv", "json"],
        },
      ],
    });
    expect(desktopUploadPickerOptions("session-temporary-file")).toEqual({
      title: "Attach temporary session file",
      filters: [{ name: "Session files", extensions: ["md", "txt", "pdf", "docx", "csv", "json", "png", "jpg", "jpeg"] }],
    });
    expect(desktopUploadPickerOptions("workspace-file")).toEqual({
      title: "Import workspace file",
      filters: [
        {
          name: "Workspace files",
          extensions: ["md", "markdown", "txt", "json", "csv", "py", "js", "ts", "tsx", "jsx", "html", "css", "yaml", "yml", "toml"],
        },
      ],
    });
  });

  test("converts an explicitly selected native file into a browser File", async () => {
    const file = buildDesktopUploadFile(pickedFile);

    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("notes.md");
    expect(file.type).toBe("text/markdown");
    expect(file.size).toBe(11);
    expect(await file.text()).toBe("hello world");
  });

  test("builds root WebUI compatible knowledge upload FormData", () => {
    const form = buildDesktopKnowledgeUploadForm(pickedFile, { category: "docs", tags: "desktop, native" });

    expect(form.get("file")).toBeInstanceOf(File);
    expect((form.get("file") as File).name).toBe("notes.md");
    expect(form.get("category")).toBe("docs");
    expect(form.get("tags")).toBe("desktop, native");
  });

  test("builds root WebUI compatible session temporary upload FormData", () => {
    const form = buildDesktopSessionTemporaryUploadForm(pickedFile);

    expect(form.get("file")).toBeInstanceOf(File);
    expect((form.get("file") as File).name).toBe("notes.md");
    expect([...form.keys()]).toEqual(["file"]);
  });

  test("keeps knowledge upload binding after the upload control is replaced", async () => {
    const targetDocument = createUploadTestDocument();
    const status = targetDocument.createElement("p");
    status.setAttribute("id", "desktop-file-upload-status");
    const button = targetDocument.createElement("button");
    button.setAttribute("id", "desktop-knowledge-upload");
    targetDocument.body.append(button, status);
    const pickedKinds: string[] = [];
    const uploadedNames: string[] = [];

    const install = () => installDesktopFileUploadActions({
      targetDocument: targetDocument as unknown as Document,
      pickFile: async (kind) => {
        pickedKinds.push(kind);
        return pickedFile;
      },
      uploadKnowledgeDocument: async (form) => {
        uploadedNames.push((form.get("file") as File).name);
      },
      uploadSessionTemporaryFile: async () => undefined,
    });

    install();
    install();
    targetDocument.querySelector("#desktop-knowledge-upload")?.click();
    await flushPromises();

    const nextButton = targetDocument.createElement("button");
    nextButton.setAttribute("id", "desktop-knowledge-upload");
    targetDocument.body.replaceChildren(nextButton, status);
    install();
    targetDocument.querySelector("#desktop-knowledge-upload")?.click();
    await flushPromises();

    expect(pickedKinds).toEqual(["knowledge-document", "knowledge-document"]);
    expect(uploadedNames).toEqual(["notes.md", "notes.md"]);
  });

  test("classifies accepted and rejected dropped files for knowledge imports", () => {
    const accepted = new File(["# notes"], "notes.md", { type: "text/markdown" });
    const rejected = new File(["binary"], "installer.exe", { type: "application/x-msdownload" });

    const result = classifyDesktopDroppedFiles("knowledge-document", [accepted, rejected]);

    expect(result.accepted.map((file) => file.name)).toEqual(["notes.md"]);
    expect(result.rejected).toEqual([{ name: "installer.exe", reason: "Unsupported file type for knowledge import" }]);
  });

  test("rejects dropped session files until a session key is available", () => {
    const result = classifyDesktopDroppedFiles("session-temporary-file", [
      new File(["hello"], "context.txt", { type: "text/plain" }),
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name: "context.txt", reason: "Select a session before attaching temporary files" }]);
  });

  test("validates unsupported dropped file types per desktop target", () => {
    const workspace = classifyDesktopDroppedFiles("workspace-file", [
      new File(["binary"], "malware.exe", { type: "application/x-msdownload" }),
      new File(["{}"], "config.json", { type: "application/json" }),
    ]);
    const session = classifyDesktopDroppedFiles(
      "session-temporary-file",
      [new File(["shell"], "script.sh", { type: "text/x-shellscript" })],
      { sessionKey: "WebSocket:chat-1" },
    );

    expect(workspace.accepted.map((file) => file.name)).toEqual(["config.json"]);
    expect(workspace.rejected).toEqual([{ name: "malware.exe", reason: "Unsupported file type for workspace import" }]);
    expect(session.accepted).toEqual([]);
    expect(session.rejected).toEqual([{ name: "script.sh", reason: "Unsupported file type for session attachment" }]);
  });

  test("builds a workspace import payload without preserving the source directory", async () => {
    const payload = await buildDesktopWorkspaceImport(new File(["draft"], "D:\\private\\draft.md", { type: "text/markdown" }));

    expect(payload).toEqual({
      path: "draft.md",
      body: {
        content: "draft",
        expected_updated_at: null,
      },
    });
  });

  test("normalizes and renders active session temporary files", () => {
    const payload = {
      files: [
        {
          id: "file-1",
          path: "C:\\tmp\\context.txt",
          status: "indexed",
          size_bytes: 1536,
          mime_type: "text/plain",
          updated_at: "2026-06-03T09:00:00.000Z",
          actions: ["download"],
        },
      ],
    };
    expect(normalizeDesktopSessionTemporaryFiles(payload)).toHaveLength(1);
    const targetDocument = createUploadTestDocument();
    const list = targetDocument.createElement("div");
    list.setAttribute("id", "desktop-session-file-list");
    targetDocument.body.append(list);

    const rendered = renderDesktopSessionTemporaryFiles(targetDocument as unknown as Document, "WebSocket:chat-1", payload);

    expect(rendered).toEqual([{
      id: "file-1",
      name: "context.txt",
      status: "indexed",
      sizeBytes: 1536,
      mimeType: "text/plain",
      updatedAt: "2026-06-03T09:00:00.000Z",
      actions: ["download"],
    }]);
    expect(targetDocument.querySelector("#desktop-session-file-list")?.dataset.fileCount).toBe("1");
    expect(targetDocument.body.textContent).toContain("context.txt - indexed / text/plain / 1.5 KiB / 2026-06-03T09:00:00.000Z - download");
  });

  test("refreshes session temporary file list on install, session change, and upload success", async () => {
    const targetDocument = createUploadTestDocument();
    const input = targetDocument.createElement("input");
    input.setAttribute("id", "desktop-session-upload-key");
    input.value = "WebSocket:chat-1";
    const button = targetDocument.createElement("button");
    button.setAttribute("id", "desktop-session-file-upload");
    const status = targetDocument.createElement("p");
    status.setAttribute("id", "desktop-file-upload-status");
    const list = targetDocument.createElement("div");
    list.setAttribute("id", "desktop-session-file-list");
    targetDocument.body.append(input, button, status, list);
    const listedSessionKeys: string[] = [];
    const uploadedSessionKeys: string[] = [];

    installDesktopFileUploadActions({
      targetDocument: targetDocument as unknown as Document,
      pickFile: async () => pickedFile,
      uploadKnowledgeDocument: async () => ({}),
      uploadSessionTemporaryFile: async (sessionKey) => {
        uploadedSessionKeys.push(sessionKey);
      },
      listSessionTemporaryFiles: async (sessionKey) => {
        listedSessionKeys.push(sessionKey);
        return {
          files: [{ id: `${sessionKey}:context`, name: `${sessionKey}.txt`, status: "available" }],
        };
      },
      getSessionKey: () => targetDocument.querySelector("#desktop-session-upload-key")?.value ?? "",
    });

    await flushPromises();
    targetDocument.dispatchEvent({
      type: "tinybot:desktop-session-key-changed",
      detail: { sessionKey: "WebSocket:chat-2" },
    });
    await flushPromises();
    targetDocument.querySelector("#desktop-session-file-upload")?.click();
    await flushPromises();

    expect(listedSessionKeys).toEqual(["WebSocket:chat-1", "WebSocket:chat-2", "WebSocket:chat-1"]);
    expect(uploadedSessionKeys).toEqual(["WebSocket:chat-1"]);
    expect(targetDocument.querySelector("#desktop-session-file-list")?.dataset.fileCount).toBe("1");
    expect(targetDocument.querySelector("#desktop-session-file-list")?.textContent).toContain("WebSocket:chat-1.txt");
    expect(targetDocument.querySelector("#desktop-file-upload-status")?.textContent).toContain("Attached notes.md to WebSocket:chat-1.");
  });

  test("imports a picked workspace file when the workspace import target is clicked", async () => {
    const targetDocument = createUploadTestDocument();
    const workspace = targetDocument.createElement("a");
    workspace.setAttribute("id", "desktop-workspace-file-drop");
    const status = targetDocument.createElement("p");
    status.setAttribute("id", "desktop-file-upload-status");
    targetDocument.body.append(workspace, status);
    const pickedKinds: string[] = [];
    const workspaceWrites: { path: string; body: unknown }[] = [];
    const importedPaths: string[] = [];

    installDesktopFileUploadActions({
      targetDocument: targetDocument as unknown as Document,
      pickFile: async (kind) => {
        pickedKinds.push(kind);
        return pickedFile;
      },
      uploadKnowledgeDocument: async () => ({}),
      uploadSessionTemporaryFile: async () => undefined,
      uploadWorkspaceFile: async (path, body) => {
        workspaceWrites.push({ path, body });
      },
      onWorkspaceFileImported: async (path) => {
        importedPaths.push(path);
      },
    });

    targetDocument.querySelector("#desktop-workspace-file-drop")?.click();
    await flushPromises();
    await flushPromises();

    expect(pickedKinds).toEqual(["workspace-file"]);
    expect(workspaceWrites).toEqual([{ path: "notes.md", body: { content: "hello world", expected_updated_at: null } }]);
    expect(importedPaths).toEqual(["notes.md"]);
    expect(targetDocument.querySelector("#desktop-file-upload-status")?.textContent).toContain("Imported notes.md into workspace.");
  });

  test("routes dropped files through the matching gateway contracts with accepted and rejected feedback", async () => {
    const knowledgeFormBodies: FormData[] = [];
    const sessionFormBodies: FormData[] = [];
    const workspaceWrites: { path: string; body: unknown }[] = [];
    const knowledgeTaskUpdates: DesktopTaskSourceOperation[] = [];

    const knowledge = await handleDesktopDroppedFiles({
      targetKind: "knowledge-document",
      files: [
        new File(["# notes"], "notes.md", { type: "text/markdown" }),
        new File(["bad"], "bad.exe", { type: "application/x-msdownload" }),
      ],
      uploadKnowledgeDocument: async (form) => {
        knowledgeFormBodies.push(form);
        return {
          id: "doc-1",
          name: (form.get("file") as File).name,
          message: "File uploaded; knowledge indexing is running",
          job_id: "kjob_upload",
          job: {
            id: "kjob_upload",
            doc_id: "doc-1",
            name: (form.get("file") as File).name,
            status: "queued",
            stage: "queued",
            message: "Queued for knowledge graph indexing",
            processed: 0,
            total: 1,
          },
        };
      },
      uploadSessionTemporaryFile: async (_sessionKey, form) => {
        sessionFormBodies.push(form);
      },
      uploadWorkspaceFile: async (path, body) => {
        workspaceWrites.push({ path, body });
      },
      onKnowledgeTaskUpdated: (operation) => {
        knowledgeTaskUpdates.push(operation);
      },
    });

    const session = await handleDesktopDroppedFiles({
      targetKind: "session-temporary-file",
      sessionKey: "WebSocket:chat-1",
      files: [new File(["session"], "context.txt", { type: "text/plain" })],
      uploadKnowledgeDocument: async (form) => {
        knowledgeFormBodies.push(form);
      },
      uploadSessionTemporaryFile: async (_sessionKey, form) => {
        sessionFormBodies.push(form);
      },
      uploadWorkspaceFile: async (path, body) => {
        workspaceWrites.push({ path, body });
      },
    });

    const workspace = await handleDesktopDroppedFiles({
      targetKind: "workspace-file",
      files: [new File(["draft"], "draft.md", { type: "text/markdown" })],
      uploadKnowledgeDocument: async (form) => {
        knowledgeFormBodies.push(form);
      },
      uploadSessionTemporaryFile: async (_sessionKey, form) => {
        sessionFormBodies.push(form);
      },
      uploadWorkspaceFile: async (path, body) => {
        workspaceWrites.push({ path, body });
      },
    });

    expect((knowledgeFormBodies[0].get("file") as File).name).toBe("notes.md");
    expect((sessionFormBodies[0].get("file") as File).name).toBe("context.txt");
    expect(workspaceWrites).toEqual([{ path: "draft.md", body: { content: "draft", expected_updated_at: null } }]);
    expect(knowledge.summary).toContain("Accepted 1 file");
    expect(knowledge.summary).toContain("Rejected 1 file");
    expect(session.summary).toContain("Attached 1 session file");
    expect(workspace.summary).toContain("Imported 1 workspace file");
    expect(knowledgeTaskUpdates).toEqual([
      {
        id: "knowledge:upload:notes.md",
        title: "Upload notes.md",
        status: "uploading",
        detail: "Uploading knowledge document",
        progress: { completed: 0, total: 1 },
        canonical: { module: "knowledge", entityId: "notes.md", href: "/knowledge" },
        diagnostics: "",
        retryable: false,
        updatedAt: "",
      },
      {
        id: "knowledge:kjob_upload",
        title: "Index notes.md",
        status: "queued",
        detail: "Queued for knowledge graph indexing / queued",
        progress: { completed: 0, total: 1 },
        canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        diagnostics: "",
        relatedResources: [
          {
            kind: "evidence",
            id: "knowledge-source:doc-1",
            title: "notes.md",
            detail: "queued",
            route: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
          },
        ],
        outputs: [],
        retryable: false,
        updatedAt: "",
      },
    ]);
  });
});

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class UploadTestElement {
  public id = "";
  public value = "";
  public className = "";
  public dataset: Record<string, string> = {};
  public children: UploadTestElement[] = [];
  private ownTextContent = "";
  private listeners = new Map<string, ((event: { type: string; detail?: unknown; preventDefault?: () => void }) => void)[]>();
  private attributes = new Map<string, string>();

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
  }

  append(...children: UploadTestElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: UploadTestElement[]): void {
    this.children = children;
    this.ownTextContent = "";
  }

  addEventListener(type: string, listener: (event: { type: string; detail?: unknown; preventDefault?: () => void }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(event: { type: string; detail?: unknown; preventDefault?: () => void }): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: "click", preventDefault: () => undefined });
  }

  querySelector(selector: string): UploadTestElement | null {
    if (selector.startsWith("#") && this.id === selector.slice(1)) {
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

  querySelectorAll(selector: string): UploadTestElement[] {
    const matches: UploadTestElement[] = [];
    if (selector === "[data-desktop-drop-target]" && this.attributes.has("data-desktop-drop-target")) {
      matches.push(this);
    }
    if (selector.startsWith("#") && this.id === selector.slice(1)) {
      matches.push(this);
    }
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
}

class UploadTestDocument {
  public documentElement = new UploadTestElement("html");
  public body = new UploadTestElement("body");
  private listeners = new Map<string, ((event: { type: string; detail?: unknown }) => void)[]>();

  createElement(tagName: string): UploadTestElement {
    return new UploadTestElement(tagName);
  }

  querySelector(selector: string): UploadTestElement | null {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector: string): UploadTestElement[] {
    return this.body.querySelectorAll(selector);
  }

  addEventListener(type: string, listener: (event: { type: string; detail?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(event: { type: string; detail?: unknown }): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }
}

function createUploadTestDocument(): UploadTestDocument {
  return new UploadTestDocument();
}
