// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopKnowledgeDocumentRow } from "../desktopKnowledgeTraceability";
import { mountKnowledgeDocumentsIsland } from "./knowledgeDocumentsIsland";

const documents: DesktopKnowledgeDocumentRow[] = [
  {
    id: "doc-1",
    title: "Desktop UX",
    path: "docs/desktop.md",
    category: "docs",
    tags: ["desktop", "ux"],
    chunkCount: 4,
    status: "indexed",
    updatedAt: "2026-06-05T08:00:00Z",
    meta: "indexed / 4 chunks",
  },
  {
    id: "",
    title: "Inbox note",
    path: "notes/inbox.md",
    category: "notes",
    tags: [],
    chunkCount: 1,
    status: "queued",
    updatedAt: "",
    meta: "queued / 1 chunk",
  },
];

describe("knowledge documents Vue island", () => {
  test("renders document rows with existing entity hooks and copy", () => {
    const host = document.createElement("section");

    const mounted = mountKnowledgeDocumentsIsland(host, { documents });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-documents");
    expect(host.className).toContain("desktop-knowledge-documents");
    expect(host.querySelector("h2")?.textContent).toBe("Documents");
    const first = host.querySelector<HTMLElement>('[data-desktop-entity-id="doc-1"]');
    const second = host.querySelector<HTMLElement>('[data-desktop-entity-id="notes/inbox.md"]');
    expect(first?.getAttribute("data-desktop-entity-module")).toBe("knowledge");
    expect(first?.textContent).toContain("Desktop UX: indexed / 4 chunks");
    expect(first?.textContent).toContain("desktop");
    expect(second?.getAttribute("data-desktop-entity-module")).toBe("knowledge");
    expect(second?.textContent).toContain("Inbox note: queued / 1 chunk");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
