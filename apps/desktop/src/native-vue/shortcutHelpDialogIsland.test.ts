// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountShortcutHelpDialogIsland } from "./shortcutHelpDialogIsland";

describe("shortcut help dialog Vue island", () => {
  test("renders grouped shortcuts, filters rows, and hides on close", async () => {
    const host = document.createElement("section");
    document.body.append(host);

    const mounted = mountShortcutHelpDialogIsland(host, {
      groups: [
        {
          title: "Chat",
          items: [
            { command: "New chat", description: "Start a new session", key: "Ctrl+N" },
            { command: "Stop generation", description: "Stop the active run", key: "Esc" },
          ],
        },
        {
          title: "Navigation",
          items: [
            { command: "Command palette", description: "Search commands", key: "Ctrl+Shift+P" },
          ],
        },
      ],
    });

    expect(host.id).toBe("desktop-shortcut-help-dialog");
    expect(host.className).toBe("desktop-shortcut-help-dialog");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("shortcut-help-dialog");
    expect(host.getAttribute("role")).toBe("dialog");
    expect(host.getAttribute("aria-modal")).toBe("true");
    expect(host.textContent).toContain("Keyboard shortcuts");
    expect(host.textContent).toContain("Chat");
    expect(host.textContent).toContain("Ctrl+Shift+P");

    const search = host.querySelector<HTMLInputElement>(".desktop-shortcut-help-search");
    expect(document.activeElement).toBe(search);
    search!.value = "palette";
    search?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(host.textContent).toContain("Command palette");
    expect(host.textContent).not.toContain("Stop generation");

    host.querySelector<HTMLButtonElement>(".desktop-shortcut-help-close")?.click();
    expect(host.hidden).toBe(true);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
