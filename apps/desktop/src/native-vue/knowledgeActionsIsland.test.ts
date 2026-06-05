// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountKnowledgeActionsIsland, type KnowledgeActionItem } from "./knowledgeActionsIsland";

const actions: KnowledgeActionItem[] = [
  { action: "uploadDocument", label: "Upload document", enabled: true },
  { action: "runQuery", label: "Run query", enabled: true },
  { action: "deleteDocument", label: "Delete document", enabled: false },
];

describe("knowledge actions Vue island", () => {
  test("renders desktop action hooks and forwards enabled actions", () => {
    const host = document.createElement("div");
    const clicked: string[] = [];

    const mounted = mountKnowledgeActionsIsland(host, {
      actions,
      onAction: (action) => clicked.push(action),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-actions");
    expect(host.className).toContain("desktop-knowledge-actions");
    const upload = host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-action="uploadDocument"]');
    const query = host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-action="runQuery"]');
    const deleteDocument = host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-action="deleteDocument"]');
    expect(upload?.textContent).toContain("Upload document");
    expect(query?.textContent).toContain("Run query");
    expect(deleteDocument?.hasAttribute("disabled")).toBe(true);

    upload?.click();
    deleteDocument?.click();
    query?.click();

    expect(clicked).toEqual(["uploadDocument", "runQuery"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
