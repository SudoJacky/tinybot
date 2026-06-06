// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopKnowledgePaneDocument } from "../desktopKnowledgeTraceability";
import { mountKnowledgeDocumentDetailIsland } from "./knowledgeDocumentDetailIsland";

const documentDetail: DesktopKnowledgePaneDocument = {
  id: "doc-1",
  title: "Desktop UX",
  path: "docs/desktop.md",
  category: "docs",
  tags: ["desktop", "ux"],
  chunkCount: 4,
  status: "indexed",
  updatedAt: "2026-06-05T08:00:00Z",
  meta: "indexed / 4 chunks",
  detail: "docs/desktop.md / indexed / 4 chunks",
};

describe("knowledge document detail Vue island", () => {
  test("renders selected document detail with existing desktop copy", () => {
    const host = document.createElement("section");

    const mounted = mountKnowledgeDocumentDetailIsland(host, { document: documentDetail });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-document-detail");
    expect(host.className).toContain("desktop-knowledge-document-detail");
    expect(host.querySelector("h2")?.textContent).toBe("Document detail: Desktop UX");
    expect(host.textContent).toContain("docs/desktop.md / indexed / 4 chunks");
    expect(host.textContent).toContain("Tags: desktop, ux");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("preserves the empty tag copy", () => {
    const host = document.createElement("section");

    const mounted = mountKnowledgeDocumentDetailIsland(host, {
      document: {
        ...documentDetail,
        tags: [],
      },
    });

    expect(host.textContent).toContain("Tags: none");

    mounted.unmount();
  });
});
