// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { APPEARANCE_STORAGE_KEY } from "../../app-core/settings/appAppearance";
import { DEFAULT_DESKTOP_PET_PREFERENCES } from "../../app-core/desktop-pet/desktopPetState";
import { AppAppearanceProvider } from "./AppAppearanceContext";
import { AppearanceSettingsPage } from "./AppearanceSettingsPage";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-mode");
  document.documentElement.removeAttribute("style");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

describe("AppearanceSettingsPage", () => {
  test("selects and persists a theme mode immediately", async () => {
    const user = userEvent.setup();
    renderAppearancePage();

    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}").mode).toBe("dark");
  });

  test("customizes the active theme tokens and applies them to the workbench", () => {
    renderAppearancePage();
    const accent = screen.getByLabelText("Dark theme accent color");

    fireEvent.change(accent, { target: { value: "#3366ff" } });

    const stored = JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}");
    expect(stored.dark.accent).toBe("#3366ff");

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.style.getPropertyValue("--color-primary")).toBe("#3366ff");
  });

  test("uses the shared settings choice menu for theme fonts", async () => {
    const user = userEvent.setup();
    renderAppearancePage();

    expect(screen.queryByRole("combobox")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Light theme UI font: Inter" });
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "UI font options" });
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: "Inter" })));
    await user.keyboard("{ArrowDown}{Enter}");

    expect(screen.getByRole("button", { name: "Light theme UI font: System" })).toBe(document.activeElement);
    expect(JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}").light.uiFont).toBe("system");
  });

  test("changes the desktop pet appearance through an accessible preview choice", async () => {
    const user = userEvent.setup();
    const onDesktopPetPreferencesChange = vi.fn();
    renderAppearancePage(onDesktopPetPreferencesChange);

    expect((screen.getByRole("radio", { name: "Dimensional" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("radio", { name: "Classic" }));

    expect(onDesktopPetPreferencesChange).toHaveBeenCalledWith({
      ...DEFAULT_DESKTOP_PET_PREFERENCES,
      appearance: "classic",
    });
  });

  test("manages desktop pet visibility, size, and position recovery", async () => {
    const user = userEvent.setup();
    const onDesktopPetPreferencesChange = vi.fn();
    const onResetDesktopPetPosition = vi.fn();
    renderAppearancePage(onDesktopPetPreferencesChange, onResetDesktopPetPosition);

    const visibility = screen.getByRole("checkbox", { name: "Show desktop pet" });
    expect((visibility as HTMLInputElement).checked).toBe(true);
    await user.click(visibility);
    expect(onDesktopPetPreferencesChange).toHaveBeenCalledWith({
      ...DEFAULT_DESKTOP_PET_PREFERENCES,
      visible: false,
    });

    await user.click(screen.getByRole("button", { name: "Pet size: Medium" }));
    await user.click(within(screen.getByRole("menu", { name: "Desktop pet size options" }))
      .getByRole("menuitemradio", { name: "Large" }));
    expect(onDesktopPetPreferencesChange).toHaveBeenCalledWith({
      ...DEFAULT_DESKTOP_PET_PREFERENCES,
      size: "large",
    });

    await user.click(screen.getByRole("button", { name: "Reset position" }));
    expect(onResetDesktopPetPosition).toHaveBeenCalledTimes(1);
  });
});

function renderAppearancePage(
  onDesktopPetPreferencesChange = vi.fn(),
  onResetDesktopPetPosition = vi.fn(),
) {
  return render(
    <AppAppearanceProvider>
      <AppearanceSettingsPage
        desktopPetPreferences={DEFAULT_DESKTOP_PET_PREFERENCES}
        onDesktopPetPreferencesChange={onDesktopPetPreferencesChange}
        onResetDesktopPetPosition={onResetDesktopPetPosition}
      />
    </AppAppearanceProvider>,
  );
}
