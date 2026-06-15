// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import {
  buildDesktopSettingsFormState,
  buildDesktopSettingsPaneModel,
} from "../desktopSettingsProviders";
import { buildDesktopKnowledgePaneModel } from "../desktopKnowledgeTraceability";
import type { AgentUiForm } from "../agentUiEvents";
import type { DesktopSettingsActionEvent } from "../desktopWorkbenchShell";
import { mountMainUtilitiesRegionIsland } from "./mainUtilitiesRegionIsland";

const providerCatalog = [{ id: "openai", displayName: "OpenAI", status: "ready" }];

const settingsPane = buildDesktopSettingsPaneModel(
  buildDesktopSettingsFormState({
    agents: {
      defaults: {
        active_profile: "work",
        model: "gpt-4.1-mini",
        provider: "openai",
        timezone: "Asia/Shanghai",
      },
    },
    providers: {
      profiles: {
        work: {
          api_base: "https://api.openai.com/v1",
          api_key: "sk-live",
          models: ["gpt-4.1-mini"],
          provider: "openai",
        },
      },
    },
  }, providerCatalog),
  { providerCatalog, saveStatus: "idle" },
);

const approvalForm: AgentUiForm = {
  form_id: "form-1",
  title: "Approve import",
  description: "Confirm the workspace import.",
  correlation: {},
  status: "pending",
  fields: [{
    name: "reason",
    label: "Reason",
    type: "text",
    required: true,
  }],
};

describe("main utilities region Vue island", () => {
  test("composes utility surfaces and forwards child actions", async () => {
    const host = document.createElement("div");
    const helpActions: string[] = [];
    const formActions: string[] = [];
    const settingsActions: string[] = [];

    const mounted = mountMainUtilitiesRegionIsland(host, {
      activeSessionKey: "session-1",
      agentUiForms: [approvalForm],
      settingsPane,
      onAgentUiCancel: (form) => formActions.push(`cancel:${form.form_id}`),
      onAgentUiSubmit: (form, values) => formActions.push(`submit:${form.form_id}:${String(values.reason)}`),
      onHelpAction: (action) => helpActions.push(action),
      onSettingsAction: (event: DesktopSettingsActionEvent) => settingsActions.push(event.action),
    });
    await nextTick();
    await nextTick();

    expect(host.className).toBe("desktop-utility-surfaces");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("main-utilities-region");
    expect(host.querySelector(".n-space.desktop-main-utilities-region")).not.toBeNull();
    expect(host.querySelector("#desktop-command-palette")?.getAttribute("role")).toBe("dialog");
    expect(host.querySelector(".desktop-file-actions")?.textContent).toContain("Attach to session");
    expect(host.querySelector<HTMLInputElement>("#desktop-session-upload-key")?.value).toBe("session-1");
    expect(host.querySelector(".desktop-help-pane")?.textContent).toContain("Help tour");
    expect(host.querySelector(".desktop-agent-ui-forms")?.textContent).toContain("Approve import");
    expect(host.querySelector(".desktop-workspace-files")?.textContent).toContain("Workspace files");
    expect(host.querySelector(".desktop-settings-pane")?.textContent).toContain("Settings / Capability Center");
    expect(host.querySelector(".desktop-settings-capability-map")?.getAttribute("data-desktop-settings-center")).toBe("capability-boundaries");

    host.querySelector<HTMLButtonElement>('[data-desktop-help-action="page-help"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-agent-ui-form-action="cancel"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="discoverModels"]')?.click();

    expect(helpActions).toEqual(["page-help"]);
    expect(formActions).toEqual(["cancel:form-1"]);
    expect(settingsActions).toEqual(["discoverModels"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("omits the generic file imports surface when the Knowledge pane is active", async () => {
    const host = document.createElement("div");
    const mounted = mountMainUtilitiesRegionIsland(host, {
      activeSessionKey: "session-1",
      agentUiForms: [],
      knowledgePane: buildDesktopKnowledgePaneModel(),
    });
    await nextTick();
    await nextTick();

    expect(host.querySelector(".desktop-file-actions")).toBeNull();
    expect(host.textContent).not.toContain("File imports");
    expect(host.querySelector(".desktop-knowledge-pane")).not.toBeNull();
    expect(host.querySelector("#desktop-knowledge-upload")?.getAttribute("data-desktop-file-upload")).toBe("knowledge-document");

    mounted.unmount();
  });
});
