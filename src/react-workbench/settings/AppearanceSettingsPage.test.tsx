// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});

function renderAppearancePage() {
  return render(
    <AppAppearanceProvider>
      <AppearanceSettingsPage />
    </AppAppearanceProvider>,
  );
}
