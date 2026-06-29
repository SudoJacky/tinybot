// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopToolDetailView } from "../../tools-skills/desktopToolsSkills";
import { mountToolDetailIsland } from "./toolDetailIsland";

const tool: DesktopToolDetailView = {
  name: "exec",
  displayName: "Command",
  title: "Command",
  description: "Run a command",
  enabled: false,
  configHint: "execDisabled",
  riskHint: "",
  schemaFields: [
    {
      name: "command",
      type: "string",
      required: true,
      description: "Command to run",
      defaultValue: "",
      enumValues: [],
    },
  ],
  schemaText: "",
  meta: "disabled / 1 parameters",
  emptySchemaText: "No parameters.",
  raw: {},
};

describe("tool detail Vue island", () => {
  test("renders selected tool detail with existing desktop copy", () => {
    const host = document.createElement("section");

    const mounted = mountToolDetailIsland(host, { tool });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("tool-detail");
    expect(host.className).toContain("desktop-tool-detail");
    expect(host.querySelector("h2")?.textContent).toBe("Tool detail: Command");
    expect(host.textContent).toContain("Run a command");
    expect(host.textContent).toContain("Config: execDisabled");
    expect(host.textContent).toContain("command: string required - Command to run");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders the existing empty schema field copy", () => {
    const host = document.createElement("section");

    const mounted = mountToolDetailIsland(host, {
      tool: {
        ...tool,
        configHint: "",
        schemaFields: [],
      },
    });

    expect(host.textContent).toContain("Config: ready");
    expect(host.textContent).toContain("parameters: none - No parameters.");

    mounted.unmount();
  });
});
