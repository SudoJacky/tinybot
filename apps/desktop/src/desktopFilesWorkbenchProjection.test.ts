import { describe, expect, test } from "vitest";
import {
  buildDesktopFilesWorkbenchProjection,
  type DesktopFilesWorkbenchSessionFile,
  type DesktopFilesWorkbenchKnowledgeDocument,
} from "./desktopFilesWorkbenchProjection";
import type { DesktopWorkspaceFileState } from "./desktopWorkspaceFiles";

const workspaceState: DesktopWorkspaceFileState = {
  files: [
    { path: "README.md", exists: true, updatedAt: "2026-06-01T08:00:00Z", meta: "12 KB" },
    { path: "src/app.ts", exists: true, updatedAt: "2026-06-02T09:00:00Z", meta: "4 KB" },
  ],
  recentPaths: ["src/app.ts", "README.md"],
  activePath: "src/app.ts",
  activeUpdatedAt: "2026-06-02T09:00:00Z",
  activeSizeBytes: 4096,
  draft: "const next = true;\n",
  savedDraft: "const next = false;\n",
  dirty: true,
  saveState: "conflict-error",
  error: "Workspace file changed outside this editor. Reload before saving.",
  exportedPath: null,
  searchQuery: "src",
};

const sessionFiles: DesktopFilesWorkbenchSessionFile[] = [
  {
    id: "session-readme",
    name: "session-readme.md",
    status: "ready",
    sizeBytes: 2048,
    mimeType: "text/markdown",
    updatedAt: "2026-06-02T08:00:00Z",
    actions: ["download", "remove"],
  },
];

const knowledgeDocuments: DesktopFilesWorkbenchKnowledgeDocument[] = [
  {
    id: "doc-native",
    title: "Native app overview",
    path: "NATIVE_APP_OVERVIEW.md",
    status: "indexed",
    references: 8,
    collection: "native-app",
  },
];

describe("desktop files workbench projection", () => {
  test("builds Session, Knowledge, and Workspace scope tabs with counts and active state", () => {
    const projection = buildDesktopFilesWorkbenchProjection({
      activeScope: "workspace",
      workspaceState,
      sessionFiles,
      knowledgeDocuments,
    });

    expect(projection.scopeTabs).toEqual([
      { id: "session", label: "Session", count: 1, active: false },
      { id: "knowledge", label: "Knowledge", count: 1, active: false },
      { id: "workspace", label: "Workspace", count: 2, active: true },
    ]);
  });

  test("projects toolbar filters, table columns, row actions, and selection state", () => {
    const projection = buildDesktopFilesWorkbenchProjection({
      activeScope: "workspace",
      workspaceState,
      sessionFiles,
      knowledgeDocuments,
      selectedIds: new Set(["workspace:src/app.ts"]),
    });

    expect(projection.toolbar).toEqual({
      scope: "workspace",
      searchQuery: "src",
      filters: ["all", "recent", "dirty", "conflicts"],
      actions: ["upload", "refresh", "promote-to-knowledge"],
    });
    expect(projection.table.columns).toEqual(["name", "scope", "status", "updated", "meta", "actions"]);
    expect(projection.table.rows).toEqual([
      expect.objectContaining({
        id: "workspace:README.md",
        selected: false,
        actions: ["open", "reveal", "promote-to-knowledge"],
      }),
      expect.objectContaining({
        id: "workspace:src/app.ts",
        selected: true,
        status: "dirty",
      }),
    ]);
  });

  test("projects detail pane metadata, preview, references, and scoped actions", () => {
    const projection = buildDesktopFilesWorkbenchProjection({
      activeScope: "workspace",
      workspaceState,
      sessionFiles,
      knowledgeDocuments,
    });

    expect(projection.detail).toEqual({
      id: "workspace:src/app.ts",
      title: "src/app.ts",
      scope: "workspace",
      metadata: ["4 KB", "Updated 2026-06-02T09:00:00Z", "Conflict"],
      preview: "const next = true;\n",
      references: [],
      actions: ["save", "reload", "reveal", "open-external", "promote-to-knowledge"],
    });
  });

  test("projects workspace editor dirty state, diff, save/reload, conflict, and reveal actions", () => {
    const projection = buildDesktopFilesWorkbenchProjection({
      activeScope: "workspace",
      workspaceState,
      sessionFiles,
      knowledgeDocuments,
    });

    expect(projection.editor).toEqual({
      activePath: "src/app.ts",
      dirty: true,
      saveState: "conflict-error",
      diff: {
        before: "const next = false;\n",
        after: "const next = true;\n",
      },
      conflict: {
        hasConflict: true,
        message: "Workspace file changed outside this editor. Reload before saving.",
      },
      actions: ["save", "reload", "reveal", "open-external"],
    });
  });

  test("projects upload destination and Promote to Knowledge job progress", () => {
    const projection = buildDesktopFilesWorkbenchProjection({
      activeScope: "session",
      workspaceState,
      sessionFiles,
      knowledgeDocuments,
      uploadJobs: [
        { id: "upload-1", destination: "session", label: "session-readme.md", progress: 50, state: "running" },
      ],
      promotionJobs: [
        {
          id: "promote-1",
          sourceId: "workspace:README.md",
          collection: "native-app",
          progress: 80,
          state: "running",
        },
      ],
    });

    expect(projection.uploadDestinations).toEqual([
      { id: "session", label: "Attach to Session", active: true },
      { id: "knowledge", label: "Import to Knowledge", active: false },
      { id: "workspace", label: "Import to Workspace", active: false },
    ]);
    expect(projection.jobs).toEqual([
      { id: "upload-1", label: "session-readme.md", destination: "session", progress: 50, state: "running" },
      {
        id: "promote-1",
        label: "Promote workspace:README.md to native-app",
        destination: "knowledge",
        progress: 80,
        state: "running",
      },
    ]);
  });
});
