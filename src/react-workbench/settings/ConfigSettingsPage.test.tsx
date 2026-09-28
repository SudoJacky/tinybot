// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildDesktopConfigSettingsValues } from "../../app-core/settings/desktopConfigSettings";
import type { SettingsStore } from "../services";
import { settingsStoreFixture } from "../test/settingsStoreFixture";
import { ConfigSettingsPage } from "./ConfigSettingsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createStore(currentConfig: unknown) {
  return {
    ...settingsStoreFixture(),
    loadDesktopConfigSettings: vi.fn(async () => ({
      currentConfig,
      values: buildDesktopConfigSettingsValues(currentConfig),
    })),
  };
}

describe("ConfigSettingsPage", () => {
  test("uses the shared settings choice menu for fixed options", async () => {
    const user = userEvent.setup();
    const currentConfig = { tools: { web: { search: { provider: "duckduckgo" } } } };
    const values = buildDesktopConfigSettingsValues(currentConfig);
    const settingsStore: SettingsStore = {
      ...settingsStoreFixture(),
      loadDesktopConfigSettings: vi.fn(async () => ({
        currentConfig,
        values,
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

  test("restoring a changed value clears dirty state without saving", async () => {
    const user = userEvent.setup();
    const store = createStore({});
    render(<ConfigSettingsPage groupId="tools-mcp" settingsStore={store} />);
    const webTools = await screen.findByRole("checkbox", { name: "Web tools" });
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" });

    expect(save.disabled).toBe(true);
    await user.click(webTools);
    expect(save.disabled).toBe(false);
    await user.click(webTools);
    expect(save.disabled).toBe(true);
    expect(store.saveDesktopConfigSettings).not.toHaveBeenCalled();
  });

  test("shows save failures, retains the edit for retry, and allows reset", async () => {
    const user = userEvent.setup();
    const store = createStore({ channels: { sendProgress: false } });
    store.saveDesktopConfigSettings.mockRejectedValue(new Error("Config revision changed"));
    render(<ConfigSettingsPage groupId="channels" settingsStore={store} />);
    const progress = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Progress events" });

    await user.click(progress);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Config revision changed");
    expect(progress.checked).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }).disabled).toBe(false);

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(progress.checked).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }).disabled).toBe(true);
  });

  test.each([
    { restartRequired: ["restart"], reloadRequired: [], message: "Saved. Restart Tinybot to apply this change." },
    { restartRequired: [], reloadRequired: ["workspaceReloadRequired"], message: "Saved. Reload the active workspace to apply this change." },
  ])("saves only edited fields and reports $message", async ({ restartRequired, reloadRequired, message }) => {
    const user = userEvent.setup();
    const currentConfig = { revision: "revision-1", tools: { web: { enable: true } } };
    const savedConfig = { revision: "revision-2", tools: { web: { enable: false } } };
    const save = vi.fn(async () => ({
      currentConfig: savedConfig,
      values: buildDesktopConfigSettingsValues(savedConfig),
      saveDetails: { transport: "native" as const, updatedFields: ["tools.web.enable"], applied: [], warnings: [], restartRequired, reloadRequired },
    }));
    const store = { ...createStore(currentConfig), saveDesktopConfigSettings: save };
    render(<ConfigSettingsPage groupId="tools-mcp" settingsStore={store} />);

    await user.click(await screen.findByRole("checkbox", { name: "Web tools" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(message));
    expect(save).toHaveBeenCalledExactlyOnceWith(currentConfig, { tools: { web: { enable: false } } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }).disabled).toBe(true);
  });

  test("blocks malformed MCP JSON and clears the field error when edited", async () => {
    const user = userEvent.setup();
    const store = createStore({});
    render(<ConfigSettingsPage groupId="tools-mcp" settingsStore={store} />);
    await user.click(await screen.findByRole("button", { name: "Show advanced settings" }));
    const mcp = screen.getByRole("textbox", { name: "MCP servers" });
    fireEvent.change(mcp, { target: { value: "{broken" } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(screen.getByRole("alert").textContent).toContain("MCP servers must contain valid JSON");
    expect(mcp.getAttribute("aria-invalid")).toBe("true");
    expect(store.saveDesktopConfigSettings).not.toHaveBeenCalled();

    fireEvent.change(mcp, { target: { value: "{}" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mcp.getAttribute("aria-invalid")).toBe("false");
  });

  test("keeps confirmation before enabling execution or relaxing the workspace boundary", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const store = createStore({ tools: { exec: { enable: false }, restrictToWorkspace: true } });
    render(<ConfigSettingsPage groupId="tools-mcp" settingsStore={store} />);
    const exec = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Exec tools" });
    await user.click(exec);
    expect(exec.checked).toBe(false);

    await user.click(screen.getByRole("button", { name: "Show advanced settings" }));
    const restriction = screen.getByRole<HTMLInputElement>("checkbox", { name: "Restrict to workspace" });
    await user.click(restriction);
    expect(restriction.checked).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }).disabled).toBe(true);

    confirm.mockReturnValue(true);
    await user.click(exec);
    await user.click(restriction);
    expect(exec.checked).toBe(true);
    expect(restriction.checked).toBe(false);
    expect(store.saveDesktopConfigSettings).not.toHaveBeenCalled();
  });
});
