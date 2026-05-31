import { describe, expect, test } from "vitest";
import {
  buildDesktopKnowledgeUploadForm,
  buildDesktopSessionTemporaryUploadForm,
  buildDesktopWorkspaceImport,
  buildDesktopUploadFile,
  classifyDesktopDroppedFiles,
  desktopUploadPickerOptions,
  handleDesktopDroppedFiles,
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
        retryable: false,
        updatedAt: "",
      },
    ]);
  });
});
