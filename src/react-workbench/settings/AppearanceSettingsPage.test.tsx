// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { APPEARANCE_STORAGE_KEY } from "../../app-core/settings/appAppearance";
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
});

function renderAppearancePage() {
  return render(
    <AppAppearanceProvider>
      <AppearanceSettingsPage />
    </AppAppearanceProvider>,
  );
}
