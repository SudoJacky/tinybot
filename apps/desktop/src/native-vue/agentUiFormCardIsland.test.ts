// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { AgentUiForm } from "../agentUiEvents";
import { mountAgentUiFormCardIsland } from "./agentUiFormCardIsland";

const form: AgentUiForm = {
  form_id: "approval-1",
  title: "Approve change",
  description: "Review the pending edit.",
  correlation: {},
  fields: [
    {
      label: "Target",
      name: "target",
      required: true,
      type: "text",
      help: "File path",
    },
    {
      label: "Force",
      name: "force",
      required: false,
      type: "checkbox",
    },
    {
      label: "Count",
      name: "count",
      required: false,
      type: "number",
    },
  ],
  initial_values: {
    count: 2,
    force: true,
    target: "README.md",
  },
  errors: {
    form: "Check the values",
    target: "Target is required",
  },
  submit_label: "Approve",
  cancel_label: "Dismiss",
  status: "pending",
};

describe("Agent UI form card Vue island", () => {
  test("renders form card and forwards submitted values", () => {
    const host = document.createElement("article");
    const events: Array<Record<string, unknown>> = [];

    const mounted = mountAgentUiFormCardIsland(host, {
      form,
      onCancel: (nextForm) => events.push({ action: "cancel", formId: nextForm.form_id }),
      onSubmit: (nextForm, values) => events.push({ action: "submit", formId: nextForm.form_id, values }),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("agent-ui-form-card");
    expect(host.className).toBe("desktop-agent-ui-form-card");
    expect(host.getAttribute("data-agent-ui-form-id")).toBe("approval-1");
    expect(host.getAttribute("data-agent-ui-form-status")).toBe("pending");
    expect(host.querySelector("h2")?.textContent).toBe("Approve change");
    expect(host.querySelector(".desktop-agent-ui-form-status")?.textContent).toBe("pending");
    expect(host.textContent).toContain("Review the pending edit.");
    expect(host.textContent).toContain("Check the values");

    const target = host.querySelector<HTMLInputElement>('[data-agent-ui-form-field="target"]');
    const force = host.querySelector<HTMLInputElement>('[data-agent-ui-form-field="force"]');
    const count = host.querySelector<HTMLInputElement>('[data-agent-ui-form-field="count"]');
    if (target) target.value = "src/main.ts";
    if (force) force.checked = false;
    if (count) count.value = "3";

    host.querySelector<HTMLButtonElement>('[data-agent-ui-form-action="submit"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-agent-ui-form-action="cancel"]')?.click();

    expect(events).toEqual([
      { action: "submit", formId: "approval-1", values: { target: "src/main.ts", force: false, count: 3 } },
      { action: "cancel", formId: "approval-1" },
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("omits actions when form is not submittable", () => {
    const host = document.createElement("article");

    mountAgentUiFormCardIsland(host, {
      form: { ...form, status: "submitted" },
    });

    expect(host.querySelector('[data-agent-ui-form-action="submit"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-agent-ui-form-field="target"]')?.disabled).toBe(true);
  });
});
