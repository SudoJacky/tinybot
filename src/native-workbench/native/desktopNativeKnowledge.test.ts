import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeKnowledgeApi } from "./desktopNativeKnowledge";

describe("desktop native knowledge API", () => {
  test("maps knowledge state calls to Rust Tauri commands", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => ({ command, args }));
    const api = createDesktopNativeKnowledgeApi({ invoke });

    await expect(api.documents({ category: "desktop", limit: 5 })).resolves.toEqual({
      command: "worker_knowledge_documents",
      args: { input: { category: "desktop", limit: 5 } },
    });
    await expect(api.addDocument({ name: "notes.md", content: "hello", file_type: "md" })).resolves.toEqual({
      command: "worker_knowledge_add_document",
      args: { input: { body: { name: "notes.md", content: "hello", file_type: "md" } } },
    });
    await expect(api.document("doc-1")).resolves.toEqual({
      command: "worker_knowledge_document",
      args: { input: { docId: "doc-1" } },
    });
    await expect(api.deleteDocument("doc-1")).resolves.toEqual({
      command: "worker_knowledge_delete_document",
      args: { input: { docId: "doc-1" } },
    });
    await expect(api.job("kjob-1")).resolves.toEqual({
      command: "worker_knowledge_job",
      args: { input: { jobId: "kjob-1" } },
    });
    await expect(api.rebuildIndex("tree")).resolves.toEqual({
      command: "worker_knowledge_rebuild_index",
      args: { input: { rebuildType: "tree" } },
    });
    await expect(api.stats()).resolves.toEqual({
      command: "worker_knowledge_stats",
      args: undefined,
    });
    await expect(api.graph({ docId: "doc-1", graphType: "document", includeOrphans: true })).resolves.toEqual({
      command: "worker_knowledge_graph",
      args: { input: { docId: "doc-1", graphType: "document", includeOrphans: true } },
    });
  });
});
