// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { AgentUiForm } from "../agentUiEvents";
import { mountAgentUiFormsSurfaceIsland } from "./agentUiFormsSurfaceIsland";

const form: AgentUiForm = {
  form_id: "approval-1",
  title: "Approve change",
  correlation: {},
  fields: [
    {
      label: "Target",
      name: "target",
      required: true,
      type: "text",
    },
  ],
  initial_values: {
    target: "README.md",
  },
  status: "pending",
};

describe("Agent UI forms surface Vue island", () => {
  test("renders empty forms surface", () => {
    const host = document.createElement("section");

    const mounted = mountAgentUiFormsSurfaceIsland(host, {
      forms: [],
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("agent-ui-forms-surface");
    expect(host.className).toBe("desktop-workbench-section desktop-agent-ui-forms");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("chat");
    expect(host.getAttribute("aria-label")).toBe("Agent UI forms");
    expect(host.querySelector("h2")?.textContent).toBe("Agent UI forms");
    expect(host.textContent).toContain("No pending Agent UI forms.");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders form cards and forwards actions", async () => {
    const host = document.createElement("section");
    const events: Array<Record<string, unknown>> = [];

    mountAgentUiFormsSurfaceIsland(host, {
      forms: [form],
      onCancel: (nextForm) => events.push({ action: "cancel", formId: nextForm.form_id }),
      onSubmit: (nextForm, values) => events.push({ action: "submit", formId: nextForm.form_id, values }),
    });
    await nextTick();
    await nextTick();

    expect(host.querySelector('[data-agent-ui-form-id="approval-1"]')?.getAttribute("data-desktop-vue-island")).toBe("agent-ui-form-card");
    expect(host.querySelector('[data-agent-ui-form-id="approval-1"] h2')?.textContent).toBe("Approve change");
    const target = host.querySelector<HTMLInputElement>('[data-agent-ui-form-field="target"]');
    if (target) target.value = "src/main.ts";

    host.querySelector<HTMLButtonElement>('[data-agent-ui-form-action="submit"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-agent-ui-form-action="cancel"]')?.click();

    expect(events).toEqual([
      { action: "submit", formId: "approval-1", values: { target: "src/main.ts" } },
      { action: "cancel", formId: "approval-1" },
    ]);
  });
});
