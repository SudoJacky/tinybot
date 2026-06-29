// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountAgentUiFormActionsIsland } from "./agentUiFormActionsIsland";

describe("Agent UI form actions Vue island", () => {
  test("renders submit and cancel actions", () => {
    const host = document.createElement("div");
    const events: string[] = [];

    const mounted = mountAgentUiFormActionsIsland(host, {
      cancelLabel: "Dismiss",
      onCancel: () => events.push("cancel"),
      onSubmit: () => events.push("submit"),
      submitLabel: "Approve",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("agent-ui-form-actions");
    expect(host.className).toBe("desktop-agent-ui-form-actions");
    expect(Array.from(host.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Approve", "Dismiss"]);

    host.querySelector<HTMLButtonElement>('[data-agent-ui-form-action="submit"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-agent-ui-form-action="cancel"]')?.click();

    expect(events).toEqual(["submit", "cancel"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("uses default labels", () => {
    const host = document.createElement("div");

    mountAgentUiFormActionsIsland(host, {});

    expect(Array.from(host.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Submit", "Cancel"]);
  });
});
