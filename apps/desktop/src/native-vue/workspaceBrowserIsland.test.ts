// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountWorkspaceBrowserIsland } from "./workspaceBrowserIsland";

describe("workspace browser Vue island", () => {
  test("renders workspace browser search and recent-files host", () => {
    const host = document.createElement("aside");

    const mounted = mountWorkspaceBrowserIsland(host);

    expect(host.getAttribute("data-desktop-vue-island")).toBe("workspace-browser");
    expect(host.className).toContain("desktop-workspace-browser");
    expect(host.textContent).toContain("Files");

    const search = host.querySelector<HTMLInputElement>("#desktop-workspace-search");
    expect(search?.className).toContain("desktop-workspace-search");
    expect(search?.type).toBe("search");
    expect(search?.getAttribute("placeholder")).toBe("Search workspace files...");
    expect(search?.getAttribute("aria-label")).toBe("Search workspace files");

    const recent = host.querySelector<HTMLElement>("#desktop-workspace-recent-files");
    expect(recent?.className).toContain("desktop-workspace-recent-files");
    expect(recent?.getAttribute("aria-label")).toBe("Recent workspace files");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
