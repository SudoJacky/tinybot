// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SettingsChoiceList } from "./SettingsChoiceList";

afterEach(cleanup);

function renderChoice(shellSource: "pointer" | "keyboard") {
  const onChange = vi.fn();
  render(
    <div className="react-desktop-shell" data-menu-motion={shellSource}>
      <SettingsChoiceList
        label="Theme"
        onChange={onChange}
        options={[
          { label: "System", value: "system" },
          { label: "Light", value: "light" },
          { disabled: true, label: "Unavailable", value: "unavailable" },
          { label: "Dark", value: "dark" },
        ]}
        value="light"
      />
      <button type="button">Outside</button>
    </div>,
  );
  return { onChange, trigger: screen.getByRole("button", { name: "Theme: Light" }) };
}

describe("SettingsChoiceList", () => {
  test.each(["pointer", "keyboard"] as const)("uses its pointer opening under a %s shell", async (shellSource) => {
    const user = userEvent.setup();
    const { trigger } = renderChoice(shellSource);

    await user.click(trigger);

    const menu = screen.getByRole("menu");
    expect(menu.dataset.inputSource).toBe("pointer");
    expect(menu.classList.contains("react-top-menu__popover")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Light" })));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu").dataset.inputSource).toBe("keyboard");
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    expect(screen.getByRole("menu").dataset.inputSource).toBe("pointer");
  });

  test.each(["{Enter}", " ", "{ArrowDown}", "{ArrowUp}"])("opens immediately from %s and preserves keyboard selection", async (key) => {
    const user = userEvent.setup();
    const { trigger, onChange } = renderChoice("pointer");
    trigger.focus();

    await user.keyboard(key);

    expect(screen.getByRole("menu").dataset.inputSource).toBe("keyboard");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Light" })));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Dark" }));
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("dark");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("treats assistive activation as immediate and dismisses on outside pointerdown", () => {
    const { trigger } = renderChoice("pointer");
    fireEvent.click(trigger, { detail: 0 });
    expect(screen.getByRole("menu").dataset.inputSource).toBe("keyboard");

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("dismisses when Tab moves focus outside the choices", async () => {
    const user = userEvent.setup();
    const { trigger } = renderChoice("keyboard");
    await user.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Light" })));

    await user.keyboard("{End}{Tab}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Outside" }));
  });
});
