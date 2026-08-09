// @vitest-environment happy-dom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { APP_LANGUAGE_STORAGE_KEY } from "../../app-core/settings/appLanguage";
import { AppLanguageProvider } from "./AppLanguageContext";
import { AppSettingsPage } from "./AppSettingsPage";

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
});

afterEach(() => cleanup());

describe("AppSettingsPage", () => {
  test("changes the interface language immediately and persists it on this device", async () => {
    const user = userEvent.setup();
    render(
      <AppLanguageProvider>
        <AppSettingsPage />
      </AppLanguageProvider>,
    );

    expect(screen.getAllByText("Language")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Language" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Language: English" }));
    await user.click(within(screen.getByRole("menu", { name: "Language options" }))
      .getByRole("menuitemradio", { name: /Simplified Chinese/ }));

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
    expect(screen.getByRole("button", { name: "语言: 简体中文" })).toBeTruthy();
  });
});
