// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountFileImportCardIsland } from "./fileImportCardIsland";

describe("file import card Vue island", () => {
  test("renders upload button card with drop-target and format chips", () => {
    const host = document.createElement("div");

    const mounted = mountFileImportCardIsland(host, {
      id: "desktop-knowledge-upload",
      label: "Knowledge upload",
      uploadKind: "knowledge-document",
      dropTarget: "knowledge-document",
      formatsId: "desktop-file-knowledge-formats",
      formats: ["pdf", "md"],
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("file-import-card");
    expect(host.className).toContain("desktop-file-import-card");

    const control = host.querySelector<HTMLButtonElement>("#desktop-knowledge-upload");
    expect(control?.tagName).toBe("BUTTON");
    expect(control?.className).toContain("desktop-file-import-button");
    expect(control?.getAttribute("data-desktop-file-upload")).toBe("knowledge-document");
    expect(control?.getAttribute("data-desktop-drop-target")).toBe("knowledge-document");
    expect(control?.textContent).toContain("Knowledge upload");
    expect(control?.textContent).toContain("Drop files here or click to select");
    expect(host.querySelector("#desktop-file-knowledge-formats")?.textContent).toContain("pdf");
    expect(host.querySelector("#desktop-file-knowledge-formats")?.textContent).toContain("md");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders workspace link card when href is provided", () => {
    const host = document.createElement("div");

    const mounted = mountFileImportCardIsland(host, {
      id: "desktop-workspace-file-drop",
      label: "Workspace import",
      href: "/workspace",
      dropTarget: "workspace-file",
      formatsId: "desktop-file-workspace-formats",
      formats: ["toml", "yaml"],
    });

    const control = host.querySelector<HTMLAnchorElement>("#desktop-workspace-file-drop");
    expect(control?.tagName).toBe("A");
    expect(control?.getAttribute("href")).toBe("/workspace");
    expect(control?.getAttribute("data-desktop-drop-target")).toBe("workspace-file");
    expect(control?.getAttribute("data-desktop-file-upload")).toBeNull();
    expect(host.querySelector("#desktop-file-workspace-formats")?.textContent).toContain("toml");

    mounted.unmount();
  });
});
