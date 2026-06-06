// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountKnowledgeReferenceRowIsland } from "./knowledgeReferenceRowIsland";

describe("knowledge reference row Vue island", () => {
  test("renders label title and excerpt", () => {
    const host = document.createElement("p");

    const mounted = mountKnowledgeReferenceRowIsland(host, {
      label: "Source",
      text: "Use UV for Python",
      title: "AGENTS.md",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-reference-row");
    expect(host.textContent).toBe("Source: AGENTS.md - Use UV for Python");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("omits separator when excerpt is empty", () => {
    const host = document.createElement("p");

    mountKnowledgeReferenceRowIsland(host, {
      label: "Source",
      text: "",
      title: "README.md",
    });

    expect(host.textContent).toBe("Source: README.md");
  });
});
