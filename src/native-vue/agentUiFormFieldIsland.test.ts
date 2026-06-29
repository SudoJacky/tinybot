// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountAgentUiFormFieldIsland } from "./agentUiFormFieldIsland";

describe("Agent UI form field Vue island", () => {
  test("renders text field with help and error", () => {
    const host = document.createElement("label");

    const mounted = mountAgentUiFormFieldIsland(host, {
      disabled: false,
      error: "Target is required",
      field: {
        label: "Target",
        name: "target",
        required: true,
        type: "text",
        help: "Enter a file path",
      },
      value: "README.md",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("agent-ui-form-field");
    expect(host.className).toBe("desktop-agent-ui-form-field");
    expect(host.querySelector("span")?.textContent).toBe("Target");
    expect(host.querySelector<HTMLInputElement>('[data-agent-ui-form-field="target"]')?.value).toBe("README.md");
    expect(Array.from(host.querySelectorAll("span")).map((span) => span.textContent)).toEqual([
      "Target",
      "Enter a file path",
      "Target is required",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders checkbox and select controls", () => {
    const checkboxHost = document.createElement("label");
    mountAgentUiFormFieldIsland(checkboxHost, {
      disabled: true,
      field: {
        label: "Force",
        name: "force",
        required: false,
        type: "checkbox",
      },
      value: true,
    });

    const checkbox = checkboxHost.querySelector<HTMLInputElement>('[data-agent-ui-form-field="force"]');
    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.disabled).toBe(true);

    const selectHost = document.createElement("label");
    mountAgentUiFormFieldIsland(selectHost, {
      disabled: false,
      field: {
        label: "Mode",
        name: "mode",
        options: [
          { label: "Fast", value: "fast" },
          { label: "Careful", value: "careful" },
        ],
        required: true,
        type: "select",
      },
      value: "careful",
    });

    const select = selectHost.querySelector<HTMLSelectElement>('[data-agent-ui-form-field="mode"]');
    expect(select?.value).toBe("careful");
    expect(Array.from(select?.querySelectorAll("option") ?? []).map((option) => option.textContent)).toEqual(["Fast", "Careful"]);
  });
});
