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
    typeLabel: "MD",
    sizeLabel: "86 KB",
    addedLabel: "2026-06-05 08:00",
    tags: ["desktop", "ux"],
    chunkCount: 4,
    status: "indexed",
    phaseLabel: "Indexed",
    progressPercent: 100,
    progressDetail: "4 chunks indexed",
    updatedAt: "2026-06-05T08:00:00Z",
    meta: "indexed / 4 chunks",
  },
  {
    id: "",
    title: "Inbox note",
    path: "notes/inbox.md",
    category: "notes",
    typeLabel: "MD",
    sizeLabel: "12 KB",
    addedLabel: "Not indexed",
    tags: [],
    chunkCount: 1,
    status: "queued",
    phaseLabel: "Queued",
    progressPercent: 0,
    progressDetail: "Waiting for parser",
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
    expect(host.querySelector("[data-desktop-knowledge-document-search]")?.getAttribute("placeholder")).toBe("Search documents...");
    expect(host.querySelector("[data-desktop-knowledge-document-filter]")?.textContent).toContain("Filter");
    expect(host.querySelector("[data-desktop-knowledge-documents-table]")?.textContent).toContain("Name");
    expect(host.querySelector("[data-desktop-knowledge-documents-table]")?.textContent).toContain("Actions");
    const first = host.querySelector<HTMLElement>('[data-desktop-entity-id="doc-1"]');
    const second = host.querySelector<HTMLElement>('[data-desktop-entity-id="notes/inbox.md"]');
    expect(first?.getAttribute("data-desktop-entity-module")).toBe("knowledge");
    expect(first?.textContent).toContain("Desktop UX");
    expect(first?.textContent).toContain("MD");
    expect(first?.textContent).toContain("86 KB");
    expect(first?.textContent).toContain("indexed");
    expect(first?.textContent).toContain("Delete");
    expect(second?.getAttribute("data-desktop-entity-module")).toBe("knowledge");
    expect(second?.textContent).toContain("Inbox note");
    expect(second?.textContent).toContain("queued");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
