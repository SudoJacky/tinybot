// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountTaskActionIsland } from "./taskActionIsland";

describe("task action Vue island", () => {
  test("renders open action as a workbench link", () => {
    const host = document.createElement("a");

    const mounted = mountTaskActionIsland(host, {
      action: "open",
      href: "/workspace",
      itemId: "file:workspace:AGENTS.md:save",
      itemSource: "file",
      label: "Open",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("task-action");
    expect(host.className).toBe("desktop-task-action");
    expect(host.getAttribute("href")).toBe("/workspace");
    expect(host.getAttribute("data-desktop-task-action")).toBe("open");
    expect(host.getAttribute("data-desktop-task-id")).toBe("file:workspace:AGENTS.md:save");
    expect(host.getAttribute("data-desktop-task-source")).toBe("file");
    expect(host.textContent).toBe("Open");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders command action as a button and invokes callback", () => {
    const host = document.createElement("button");
    const actions: string[] = [];

    mountTaskActionIsland(host, {
      action: "retry",
      itemId: "file:workspace:AGENTS.md:save",
      itemSource: "file",
      label: "Retry",
      onAction: (action) => actions.push(action),
    });

    expect(host.getAttribute("type")).toBe("button");
    expect(host.className).toBe("desktop-task-action");
    expect(host.getAttribute("data-desktop-task-action")).toBe("retry");
    expect(host.textContent).toBe("Retry");

    host.click();
    expect(actions).toEqual(["retry"]);
  });
});
