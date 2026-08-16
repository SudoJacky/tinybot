// @vitest-environment happy-dom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildDesktopSettingsFormState } from "../../app-core/settings/desktopSettingsProviders";
import { buildDesktopSettingsPaneModel } from "../../app-core/settings/desktopSettingsPaneModel";
import type { SettingsStore } from "../services";
import { ConfigSettingsPage } from "./ConfigSettingsPage";

afterEach(() => cleanup());

describe("ConfigSettingsPage", () => {
  test("uses the shared settings choice menu for fixed options", async () => {
    const user = userEvent.setup();
    const currentConfig = { tools: { web: { search: { provider: "duckduckgo" } } } };
    const formState = buildDesktopSettingsFormState(currentConfig);
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadDesktopConfigSettings: vi.fn(async () => ({
        currentConfig,
        formState,
        pane: buildDesktopSettingsPaneModel(formState),
      })),
    };

    render(<ConfigSettingsPage groupId="tools-mcp" settingsStore={settingsStore} />);
    await user.click(await screen.findByRole("button", { name: "Show advanced settings" }));

    expect(screen.queryByRole("combobox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Search provider: Duckduckgo" }));
    await user.click(within(screen.getByRole("menu", { name: "Search provider options" }))
      .getByRole("menuitemradio", { name: "Brave" }));

    expect(screen.getByRole("button", { name: "Search provider: Brave" })).toBeTruthy();
  });
});
