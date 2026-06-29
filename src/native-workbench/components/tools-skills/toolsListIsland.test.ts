// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopToolRow } from "../../tools-skills/desktopToolsSkills";
import { mountToolsListIsland } from "./toolsListIsland";

const tools: DesktopToolRow[] = [
  {
    name: "exec",
    displayName: "Command",
    description: "Run a command",
    enabled: false,
    configHint: "execDisabled",
    riskHint: "",
    schemaFields: [],
    schemaText: "",
    meta: "disabled / 1 parameters",
    raw: {},
  },
  {
    name: "read_file",
    displayName: "Read file",
    description: "Read files",
    enabled: true,
    configHint: "",
    riskHint: "",
    schemaFields: [],
    schemaText: "",
    meta: "no parameters",
    raw: {},
  },
];

describe("tools list Vue island", () => {
  test("renders tool rows with existing entity hooks and copy", () => {
    const host = document.createElement("section");

    const mounted = mountToolsListIsland(host, { tools });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("tools-list");
    expect(host.className).toContain("desktop-tools-list");
    expect(host.querySelector("h2")?.textContent).toBe("Tools");
    const exec = host.querySelector<HTMLElement>('[data-desktop-entity-id="exec"]');
    const readFile = host.querySelector<HTMLElement>('[data-desktop-entity-id="read_file"]');
    expect(exec?.getAttribute("data-desktop-entity-module")).toBe("tools");
    expect(exec?.textContent).toContain("Command: disabled / 1 parameters");
    expect(readFile?.getAttribute("data-desktop-entity-module")).toBe("tools");
    expect(readFile?.textContent).toContain("Read file: no parameters");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
