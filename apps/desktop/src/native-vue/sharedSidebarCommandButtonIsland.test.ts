// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSharedSidebarCommandButtonIsland } from "./sharedSidebarCommandButtonIsland";

describe("shared sidebar command button Vue island", () => {
  test("renders shared sidebar command button attributes", () => {
    const host = document.createElement("button");

    const mounted = mountSharedSidebarCommandButtonIsland(host, {
      commandId: "desktop.settings.open",
      icon: "settings",
      id: "settings",
      kind: "command",
      label: "Settings",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("shared-sidebar-command-button");
    expect(host.className).toBe("desktop-workbench-link");
    expect(host.getAttribute("type")).toBe("button");
    expect(host.getAttribute("data-sidebar-item-id")).toBe("settings");
    expect(host.getAttribute("data-sidebar-item-kind")).toBe("command");
    expect(host.getAttribute("data-sidebar-command")).toBe("desktop.settings.open");
    expect(host.getAttribute("data-sidebar-icon")).toBe("settings");
    expect(host.textContent).toBe("Settings");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("dispatches desktop menu command from the provided document", () => {
    const host = document.createElement("button");
    document.body.append(host);
    const commands: unknown[] = [];
    document.addEventListener("desktop-menu-command", (event) => {
      commands.push((event as CustomEvent).detail);
    });

    mountSharedSidebarCommandButtonIsland(host, {
      commandId: "desktop.help.open",
      id: "help",
      kind: "command",
      label: "Help",
      targetDocument: document,
    });

    host.click();
    expect(commands).toEqual([{ id: "desktop.help.open", source: "native-sidebar" }]);
  });
});
