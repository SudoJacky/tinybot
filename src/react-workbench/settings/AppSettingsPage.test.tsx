// @vitest-environment happy-dom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { APP_LANGUAGE_STORAGE_KEY } from "../../app-core/settings/appLanguage";
import { AppLanguageProvider } from "./AppLanguageContext";
import { AppSettingsPage } from "./AppSettingsPage";
import { COMPOSER_RICH_TEXT_STORAGE_KEY } from "../../app-core/settings/composerPreferences";

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
});

afterEach(() => cleanup());

describe("AppSettingsPage", () => {
  test("defaults rich text on and persists an explicit off preference", async () => {
    const user = userEvent.setup();
    const view = render(<AppLanguageProvider><AppSettingsPage /></AppLanguageProvider>);
    expect((screen.getByRole("checkbox", { name: "Enable rich text in composer" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Enable rich text in composer" }));
    expect(window.localStorage.getItem(COMPOSER_RICH_TEXT_STORAGE_KEY)).toBe("false");
    view.unmount();
    render(<AppLanguageProvider><AppSettingsPage /></AppLanguageProvider>);
    expect((screen.getByRole("checkbox", { name: "Enable rich text in composer" }) as HTMLInputElement).checked).toBe(false);
  });
  test("changes the interface language immediately and persists it on this device", async () => {
    const user = userEvent.setup();
    render(
      <AppLanguageProvider>
        <AppSettingsPage />
      </AppLanguageProvider>,
    );

    expect(screen.getAllByText("Language")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Language" })).toBeNull();
    const languageOptions = within(screen.getByRole("radiogroup", { name: "Language" }));
    expect(languageOptions.getByRole("radio", { name: "English" })).toBeTruthy();
    await user.click(languageOptions.getByRole("radio", { name: "简体中文" }));

    expect(await screen.findByRole("heading", { name: "应用偏好设置" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(window.localStorage.getItem(APP_LANGUAGE_STORAGE_KEY)).toBe("zh");
    expect(screen.getByText("更改会立即生效，并仅保存在这台设备上。")).toBeTruthy();
  });

  test("restores a persisted Chinese preference on mount", () => {
    window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, "zh");

    render(
      <AppLanguageProvider>
        <AppSettingsPage />
      </AppLanguageProvider>,
    );

    expect(screen.getByRole("heading", { name: "应用偏好设置" })).toBeTruthy();
    const languageOptions = within(screen.getByRole("radiogroup", { name: "语言" }));
    expect(languageOptions.getByRole<HTMLInputElement>("radio", { name: "简体中文" }).checked).toBe(true);
  });
});
