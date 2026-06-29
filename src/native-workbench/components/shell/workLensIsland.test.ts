// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopWorkLensProjection } from "../../shell/desktopWorkLens";
import { mountWorkLensIsland } from "./workLensIsland";

const readyLens: DesktopWorkLensProjection = {
  mode: "ready",
  kind: "knowledgeJob",
  id: "knowledge:doc-1:index",
  title: "Index Desktop UX Notes",
  state: "failed",
  stateReason: "Embedding provider returned 429",
  canonicalRoute: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
  fallbackReason: "",
  relatedResources: [
    {
      kind: "evidence",
      id: "evidence:doc-1",
      title: "Desktop UX evidence",
      detail: "source trace",
      route: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
    },
    {
      kind: "diagnostic",
      id: "diagnostic:429",
      title: "Provider error",
      detail: "HTTP 429",
      route: { module: "knowledge", entityId: "doc-1" },
    },
  ],
  outputs: [
    {
      kind: "log",
      id: "output:failure",
      title: "Failure diagnostics",
      detail: "HTTP 429",
      route: { module: "knowledge", entityId: "doc-1", href: "/knowledge/logs" },
    },
  ],
  nextActions: [
    { id: "retry", label: "Retry" },
    { id: "open", label: "Open", route: { module: "knowledge", entityId: "doc-1", href: "/knowledge" } },
    { id: "copyDiagnostics", label: "Copy diagnostics", diagnosticText: "HTTP 429" },
  ],
  sections: [
    {
      id: "happening",
      title: "What is happening?",
      rows: [
        { label: "Status", value: "failed" },
        { label: "Reason", value: "Embedding provider returned 429" },
      ],
    },
    {
      id: "next",
      title: "What can I do next?",
      rows: [{ label: "Retry", value: "" }],
    },
  ],
};

describe("work lens Vue island", () => {
  test("renders ready Work Lens sections, resources, links, and actions", () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const copied: string[] = [];

    const mounted = mountWorkLensIsland(host, {
      workLens: readyLens,
      placement: "inspector",
      onAction: (event) => actions.push(event.action),
      copyText: (text) => {
        copied.push(text);
      },
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("work-lens");
    expect(host.className).toContain("desktop-work-lens");
    expect(host.getAttribute("aria-label")).toBe("Work Lens");
    expect(host.getAttribute("data-desktop-work-lens-mode")).toBe("ready");
    expect(host.getAttribute("data-desktop-work-lens-kind")).toBe("knowledgeJob");
    expect(host.getAttribute("data-desktop-work-lens-id")).toBe("knowledge:doc-1:index");
    expect(host.getAttribute("data-desktop-work-lens-placement")).toBe("inspector");
    expect(host.textContent).toContain("Index Desktop UX Notes");
    expect(host.textContent).toContain("Embedding provider returned 429");

    expect(host.querySelector('[data-desktop-work-lens-section="happening"]')?.getAttribute("aria-label")).toBe("Work Lens section: happening");
    expect(host.querySelector('[data-desktop-work-lens-resource="evidence:doc-1"]')?.getAttribute("href")).toBe("/knowledge");
    expect(host.querySelector('[data-desktop-work-lens-resource="evidence:doc-1"]')?.getAttribute("aria-label")).toBe("Work Lens resource: evidence Desktop UX evidence");
    expect(host.querySelector('[data-desktop-work-lens-resource="diagnostic:429"]')?.textContent).toContain("Provider error: HTTP 429");
    expect(Array.from(host.querySelectorAll("[data-desktop-work-lens-action]")).map((node) => node.getAttribute("data-desktop-work-lens-action"))).toEqual([
      "retry",
      "open",
      "copyDiagnostics",
    ]);
    expect(host.querySelector('[data-desktop-work-lens-action="open"]')?.getAttribute("href")).toBe("/knowledge");

    host.querySelector<HTMLButtonElement>('[data-desktop-work-lens-action="retry"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-work-lens-action="copyDiagnostics"]')?.click();

    expect(actions).toEqual(["retry", "copyDiagnostics"]);
    expect(copied).toEqual(["HTTP 429"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders fallback Work Lens metadata and accessible fallback reason", () => {
    const host = document.createElement("section");

    const mounted = mountWorkLensIsland(host, {
      placement: "inline",
      workLens: {
        ...readyLens,
        mode: "fallback",
        kind: "unsupported",
        id: "",
        state: "unsupported",
        fallbackReason: "unsupported-source",
        sections: [],
        relatedResources: [],
        outputs: [],
        nextActions: [],
      },
    });

    expect(host.getAttribute("data-desktop-work-lens-mode")).toBe("fallback");
    expect(host.getAttribute("data-desktop-work-lens-kind")).toBe("unsupported");
    expect(host.getAttribute("data-desktop-work-lens-placement")).toBe("inline");
    expect(host.getAttribute("data-desktop-work-lens-fallback-reason")).toBe("unsupported-source");
    expect(host.querySelector('[data-desktop-work-lens-fallback="unsupported-source"]')?.getAttribute("aria-label")).toBe("Work Lens fallback: unsupported-source");

    mounted.unmount();
  });
});
