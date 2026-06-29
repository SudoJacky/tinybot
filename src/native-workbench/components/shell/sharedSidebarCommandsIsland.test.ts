// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSharedSidebarCommandsIsland } from "./sharedSidebarCommandsIsland";

describe("shared sidebar commands Vue island", () => {
  test("renders command group with item attributes", () => {
    const host = document.createElement("section");

    const mounted = mountSharedSidebarCommandsIsland(host, {
      label: "System",
      items: [
        {
          commandId: "desktop.settings.open",
          icon: "settings",
          id: "settings",
          kind: "command",
          label: "Settings",
        },
      ],
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("shared-sidebar-commands");
    expect(host.className).toBe("desktop-workbench-section");
    expect(host.querySelector("h2")?.textContent).toBe("System");

    const button = host.querySelector<HTMLButtonElement>(".desktop-workbench-link");
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.textContent).toBe("Settings");
    expect(button?.getAttribute("data-sidebar-item-id")).toBe("settings");
    expect(button?.getAttribute("data-sidebar-item-kind")).toBe("command");
    expect(button?.getAttribute("data-sidebar-command")).toBe("desktop.settings.open");
    expect(button?.getAttribute("data-sidebar-icon")).toBe("settings");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("dispatches desktop menu command events from the target document", () => {
    const host = document.createElement("section");
    document.body.append(host);
    const commands: unknown[] = [];
    document.addEventListener("desktop-menu-command", (event) => {
      commands.push((event as CustomEvent).detail);
    });

    mountSharedSidebarCommandsIsland(host, {
      items: [
        {
          commandId: "desktop.help.open",
          id: "help",
          kind: "command",
          label: "Help",
        },
      ],
    });

    expect(host.querySelector("h2")?.textContent).toBe("System");
    host.querySelector<HTMLButtonElement>(".desktop-workbench-link")?.click();
    expect(commands).toEqual([{ id: "desktop.help.open", source: "native-sidebar" }]);
  });
});
