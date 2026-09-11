// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildDesktopSettingsFormState } from "../../app-core/settings/desktopSettingsProviders";
import { buildDesktopSettingsPaneModel } from "../../app-core/settings/desktopSettingsPaneModel";
import type { SettingsStore } from "../services";
import { LabsSettingsPage } from "./LabsSettingsPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function data(currentConfig: unknown) {
  const formState = buildDesktopSettingsFormState(currentConfig);
  return { currentConfig, formState, pane: buildDesktopSettingsPaneModel(formState) };
}

function store(currentConfig: unknown = {}): SettingsStore {
  return {
    load: vi.fn(async () => []),
    loadDesktopConfigSettings: vi.fn(async () => data(currentConfig)),
    saveDesktopConfigSettings: vi.fn(async (_config, patch) => ({
      ...data(patch), saveDetails: {
        transport: "native" as const, updatedFields: ["experiments.actionFusion"],
        applied: [], restartRequired: [], reloadRequired: [], warnings: [],
      },
    })),
  };
}

describe("LabsSettingsPage", () => {
  test("defaults off and saves against the loaded configuration before confirming the toggle", async () => {
    const user = userEvent.setup();
    const config = { tools: { exec: { enable: true } } };
    const settingsStore = store(config);
    render(<LabsSettingsPage settingsStore={settingsStore} />);
    const checkbox = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Action Fusion" });
    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(settingsStore.saveDesktopConfigSettings).toHaveBeenCalledWith(config, { experiments: { actionFusion: true } });
    await user.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(settingsStore.saveDesktopConfigSettings).toHaveBeenLastCalledWith({ experiments: { actionFusion: true } }, { experiments: { actionFusion: false } });
  });

  test("keeps the saved flag on a revision conflict and allows reloading", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const settingsStore = store({ experiments: { actionFusion: true } });
    settingsStore.saveDesktopConfigSettings = vi.fn(async () => { throw new Error("config revision conflict"); });
    render(<LabsSettingsPage settingsStore={settingsStore} />);
    const checkbox = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Action Fusion" });
    await user.click(checkbox);
    expect((await screen.findByRole("alert")).textContent).toContain("config revision conflict");
    expect(checkbox.checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "Reload settings" }));
    await waitFor(() => expect(settingsStore.loadDesktopConfigSettings).toHaveBeenCalledTimes(2));
  });

  test("reports malformed settings instead of silently showing disabled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<LabsSettingsPage settingsStore={store({ experiments: { actionFusion: "true" } })} />);
    expect((await screen.findByRole("alert")).textContent).toContain("must be a boolean");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
